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
export declare function parseLabels(input: string): string[];
/**
 * Returns true when a runner possesses every required label (case-insensitive).
 */
export declare function runnerMatchesLabels(runner: Runner, requiredLabels: string[]): boolean;
/**
 * Returns true when a runner satisfies the online and idle constraints.
 */
export declare function isRunnerAvailable(runner: Runner, requireIdle: boolean): boolean;
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * Queries the GitHub API for all self-hosted runners visible from the current
 * workflow context (repository scope, then organization scope). Runners that
 * appear in both are deduplicated by id.
 */
export declare function fetchAllRunners(octokit: Octokit, owner: string, repo: string): Promise<{
    runners: Runner[];
    apiErrors: string[];
}>;
/**
 * Selects a runner given a list of all runners and the action configuration.
 */
export declare function selectRunner(allRunners: Runner[], preferredLabels: string[], fallbackRunner: string, requireIdle: boolean, failIfNoRunner: boolean, apiErrors: string[]): RunnerSelectionResult | {
    failed: true;
    reason: string;
};
export declare function run(): Promise<void>;
export {};
