# available-runner-action

Choose a self-hosted runner when available, or fall back to GitHub-hosted infrastructure. The selector returns a JSON `runner` output for a dependent job's `runs-on` field.

## V3: choose PAT or probe

Use `lod-softworks/available-runner-action@v3` for either discovery method. V3 is the maintained release line; the method is a workflow input, not a version choice. It runs on Node.js 24.

| `mode` | Availability check | Credential | Extra job |
| --- | --- | --- | --- |
| `pat` | Read repository and organization runner inventory | PAT or App token with runner-read access | None |
| `probe` | Dispatch a minimal readiness helper | Normal short-lived `GITHUB_TOKEN`, with `actions: write` on the selector job | One probe workflow run |
| `auto` (default) | Use probe if `probe-workflow` is supplied; otherwise use PAT inventory | Depends on the selected method | Depends on the selected method |

Set `mode` explicitly in new workflows. `auto` preserves existing configurations when upgrading: a v1-style credential setup still reads inventory, and a v2 setup with `probe-workflow` still dispatches the helper. The action never switches from one discovery method to the other after an API failure; the selected method either finds a runner or uses the configured hosted fallback.

Use `@v3` for the current v3 release, or `@3.0.0` / `@v3.0.0` to pin this release. For an immutable source pin, use the release commit SHA. Existing v1 and v2 releases and tags are retained unchanged for old workflows, with no separate maintenance branches.

## Probe mode: normal token plus an extra readiness run

Use `mode: probe` when you want to avoid a persistent discovery credential in the consuming repository.

Copy [`examples/available-runner-probe.yml`](examples/available-runner-probe.yml) to `.github/workflows/available-runner-probe.yml` in the consuming repository and merge it to the default branch. GitHub must register the helper before it can be dispatched. After it has run at least once, GitHub also supports dispatching a branch or tag containing it.

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    outputs:
      runner: ${{ steps.pick.outputs.runner }}
    steps:
      - id: pick
        uses: lod-softworks/available-runner-action@v3
        with:
          mode: probe
          probe-workflow: available-runner-probe.yml
          preferred-labels: |
            self-hosted
            macOS
            ARM64
          fallback-runner: macos-26
          probe-timeout-seconds: '90'

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runner) }}
    steps:
      - uses: actions/checkout@v6
      - run: dotnet build
```

The helper prints a readiness message. It has `permissions: {}`, checks out no source, receives no repository secrets, and does not duplicate the application build. A successful probe selects the self-hosted labels. A timeout, failed probe, or dispatch failure selects the configured fallback (or honors `fail-if-no-runner`).

The tradeoff is an extra workflow run. On ephemeral infrastructure, the probe consumes one runner VM and the application build waits for a fresh replacement. Allow for that startup time when choosing the timeout; the example uses 90 seconds, while the action default is 30 seconds. PAT mode avoids this extra VM cycle.

Unfinished known probes are cancelled on timeout, polling failure, or parent cancellation. Cancellation failure is a hard error so queued work is not silently abandoned. Dispatch details identify the exact child run; on older servers, its unique title does. Keep the helper's `probe-id` input and `run-name`. Brief 404 responses while a newly dispatched run becomes readable are retried within the timeout. Abrupt loss of the hosted selector before cleanup can leave a child probe queued; cancel it in Actions. Never add application builds or publishing to the helper.

`probe-ref` defaults to the consuming repository's default branch. Override it with a trusted branch or tag containing the helper when validating changes. Keep fork pull requests on hosted infrastructure and do not grant write permissions to untrusted workflows. GitHub Enterprise installations need workflow-dispatch support.

## PAT mode: runner-read credential, no probe job

Use `mode: pat` when you prefer an inventory check without dispatching another job. Supply a PAT or GitHub App installation token with the appropriate runner-list permissions:

- Organization runners: **Self-hosted runners: read** for the organization.
- Repository runners: **Administration: read** for the repository.

The default `GITHUB_TOKEN` does not provide these permissions; `actions: read` alone is insufficient. For organization-only discovery, a fine-grained PAT can have no private source-code access. Store the credential as a repository or organization Actions secret accessible to the selector job. An environment-only secret is unavailable unless that job uses the environment.

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      runner: ${{ steps.pick.outputs.runner }}
    steps:
      - id: pick
        uses: lod-softworks/available-runner-action@v3
        with:
          mode: pat
          github-token: ${{ secrets.ORG_RUNNER_PAT }}
          preferred-labels: |
            self-hosted
            macOS
            ARM64
          fallback-runner: macos-26
          require-idle: 'true'

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runner) }}
    steps:
      - uses: actions/checkout@v6
      - run: dotnet build
```

The action reads repository and organization runner inventories, deduplicates runners, and selects those matching every requested label. By default, runners must be online and idle. Inventory API failures appear in diagnostics; if no qualifying runner is found, the action uses the fallback. No helper workflow or Actions write permission is required.

Explicit PAT mode ignores probe inputs and never dispatches the helper. The `github-token` input can contain a PAT or an appropriately scoped GitHub App installation token.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `auto` | `pat` for inventory, `probe` for a readiness helper, or `auto` to infer from `probe-workflow`. Invalid values fail before API calls. |
| `preferred-labels` | `self-hosted` | Newline-separated labels; every label must match. |
| `fallback-runner` | `ubuntu-latest` | Hosted runner to use when the preferred runner is unavailable. |
| `require-idle` | `true` | PAT mode only: exclude busy runners. Set to `false` to allow them. Probe mode measures whether a job completes within the window instead. |
| `fail-if-no-runner` | `false` | Fail instead of selecting the fallback. |
| `github-token` | `github.token` | Runner-read PAT/App token in PAT mode; normal token with Actions write in probe mode. |
| `probe-workflow` | empty | Helper filename. Explicit probe mode defaults to `available-runner-probe.yml`; supplying it in auto mode selects probe. Ignored in PAT mode. |
| `probe-ref` | repository default branch | Trusted branch or tag containing the helper. |
| `probe-timeout-seconds` | `30` | Completion window, from 5 to 300 seconds. |

## Outputs

Both modes expose the same outputs:

| Output | Description |
| --- | --- |
| `runner` | JSON array for self-hosted labels or JSON string for the hosted fallback; use `fromJSON()` in `runs-on`. |
| `selected-type` | `self-hosted` or `github-hosted`. |
| `diagnostics` | Selection explanation, inventory counts or probe result, and API errors. |

Neither mode reserves the runner. Another job can claim it between selection and the application job; normal GitHub scheduling applies. The action does not autoscale runners or guarantee that the selected infrastructure remains available after selection.

## Migrating to v3

- From v1: change the action reference to `@v3` and set `mode: pat`. Keep the existing runner-read credential, labels, and fallback. No helper is required.
- From v2 probes: change the reference to `@v3` and set `mode: probe`. Keep the helper, Actions write permission, labels, ref, and timeout. No discovery secret is required.
- To change from PAT to probe: add and register the permission-free helper, grant only the selector job `actions: write`, set `mode: probe`, and remove the custom `github-token` input. After verifying selection and fallback, remove the unused discovery secret and revoke its credential if nothing else uses it.
- To change from probe to PAT: set `mode: pat` and supply the runner-read token. The selector no longer needs Actions write permission. Retire the helper only if no other workflows dispatch it.

Keep your runner manager's separate registration credentials where the manager runs. Probe mode replaces discovery credentials in the consuming repository; it does not replace runner registration or VM management.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Commit the generated `dist/` bundle whenever action logic changes. Release versions use an unprefixed semantic version (`3.0.0`), a matching full alias (`v3.0.0`), and a major alias (`v3`). Preserve all v1 and v2 tags when publishing v3.
