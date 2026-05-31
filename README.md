# available-runner-action

A GitHub Action that detects whether a preferred self-hosted runner is available and automatically falls back to a GitHub-hosted runner when none can be found. Use it to keep CI/CD pipelines running even when on-premises infrastructure is offline.

---

## Why this action exists

GitHub Actions has no native runner failover. When a workflow specifies a self-hosted runner label and no matching runner is online, the job stays queued indefinitely. This action solves that problem without requiring any external tooling, dedicated infrastructure, or complex workflow logic.

Typical use case: a team runs build jobs on a private server for speed and cost reasons. When that server is down for maintenance, deployments should not block — they should silently fall back to GitHub-hosted runners and continue.

---

## How it works

The action runs as a small, fast pre-job step. It queries the GitHub Actions API for all self-hosted runners visible to the workflow (at repository and organization scope), checks which ones are online and not busy, and returns a `runner` output that the dependent job uses in its `runs-on` field.

```
Workflow
   │
   ▼
available-runner-action
   │
   ▼
GitHub REST API
   │
   ├─ matching runner found ──► return labels  (e.g. ["self-hosted","linux"])
   │
   └─ no match              ──► return fallback (e.g. "ubuntu-latest")
```

The result is a JSON-encoded string. The dependent job wraps it with `fromJSON()`, which GitHub Actions evaluates to either an array (for self-hosted runners) or a plain string (for GitHub-hosted runners) — both are valid `runs-on` values.

---

## Permissions

The action only reads runner data. No write permissions are needed.

```yaml
permissions:
  actions: read
```

The default `GITHUB_TOKEN` is sufficient for repository-scope runner queries. For organization-scope runner access a personal access token with `manage_runners:org` read scope may be required depending on the organization's settings.

---

## Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `preferred-labels` | multiline string | `self-hosted` | Newline-separated list of runner labels. A runner must match **all** labels to qualify. |
| `fallback-runner` | string | `ubuntu-latest` | Runner to use when no self-hosted runner is available. Any valid `runs-on` value is accepted. |
| `require-idle` | boolean | `true` | When `true`, busy runners are excluded. Set to `false` to allow selecting a runner that is currently executing another job. |
| `fail-if-no-runner` | boolean | `false` | When `true`, the action fails the workflow instead of using the fallback runner. Useful for jobs that must run on specific infrastructure. |
| `github-token` | string | `github.token` | Token for GitHub API calls. Override when you need organization-level runner access with a PAT. |

## Outputs

| Output | Values | Description |
|--------|--------|-------------|
| `runner` | JSON string or array | Pass directly to `runs-on` via `fromJSON()`. Returns a JSON array for self-hosted runners and a JSON string for GitHub-hosted runners. |
| `selected_type` | `self-hosted` \| `github-hosted` | Indicates which kind of runner was selected. Useful for conditional steps in the dependent job. |
| `diagnostics` | string | Human-readable explanation of the selection, including runner counts and any API errors. |

---

## Usage examples

### Minimal setup

Two jobs: the first selects a runner, the second uses it.

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runner: ${{ steps.pick.outputs.runner }}
    steps:
      - id: pick
        uses: lod-softworks/available-runner-action@v1

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runner) }}
    steps:
      - uses: actions/checkout@v4
      - run: dotnet build
```

---

### Custom runner labels

Require a runner that has **all three** labels.

```yaml
- id: pick
  uses: lod-softworks/available-runner-action@v1
  with:
    preferred-labels: |
      self-hosted
      windows
      build-server
```

---

### Custom fallback runner

Fall back to a Windows GitHub-hosted runner instead of the default Linux one.

```yaml
- id: pick
  uses: lod-softworks/available-runner-action@v1
  with:
    preferred-labels: |
      self-hosted
      windows
    fallback-runner: windows-latest
```

---

### Allow busy runners

Accept a runner that is currently executing another job. Useful when the queue matters less than staying on self-hosted infrastructure.

```yaml
- id: pick
  uses: lod-softworks/available-runner-action@v1
  with:
    require-idle: 'false'
```

---

### Require self-hosted infrastructure

Fail the workflow immediately if no self-hosted runner is available, rather than falling back to GitHub-hosted.

```yaml
- id: pick
  uses: lod-softworks/available-runner-action@v1
  with:
    fail-if-no-runner: 'true'
```

---

### Branch on runner type

Use `selected_type` to adjust downstream step behaviour depending on which runner was selected.

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runner: ${{ steps.pick.outputs.runner }}
      runner_type: ${{ steps.pick.outputs.selected_type }}
    steps:
      - id: pick
        uses: lod-softworks/available-runner-action@v1

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runner) }}
    steps:
      - uses: actions/checkout@v4

      - name: Cache (self-hosted NFS path)
        if: needs.select-runner.outputs.runner_type == 'self-hosted'
        uses: actions/cache@v4
        with:
          path: /mnt/nfs/cache
          key: build-${{ hashFiles('**/*.csproj') }}

      - run: dotnet build
```

---

### Organization-level runners with a PAT

```yaml
- id: pick
  uses: lod-softworks/available-runner-action@v1
  with:
    preferred-labels: self-hosted
    github-token: ${{ secrets.ORG_RUNNER_PAT }}
```

---

## Diagnostics output

The `diagnostics` output explains why a particular runner was selected. It is useful for debugging runner selection in pull request or deployment logs.

Example when a self-hosted runner was found:

```
Found 2 available runner(s) matching labels:
[self-hosted, linux]

Selected:
self-hosted
```

Example when no runner was available:

```
No online, idle runner found matching labels:
[self-hosted, windows, build-server]

Using fallback:
ubuntu-latest
```

Example when the API was unreachable:

```
No online, idle runner found matching labels:
[self-hosted, linux]

API errors encountered:
  Repository runners API failed: 403 Forbidden

Using fallback:
ubuntu-latest
```

---

## Frequently asked questions

**Does the action reserve the runner it selects?**
No. The action only reads runner state at the moment it runs. It does not lock or reserve runners. A runner can become busy between selection and actual job dispatch. If that happens the job queues normally — which is the same behaviour GitHub Actions uses today.

**Does it work with GitHub Enterprise Server?**
The action uses the standard `@actions/github` Octokit client which respects the `GITHUB_API_URL` environment variable. GHES support should work as long as the API is accessible from the runner executing the selection step.

**What happens if both the repo and org API calls fail?**
The action falls back to the configured fallback runner and records the errors in the `diagnostics` output. The workflow continues.

**Can I use this in a reusable workflow?**
Yes. Pass the `runner` output through as a workflow output and use it with `fromJSON()` in the caller.

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build distribution bundle (required before committing)
npm run build
```

The `dist/index.js` bundle is committed to the repository so that GitHub Actions can execute the action without a build step. Always run `npm run build` and commit the updated `dist/` before pushing changes to the action logic.
