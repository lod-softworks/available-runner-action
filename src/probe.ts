import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface ProbeOptions {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  labels: string[];
  timeoutSeconds: number;
  parentRunId: number;
}

export interface ProbeResult {
  available: boolean;
  diagnostics: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Dispatches a token-free helper job, then cancels any unclaimed probe. */
export async function probeRunner(octokit: Octokit, options: ProbeOptions): Promise<ProbeResult> {
  if (!/^[\w.-]+\.ya?ml$/.test(options.workflow)) {
    throw new Error('probe-workflow must be a workflow filename, such as available-runner-probe.yml.');
  }
  if (!options.ref) throw new Error('probe-ref must identify a branch or tag containing the helper workflow.');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 5 || options.timeoutSeconds > 300) {
    throw new Error('probe-timeout-seconds must be an integer between 5 and 300.');
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const probeId = randomUUID();
  let runId: number | undefined;
  let completed = false;
  let dispatched = false;
  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
      owner: options.owner,
      repo: options.repo,
      workflow_id: options.workflow,
      ref: options.ref,
      inputs: { 'runner-labels': JSON.stringify(options.labels), 'probe-id': probeId },
      return_run_details: true,
      headers: { 'X-GitHub-Api-Version': '2026-03-10' },
      request: { signal: controller.signal, timeout: 10000 },
    });
    dispatched = true;
    const returnedId = (response.data as { workflow_run_id?: number } | undefined)?.workflow_run_id;
    if (typeof returnedId === 'number' && Number.isSafeInteger(returnedId) && returnedId > 0 && returnedId !== options.parentRunId) {
      runId = returnedId;
    } else {
      // Older GitHub servers can return 204 despite accepting the dispatch.
      // Correlate by an unpredictable run title rather than guessing the newest run.
      while (!runId && Date.now() < deadline) {
        const response = await octokit.rest.actions.listWorkflowRuns({
          owner: options.owner, repo: options.repo, workflow_id: options.workflow,
          event: 'workflow_dispatch', per_page: 100,
          request: { signal: controller.signal, timeout: 10000 },
        });
        runId = response.data.workflow_runs.find(run =>
          run.display_title === `Runner availability probe ${probeId}` && run.id !== options.parentRunId,
        )?.id;
        if (!runId) await delay(1000, undefined, { signal: controller.signal });
      }
      if (!runId) throw new Error('Could not identify the dispatched probe. Check the helper workflow run-name and cancel any orphaned probe.');
    }

    while (Date.now() < deadline) {
      let run;
      try {
        ({ data: run } = await octokit.rest.actions.getWorkflowRun({
          owner: options.owner, repo: options.repo, run_id: runId,
          request: { signal: controller.signal, timeout: 10000 },
        }));
      } catch (error) {
        // Dispatch can return an ID before the run becomes readable.
        if ((error as { status?: number }).status !== 404) throw error;
        await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal });
        continue;
      }
      if (run.status === 'completed') {
        completed = true;
        return {
          available: run.conclusion === 'success',
          diagnostics: `Runner probe #${runId} completed with ${run.conclusion}.`,
        };
      }
      await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal });
    }
    return { available: false, diagnostics: `Runner probe #${runId} did not complete within ${options.timeoutSeconds} seconds.` };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Runner probe interrupted.');
    if (dispatched && !runId) throw new Error(`Could not identify the dispatched probe: ${message(error)}`);
    return { available: false, diagnostics: `Runner probe unavailable: ${message(error)}` };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (runId && !completed) {
      try {
        await octokit.rest.actions.cancelWorkflowRun({
          owner: options.owner, repo: options.repo, run_id: runId,
          request: { timeout: 10000 },
        });
      } catch (error) {
        // Completion may race cancellation; GitHub returns 409 for that case.
        if ((error as { status?: number }).status !== 409) {
          throw new Error(`Could not cancel runner probe #${runId}: ${message(error)}. Cancel it in GitHub Actions.`);
        }
      }
    }
  }
}
