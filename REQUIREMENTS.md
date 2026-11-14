# PRD: GitHub Actions Runner Fallback

## Overview

Runner Fallback is a GitHub Action that automatically determines whether a preferred self-hosted runner is available and, if not, transparently falls back to a configurable GitHub-hosted runner.

The action is designed to be used as a lightweight dependency in GitHub Actions workflows and reusable workflows, allowing organizations to prioritize on-premises infrastructure while maintaining reliable CI/CD execution.

---

# Problem Statement

GitHub Actions does not natively support runner failover.

When a workflow specifies:

```yaml
runs-on: [self-hosted, my-runner]
```

and no matching runner is available, the job remains queued indefinitely.

Organizations commonly operate a mix of:

- Self-hosted runners
- GitHub-hosted runners

They need workflows that:

1. Prefer self-hosted infrastructure.
2. Continue running when self-hosted infrastructure is unavailable.
3. Require minimal workflow complexity.
4. Can be standardized across repositories.

---

# Goals

## Primary Goals

- Detect availability of self-hosted runners.
- Return a valid `runs-on` value.
- Support fallback to GitHub-hosted runners.
- Work with repository-level, organization-level, and enterprise-level runners.
- Support custom runner labels.
- Be usable in reusable workflows.
- Require no external infrastructure.

## Secondary Goals

- Support multiple preferred runner labels.
- Support multiple fallback runners.
- Expose diagnostics for troubleshooting.
- Provide marketplace-ready documentation.

---

# Non-Goals

- Scheduling jobs.
- Reserving runners.
- Load balancing.
- Queue management.
- Auto-scaling runner infrastructure.
- Running application builds or publishing inside the action (the optional probe helper only reports readiness).

The action only determines which runner should be used.

---

# User Stories

## Story 1

As a developer,

I want my workflow to use my on-prem runner when available,

so that builds run on my own infrastructure.

## Story 2

As a developer,

I want builds to automatically use GitHub-hosted runners when my on-prem runner is offline,

so that deployments are never blocked.

## Story 3

As a platform engineer,

I want one standard action that all repositories can use,

so that runner selection logic is centralized.

---

# Example Usage

## Basic

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runner: ${{ steps.runner.outputs.runner }}
    steps:
      - id: runner
        uses: lod-softworks/available-runner-action@v3
        with:
          mode: pat
          github-token: ${{ secrets.ORG_RUNNER_PAT }}

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runner) }}

    steps:
      - uses: actions/checkout@v4
      - run: dotnet build
```

---

## Custom Labels

```yaml
- uses: lod-softworks/available-runner-action@v3
  id: runner
  with:
    mode: pat
    github-token: ${{ secrets.ORG_RUNNER_PAT }}
    preferred-labels: |
      self-hosted
      windows
      build-server
```

---

## Custom Fallback

```yaml
- uses: lod-softworks/available-runner-action@v3
  id: runner
  with:
    mode: pat
    github-token: ${{ secrets.ORG_RUNNER_PAT }}
    fallback-runner: windows-latest
```

---

# Functional Requirements

## FR-1 Detect Runner Availability

In PAT mode, query the GitHub Actions API for runner inventory. In probe mode, dispatch and monitor a permission-free helper workflow to verify that a matching runner can accept work.

Supported scopes:

- Repository
- Organization
- Enterprise (future)

---

## FR-2 Label Matching

The action shall identify runners matching all supplied labels.

Example:

```yaml
preferred-labels:
  - self-hosted
  - windows
  - build-server
```

A runner must contain every label to qualify.

---

## FR-3 Online Check

In PAT mode, the action shall only consider runners where:

```text
status = online
```

---

## FR-4 Idle Check

In PAT mode, by default the action shall only consider runners where:

```text
busy = false
```

---

## FR-5 Fallback Runner

If no matching runner exists, the action shall return the configured fallback runner.

Default:

```text
ubuntu-latest
```

---

## FR-6 Outputs

### Output: runner

Type:

```yaml
string
```

Examples:

```json
["self-hosted","windows","build-server"]
```

or

```json
"ubuntu-latest"
```

---

### Output: selected_type

Values:

```text
self-hosted
github-hosted
```

---

### Output: diagnostics

Human-readable explanation.

Example:

```text
No online runner found matching labels:
[self-hosted, windows, build-server]

Using fallback:
ubuntu-latest
```

---

# Inputs

## preferred-labels

Type:

```yaml
multiline string
```

Default:

```text
self-hosted
```

---

## fallback-runner

Type:

```yaml
string
```

Default:

```text
ubuntu-latest
```

---

## require-idle

Type:

```yaml
boolean
```

Default:

```text
true
```

---

## fail-if-no-runner

Type:

```yaml
boolean
```

Default:

```text
false
```

If enabled:

- Do not use fallback.
- Fail action immediately.

---

# Technical Design

## Architecture

```text
Workflow
    |
    V
Runner Fallback Action
    |
    V
GitHub REST API
    |
    V
Runner List
    |
    +--> Matching Runner Found
    |         |
    |         V
    |   Return Labels
    |
    +--> No Match
              |
              V
      Return Fallback Runner
```

---

## API Endpoints

Repository scope:

```http
GET /repos/{owner}/{repo}/actions/runners
```

Organization scope:

```http
GET /orgs/{org}/actions/runners
```

---

# Security

## Permissions

V3 PAT inventory mode requires a PAT or App installation token with repository Administration read or organization Self-hosted runners read. The normal workflow token and `actions: read` alone are insufficient.

V3 probe mode requires only the normal short-lived workflow token with `actions: write` on the selector job. The helper has `permissions: {}` and receives no repository secrets. The `mode` input explicitly selects PAT or probe; `auto` retains compatibility by selecting probe only when `probe-workflow` is supplied.

Maintain one current generation: `3.0.0` / `v3.0.0` / `v3`, supporting both PAT and probe modes. Preserve every existing v1 and v2 release/tag unchanged for old workflows.

---

# Error Handling

## API Failure

If GitHub API cannot be reached:

Behavior:

```text
Use fallback runner.
```

Output diagnostics should indicate the API failure.

---

## Invalid Labels

If preferred labels are empty:

Behavior:

```text
Fail action.
```

---

## Invalid Fallback

If fallback runner is empty:

Behavior:

```text
Use ubuntu-latest.
```

---

# Logging

Action logs should include:

```text
Preferred Labels:
[self-hosted, windows]

Matching Runners:
2

Available Runners:
1

Selected:
self-hosted
```

or

```text
Preferred Labels:
[self-hosted, windows]

Matching Runners:
0

Selected:
ubuntu-latest
```

---

# Success Criteria

The action is considered successful when:

- Self-hosted runner is selected when available.
- Fallback runner is selected when unavailable.
- No workflow remains indefinitely queued waiting for a missing runner.
- The action works identically across repositories.
- Configuration requires fewer than 10 lines of workflow YAML.

---

# Future Enhancements

## Priority-Based Fallback Chain

```yaml
fallback-runners:
  - self-hosted-linux
  - ubuntu-latest
  - windows-latest
```

---

## Runner Group Support

```yaml
runner-group: production
```

---

## Organization Policy Mode

Centralized configuration for all repositories.

---

## Metrics

Expose telemetry outputs:

```yaml
runner_found: true
runner_name: build-server-01
runner_busy: false
selection_duration_ms: 120
```

---

# Repository Structure

```text
.github/
docs/
src/
  action.yml
  index.ts
tests/
README.md
LICENSE
CHANGELOG.md
```


## Unified v3 discovery modes

- Explicit `mode: pat` always queries runner inventory using the supplied runner-read token, even if probe inputs are present. It never dispatches a helper.
- Explicit `mode: probe` uses the configured helper, defaulting to `available-runner-probe.yml`.
- Default `mode: auto` selects probe when `probe-workflow` is supplied; otherwise it selects PAT inventory. Invalid modes fail before API calls.
- Neither method falls through to the other after an error; use the normal hosted fallback or `fail-if-no-runner`.
- In probe mode, `probe-workflow` dispatches a minimal helper in the same repository using only the short-lived `GITHUB_TOKEN` with `actions: write`.
- Successful helper completion within a bounded 5–300 second window is evidence that a matching runner accepted work. No runner inventory API is called in this mode.
- Preserve existing runner/fallback outputs and `fail-if-no-runner`. `require-idle` remains an inventory-mode setting; probes measure dispatch latency instead.
- Correlate the exact child run using dispatch response details or a unique `probe-id` run title. Never cancel the parent or an unrelated workflow run.
- Cancel unfinished known child runs on timeout, polling errors, and parent cancellation. Surface cleanup failures as errors. Document the abrupt-host-loss orphan case.
- The helper has `permissions: {}`, no checkout, no secrets, and only a readiness command. Application builds stay in the caller's dependent job.
- Ephemeral infrastructure replaces the probe VM before the application job; one extra VM lifecycle and its startup delay are accepted tradeoffs for removing persistent repository credentials.
- Inventory mode remains backward compatible. Documentation must accurately state that the default workflow token cannot list private repository/organization runners.
- Run on Node.js 24, type-check and test both modes, and commit the generated distribution bundle.
