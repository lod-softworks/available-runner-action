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
/** Dispatches a token-free helper job, then cancels any unclaimed probe. */
export declare function probeRunner(octokit: Octokit, options: ProbeOptions): Promise<ProbeResult>;
export {};
