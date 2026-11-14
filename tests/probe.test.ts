import { setTimeout as delay } from 'node:timers/promises';
import * as github from '@actions/github';
import { probeRunner, ProbeOptions } from '../src/probe';

jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn() }));

const options: ProbeOptions = {
  owner: 'owner', repo: 'repo', workflow: 'available-runner-probe.yml', ref: 'main',
  labels: ['self-hosted', 'macOS', 'ARM64'], timeoutSeconds: 5, parentRunId: 99,
};

function client() {
  return {
    request: jest.fn().mockResolvedValue({ data: { workflow_run_id: 101 } }),
    rest: { actions: {
      getWorkflowRun: jest.fn().mockResolvedValue({ data: { status: 'completed', conclusion: 'success' } }),
      listWorkflowRuns: jest.fn(),
      cancelWorkflowRun: jest.fn().mockResolvedValue({}),
    } },
  };
}

describe('workflow runner probe', () => {
  let now: number;
  beforeEach(() => {
    now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    (delay as jest.Mock).mockImplementation(async (milliseconds: number) => { now += milliseconds; });
  });

  it('uses the workflow token to dispatch and recognizes a successful probe', async () => {
    const api = client();
    const result = await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options);
    expect(result.available).toBe(true);
    expect(api.request).toHaveBeenCalledWith(expect.stringContaining('/dispatches'), expect.objectContaining({
      return_run_details: true,
      inputs: { 'runner-labels': JSON.stringify(options.labels), 'probe-id': expect.any(String) },
    }));
    expect(api.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('falls back after an unclaimed probe times out and cancels only that probe', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockResolvedValue({ data: { status: 'queued', conclusion: null } });
    const result = await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options);
    expect(result.available).toBe(false);
    expect(result.diagnostics).toContain('5 seconds');
    expect(api.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 101 }));
    expect(now).toBe(6000);
  });

  it('retries a newly dispatched run that is not readable yet', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    const result = await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options);
    expect(result.available).toBe(true);
    expect(api.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(api.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(now).toBe(3000);
  });

  it('bounds retries when the dispatched run remains unreadable', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const result = await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options);
    expect(result.available).toBe(false);
    expect(result.diagnostics).toContain('5 seconds');
    expect(api.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 101 }));
    expect(now).toBe(6000);
  });

  it('falls back for a failed completed probe without cancelling completed work', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockResolvedValue({ data: { status: 'completed', conclusion: 'failure' } });
    expect((await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).available).toBe(false);
    expect(api.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('cleans up the probe when polling fails', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockRejectedValue(new Error('Network unavailable'));
    const result = await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options);
    expect(result.diagnostics).toContain('Network unavailable');
    expect(api.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 101 }));
  });

  it('cleans up the probe on parent-job cancellation', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockImplementation(async () => {
      process.emit('SIGINT');
      throw new Error('Aborted');
    });
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).rejects.toThrow('interrupted');
    expect(api.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 101 }));
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('surfaces cancellation failures instead of silently leaving queued work', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockRejectedValue(new Error('Connection error'));
    api.rest.actions.cancelWorkflowRun.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).rejects.toThrow('Could not cancel runner probe #101');
  });

  it('accepts a completion race during cancellation', async () => {
    const api = client();
    api.rest.actions.getWorkflowRun.mockRejectedValue(new Error('Connection error'));
    api.rest.actions.cancelWorkflowRun.mockRejectedValue(Object.assign(new Error('Completed'), { status: 409 }));
    expect((await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).available).toBe(false);
  });

  it('reports missing dispatch permissions without attempting cancellation', async () => {
    const api = client();
    api.request.mockRejectedValue(new Error('Resource not accessible by integration'));
    expect((await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).diagnostics).toContain('Resource not accessible');
    expect(api.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('correlates legacy dispatch responses by nonce, ignoring unrelated and parent runs', async () => {
    const api = client();
    api.request.mockResolvedValue({ data: undefined });
    api.rest.actions.listWorkflowRuns.mockImplementation(async () => {
      const nonce = api.request.mock.calls[0][1].inputs['probe-id'];
      return { data: { workflow_runs: [
        { id: 55, display_title: 'Unrelated workflow' },
        { id: 99, display_title: `Runner availability probe ${nonce}` },
        { id: 101, display_title: `Runner availability probe ${nonce}` },
      ] } };
    });
    expect((await probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).available).toBe(true);
    expect(api.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 101 }));
  });

  it('never guesses an unrelated run when dispatch details are missing', async () => {
    const api = client();
    api.request.mockResolvedValue({ data: { workflow_run_id: options.parentRunId } });
    api.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [
      { id: 55, display_title: 'Unrelated workflow' },
    ] } });
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, options)).rejects.toThrow('Could not identify');
    expect(api.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([0, 4, 301, 1.5, NaN])('rejects invalid timeout %s before dispatch', async timeoutSeconds => {
    const api = client();
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, { ...options, timeoutSeconds })).rejects.toThrow('probe-timeout-seconds');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('rejects a missing ref or invalid workflow filename before dispatch', async () => {
    const api = client();
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, { ...options, ref: '' })).rejects.toThrow('probe-ref');
    await expect(probeRunner(api as unknown as ReturnType<typeof github.getOctokit>, { ...options, workflow: '../release.yml' })).rejects.toThrow('probe-workflow');
    expect(api.request).not.toHaveBeenCalled();
  });
});
