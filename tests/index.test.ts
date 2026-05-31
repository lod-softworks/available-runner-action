import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  parseLabels,
  runnerMatchesLabels,
  isRunnerAvailable,
  selectRunner,
  fetchAllRunners,
  run,
  Runner,
} from '../src/index';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockCore = core as jest.Mocked<typeof core>;

type MockOctokit = ReturnType<typeof github.getOctokit>;

function makeRunner(
  overrides: Partial<Runner> & { labelNames?: string[] } = {},
): Runner {
  const { labelNames = ['self-hosted'], ...rest } = overrides;
  return {
    id: 1,
    name: 'runner-1',
    status: 'online',
    busy: false,
    labels: labelNames.map((name, i) => ({ id: i, name, type: 'custom' })),
    ...rest,
  };
}

function makeOctokit(
  repoRunners: Runner[] = [],
  orgRunners: Runner[] = [],
  repoError?: Error,
  orgError?: Error,
): MockOctokit {
  return {
    rest: {
      actions: {
        listSelfHostedRunnersForRepo: jest.fn().mockImplementation(() => {
          if (repoError) throw repoError;
          return Promise.resolve({
            data: { total_count: repoRunners.length, runners: repoRunners },
          });
        }),
        listSelfHostedRunnersForOrg: jest.fn().mockImplementation(() => {
          if (orgError) throw orgError;
          return Promise.resolve({
            data: { total_count: orgRunners.length, runners: orgRunners },
          });
        }),
      },
    },
  } as unknown as MockOctokit;
}

// ---------------------------------------------------------------------------
// Unit tests: parseLabels
// ---------------------------------------------------------------------------
describe('parseLabels', () => {
  it('splits on newlines and trims whitespace', () => {
    expect(parseLabels('self-hosted\n  linux  \nbuild-server')).toEqual([
      'self-hosted',
      'linux',
      'build-server',
    ]);
  });

  it('removes empty lines', () => {
    expect(parseLabels('self-hosted\n\nlinux\n')).toEqual([
      'self-hosted',
      'linux',
    ]);
  });

  it('returns empty array for blank input', () => {
    expect(parseLabels('')).toEqual([]);
    expect(parseLabels('   \n  \n')).toEqual([]);
  });

  it('handles a single label', () => {
    expect(parseLabels('self-hosted')).toEqual(['self-hosted']);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: runnerMatchesLabels
// ---------------------------------------------------------------------------
describe('runnerMatchesLabels', () => {
  it('matches when all required labels are present', () => {
    const runner = makeRunner({ labelNames: ['self-hosted', 'windows', 'build-server'] });
    expect(runnerMatchesLabels(runner, ['self-hosted', 'windows'])).toBe(true);
  });

  it('does not match when a required label is missing', () => {
    const runner = makeRunner({ labelNames: ['self-hosted', 'linux'] });
    expect(runnerMatchesLabels(runner, ['self-hosted', 'windows'])).toBe(false);
  });

  it('is case-insensitive', () => {
    const runner = makeRunner({ labelNames: ['Self-Hosted', 'LINUX'] });
    expect(runnerMatchesLabels(runner, ['self-hosted', 'linux'])).toBe(true);
  });

  it('returns true when required labels list is a subset', () => {
    const runner = makeRunner({ labelNames: ['self-hosted', 'linux', 'gpu', 'fast'] });
    expect(runnerMatchesLabels(runner, ['self-hosted'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isRunnerAvailable
// ---------------------------------------------------------------------------
describe('isRunnerAvailable', () => {
  it('returns true for an online idle runner with require-idle=true', () => {
    const runner = makeRunner({ status: 'online', busy: false });
    expect(isRunnerAvailable(runner, true)).toBe(true);
  });

  it('returns false for a busy runner when require-idle=true', () => {
    const runner = makeRunner({ status: 'online', busy: true });
    expect(isRunnerAvailable(runner, true)).toBe(false);
  });

  it('returns true for a busy runner when require-idle=false', () => {
    const runner = makeRunner({ status: 'online', busy: true });
    expect(isRunnerAvailable(runner, false)).toBe(true);
  });

  it('returns false for an offline runner', () => {
    const runner = makeRunner({ status: 'offline', busy: false });
    expect(isRunnerAvailable(runner, true)).toBe(false);
  });

  it('returns false for an offline busy runner with require-idle=false', () => {
    const runner = makeRunner({ status: 'offline', busy: true });
    expect(isRunnerAvailable(runner, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: selectRunner
// ---------------------------------------------------------------------------
describe('selectRunner', () => {
  const labels = ['self-hosted', 'linux'];

  it('selects self-hosted runner when one is available', () => {
    const runner = makeRunner({ labelNames: labels, status: 'online', busy: false });
    const result = selectRunner([runner], labels, 'ubuntu-latest', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.selectedType).toBe('self-hosted');
    expect(result.runner).toBe(JSON.stringify(labels));
    expect(result.diagnostics).toContain('self-hosted');
  });

  it('falls back to github-hosted when no runners match labels', () => {
    const runner = makeRunner({ labelNames: ['self-hosted', 'windows'] });
    const result = selectRunner([runner], labels, 'ubuntu-latest', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.selectedType).toBe('github-hosted');
    expect(result.runner).toBe(JSON.stringify('ubuntu-latest'));
    expect(result.diagnostics).toContain('ubuntu-latest');
  });

  it('falls back when matching runner is offline', () => {
    const runner = makeRunner({ labelNames: labels, status: 'offline' });
    const result = selectRunner([runner], labels, 'ubuntu-latest', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.selectedType).toBe('github-hosted');
  });

  it('falls back when matching runner is busy and require-idle=true', () => {
    const runner = makeRunner({ labelNames: labels, status: 'online', busy: true });
    const result = selectRunner([runner], labels, 'ubuntu-latest', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.selectedType).toBe('github-hosted');
  });

  it('selects self-hosted when runner is busy and require-idle=false', () => {
    const runner = makeRunner({ labelNames: labels, status: 'online', busy: true });
    const result = selectRunner([runner], labels, 'ubuntu-latest', false, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.selectedType).toBe('self-hosted');
  });

  it('uses custom fallback runner', () => {
    const result = selectRunner([], labels, 'windows-latest', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.runner).toBe(JSON.stringify('windows-latest'));
  });

  it('defaults to ubuntu-latest when fallback is blank', () => {
    const result = selectRunner([], labels, '', true, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.runner).toBe(JSON.stringify('ubuntu-latest'));
  });

  it('fails when fail-if-no-runner=true and no runner found', () => {
    const result = selectRunner([], labels, 'ubuntu-latest', true, true, []);

    expect('failed' in result).toBe(true);
    if (!('failed' in result)) return;
    expect(result.reason).toContain(labels.join(', '));
  });

  it('fails when fail-if-no-runner=true and runners are busy', () => {
    const runner = makeRunner({ labelNames: labels, status: 'online', busy: true });
    const result = selectRunner([runner], labels, 'ubuntu-latest', true, true, []);

    expect('failed' in result).toBe(true);
  });

  it('includes API errors in diagnostics', () => {
    const errors = ['Repository runners API failed: 403 Forbidden'];
    const result = selectRunner([], labels, 'ubuntu-latest', true, false, errors);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.diagnostics).toContain('403 Forbidden');
  });

  it('diagnostics omit idle note when require-idle=false', () => {
    const result = selectRunner([], labels, 'ubuntu-latest', false, false, []);

    expect('failed' in result).toBe(false);
    if ('failed' in result) return;
    expect(result.diagnostics).not.toContain(', idle');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: fetchAllRunners
// ---------------------------------------------------------------------------
describe('fetchAllRunners', () => {
  it('returns combined runners from repo and org', async () => {
    const repoRunner = makeRunner({ id: 1 });
    const orgRunner = makeRunner({ id: 2, name: 'org-runner' });
    const octokit = makeOctokit([repoRunner], [orgRunner]);

    const { runners, apiErrors } = await fetchAllRunners(octokit, 'owner', 'repo');

    expect(runners).toHaveLength(2);
    expect(apiErrors).toHaveLength(0);
  });

  it('deduplicates runners that appear in both repo and org lists', async () => {
    const runner = makeRunner({ id: 1 });
    const octokit = makeOctokit([runner], [runner]);

    const { runners } = await fetchAllRunners(octokit, 'owner', 'repo');

    expect(runners).toHaveLength(1);
  });

  it('records API errors and continues when repo API fails', async () => {
    const orgRunner = makeRunner({ id: 2 });
    const octokit = makeOctokit([], [orgRunner], new Error('404 Not Found'));

    const { runners, apiErrors } = await fetchAllRunners(octokit, 'owner', 'repo');

    expect(runners).toHaveLength(1);
    expect(apiErrors[0]).toContain('Repository runners API failed');
  });

  it('records API errors and continues when org API fails', async () => {
    const repoRunner = makeRunner({ id: 1 });
    const octokit = makeOctokit([repoRunner], [], undefined, new Error('403 Forbidden'));

    const { runners, apiErrors } = await fetchAllRunners(octokit, 'owner', 'repo');

    expect(runners).toHaveLength(1);
    expect(apiErrors[0]).toContain('Organization runners API failed');
  });

  it('returns empty list with errors when both APIs fail', async () => {
    const octokit = makeOctokit([], [], new Error('Repo error'), new Error('Org error'));

    const { runners, apiErrors } = await fetchAllRunners(octokit, 'owner', 'repo');

    expect(runners).toHaveLength(0);
    expect(apiErrors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: run()
// ---------------------------------------------------------------------------
describe('run()', () => {
  const mockGetInput = mockCore.getInput as jest.Mock;
  const mockSetOutput = mockCore.setOutput as jest.Mock;
  const mockSetFailed = mockCore.setFailed as jest.Mock;
  const mockGithub = github as jest.Mocked<typeof github>;

  function setupInputs(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = {
      'github-token': 'fake-token',
      'preferred-labels': 'self-hosted',
      'fallback-runner': 'ubuntu-latest',
      'require-idle': 'true',
      'fail-if-no-runner': 'false',
    };
    const inputs = { ...defaults, ...overrides };
    mockGetInput.mockImplementation((name: string) => inputs[name] ?? '');
  }

  beforeEach(() => {
    Object.defineProperty(github, 'context', {
      value: { repo: { owner: 'test-owner', repo: 'test-repo' } },
      writable: true,
      configurable: true,
    });
  });

  it('sets self-hosted outputs when a matching runner is available', async () => {
    setupInputs({ 'preferred-labels': 'self-hosted\nlinux' });
    const runner = makeRunner({ labelNames: ['self-hosted', 'linux'] });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([runner]));

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(
      'runner',
      JSON.stringify(['self-hosted', 'linux']),
    );
    expect(mockSetOutput).toHaveBeenCalledWith('selected_type', 'self-hosted');
  });

  it('sets github-hosted outputs when no runner matches', async () => {
    setupInputs();
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([]));

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(
      'runner',
      JSON.stringify('ubuntu-latest'),
    );
    expect(mockSetOutput).toHaveBeenCalledWith('selected_type', 'github-hosted');
  });

  it('fails when preferred-labels is empty', async () => {
    setupInputs({ 'preferred-labels': '' });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([]));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('preferred-labels'),
    );
  });

  it('fails when fail-if-no-runner=true and no runner available', async () => {
    setupInputs({ 'fail-if-no-runner': 'true' });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([]));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('self-hosted'),
    );
  });

  it('uses custom fallback runner', async () => {
    setupInputs({ 'fallback-runner': 'windows-latest' });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([]));

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith(
      'runner',
      JSON.stringify('windows-latest'),
    );
  });

  it('respects require-idle=false and selects a busy runner', async () => {
    setupInputs({ 'require-idle': 'false' });
    const runner = makeRunner({ labelNames: ['self-hosted'], status: 'online', busy: true });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([runner]));

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith('selected_type', 'self-hosted');
  });

  it('falls back gracefully when both APIs throw errors', async () => {
    setupInputs();
    const octokit = makeOctokit([], [], new Error('Connection refused'), new Error('Connection refused'));
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(octokit);

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('selected_type', 'github-hosted');
    const diagnosticsCall = mockSetOutput.mock.calls.find(c => c[0] === 'diagnostics');
    expect(diagnosticsCall?.[1]).toContain('Connection refused');
  });

  it('falls back when runner is busy and require-idle=true (default)', async () => {
    setupInputs();
    const runner = makeRunner({ labelNames: ['self-hosted'], status: 'online', busy: true });
    (mockGithub.getOctokit as jest.Mock).mockReturnValue(makeOctokit([runner]));

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith('selected_type', 'github-hosted');
  });
});
