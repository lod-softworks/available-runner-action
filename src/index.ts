import * as core from '@actions/core';
import * as github from '@actions/github';

export interface RunnerLabel {
  id: number;
  name: string;
  type: string;
}

export interface Runner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels: RunnerLabel[];
}

export interface RunnerSelectionResult {
  runner: string;
  selectedType: 'self-hosted' | 'github-hosted';
  diagnostics: string;
}

/**
 * Parses a newline-separated label string into a trimmed, non-empty label array.
 */
export function parseLabels(input: string): string[] {
  return input
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Returns true when a runner possesses every required label (case-insensitive).
 */
export function runnerMatchesLabels(runner: Runner, requiredLabels: string[]): boolean {
  const runnerLabelNames = new Set(runner.labels.map(l => l.name.toLowerCase()));
  return requiredLabels.every(label => runnerLabelNames.has(label.toLowerCase()));
}

/**
 * Returns true when a runner satisfies the online and idle constraints.
 */
export function isRunnerAvailable(runner: Runner, requireIdle: boolean): boolean {
  if (runner.status !== 'online') return false;
  if (requireIdle && runner.busy) return false;
  return true;
}

type Octokit = ReturnType<typeof github.getOctokit>;

async function fetchRunnersForRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Runner[]> {
  const runners: Runner[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.actions.listSelfHostedRunnersForRepo({
      owner,
      repo,
      per_page: 100,
      page,
    });

    runners.push(...(response.data.runners as Runner[]));

    if (response.data.runners.length < 100) break;
    page++;
  }

  return runners;
}

async function fetchRunnersForOrg(octokit: Octokit, org: string): Promise<Runner[]> {
  const runners: Runner[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.actions.listSelfHostedRunnersForOrg({
      org,
      per_page: 100,
      page,
    });

    runners.push(...(response.data.runners as Runner[]));

    if (response.data.runners.length < 100) break;
    page++;
  }

  return runners;
}

/**
 * Queries the GitHub API for all self-hosted runners visible from the current
 * workflow context (repository scope, then organization scope). Runners that
 * appear in both are deduplicated by id.
 */
export async function fetchAllRunners(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ runners: Runner[]; apiErrors: string[] }> {
  const runners: Runner[] = [];
  const apiErrors: string[] = [];

  try {
    const repoRunners = await fetchRunnersForRepo(octokit, owner, repo);
    runners.push(...repoRunners);
  } catch (err) {
    const msg = `Repository runners API failed: ${err instanceof Error ? err.message : String(err)}`;
    apiErrors.push(msg);
    core.warning(msg);
  }

  try {
    const orgRunners = await fetchRunnersForOrg(octokit, owner);
    const existingIds = new Set(runners.map(r => r.id));
    for (const r of orgRunners) {
      if (!existingIds.has(r.id)) {
        runners.push(r);
        existingIds.add(r.id);
      }
    }
  } catch (err) {
    const msg = `Organization runners API failed: ${err instanceof Error ? err.message : String(err)}`;
    apiErrors.push(msg);
    core.warning(msg);
  }

  return { runners, apiErrors };
}

/**
 * Selects a runner given a list of all runners and the action configuration.
 */
export function selectRunner(
  allRunners: Runner[],
  preferredLabels: string[],
  fallbackRunner: string,
  requireIdle: boolean,
  failIfNoRunner: boolean,
  apiErrors: string[],
): RunnerSelectionResult | { failed: true; reason: string } {
  const matchingRunners = allRunners.filter(r => runnerMatchesLabels(r, preferredLabels));
  const availableRunners = matchingRunners.filter(r => isRunnerAvailable(r, requireIdle));

  const labelDisplay = `[${preferredLabels.join(', ')}]`;

  core.info(`Preferred Labels:\n${labelDisplay}`);
  core.info(`Matching Runners:\n${matchingRunners.length}`);
  core.info(`Available Runners:\n${availableRunners.length}`);

  if (availableRunners.length > 0) {
    const runnerJson = JSON.stringify(preferredLabels);
    const diagnostics = [
      `Found ${availableRunners.length} available runner(s) matching labels:`,
      labelDisplay,
      '',
      'Selected:',
      'self-hosted',
    ].join('\n');

    core.info(`\nSelected:\nself-hosted`);

    return {
      runner: runnerJson,
      selectedType: 'self-hosted',
      diagnostics,
    };
  }

  if (failIfNoRunner) {
    const idleClause = requireIdle ? ', idle' : '';
    const reason =
      matchingRunners.length === 0
        ? `No runner found matching labels: ${labelDisplay}`
        : `No available (online${idleClause}) runner found matching labels: ${labelDisplay}`;

    return { failed: true, reason };
  }

  const effectiveFallback = fallbackRunner.trim() || 'ubuntu-latest';
  const idleClause = requireIdle ? ', idle' : '';

  const diagnosticsLines: string[] = [
    `No online${idleClause} runner found matching labels:`,
    labelDisplay,
  ];

  if (apiErrors.length > 0) {
    diagnosticsLines.push('', 'API errors encountered:');
    diagnosticsLines.push(...apiErrors.map(e => `  ${e}`));
  }

  diagnosticsLines.push('', 'Using fallback:', effectiveFallback);

  const diagnostics = diagnosticsLines.join('\n');

  core.info(`\nSelected:\n${effectiveFallback}`);

  return {
    runner: JSON.stringify(effectiveFallback),
    selectedType: 'github-hosted',
    diagnostics,
  };
}

export async function run(): Promise<void> {
  const token =
    core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const preferredLabelsInput =
    core.getInput('preferred-labels');
  const fallbackRunner =
    core.getInput('fallback-runner') || 'ubuntu-latest';
  const requireIdle = core.getInput('require-idle') !== 'false';
  const failIfNoRunner = core.getInput('fail-if-no-runner') === 'true';

  const preferredLabels = parseLabels(preferredLabelsInput);

  if (preferredLabels.length === 0) {
    core.setFailed('preferred-labels must not be empty');
    return;
  }

  const { owner, repo } = github.context.repo;
  const octokit = github.getOctokit(token);

  const { runners: allRunners, apiErrors } = await fetchAllRunners(
    octokit,
    owner,
    repo,
  );

  const result = selectRunner(
    allRunners,
    preferredLabels,
    fallbackRunner,
    requireIdle,
    failIfNoRunner,
    apiErrors,
  );

  if ('failed' in result) {
    core.setFailed(result.reason);
    return;
  }

  core.setOutput('runner', result.runner);
  core.setOutput('selected-type', result.selectedType);
  core.setOutput('diagnostics', result.diagnostics);
}

if (require.main === module) {
  run().catch(err =>
    core.setFailed(err instanceof Error ? err.message : String(err)),
  );
}
