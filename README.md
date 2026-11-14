# available-runner-action

Choose a self-hosted runner when available, or fall back to GitHub-hosted infrastructure. The selector returns a JSON `runner` output for a dependent job's `runs-on` field.

## Choose a version

| Version | Availability check | Credential | Extra job |
| --- | --- | --- | --- |
| [`v1` / `1.0.0`](https://github.com/lod-softworks/available-runner-action/releases/tag/1.0.0) | Read repository and organization runner inventory | PAT or App token with runner-read access | None |
| [`v2` / `2.0.0`](https://github.com/lod-softworks/available-runner-action/releases/tag/2.0.0) with `probe-workflow` | Dispatch a minimal readiness helper | Normal short-lived `GITHUB_TOKEN`, with `actions: write` on the selector job | One probe workflow run |

Both versions remain available. Existing `v1`, `v1.0.0`, and `1.0.0` tags stay on the original release. Use `v2` for the current v2 release, or `2.0.0` / `v2.0.0` to pin this release. For an immutable source pin, use the release commit SHA.

V2 also retains inventory mode for compatibility: leaving `probe-workflow` empty uses runner-list APIs and still requires a runner-read credential. Changing only `@v1` to `@v2` does not enable secretless probes; add the helper and inputs below.

## V2: normal token plus an extra probe run

Use this when you want to avoid a persistent discovery credential in the consuming repository. V2 runs on Node.js 24.

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
        uses: lod-softworks/available-runner-action@v2
        with:
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

The tradeoff is an extra workflow run. On ephemeral infrastructure, the probe consumes one runner VM and the application build waits for a fresh replacement. Allow for that startup time when choosing the timeout; the example uses 90 seconds, while the action default is 30 seconds. Inventory mode in v1 avoids this extra VM cycle.

Unfinished known probes are cancelled on timeout, polling failure, or parent cancellation. Cancellation failure is a hard error so queued work is not silently abandoned. Dispatch details identify the exact child run; on older servers, its unique title does. Keep the helper's `probe-id` input and `run-name`. Brief 404 responses while a newly dispatched run becomes readable are retried within the timeout. Abrupt loss of the hosted selector before cleanup can leave a child probe queued; cancel it in Actions. Never add application builds or publishing to the helper.

`probe-ref` defaults to the consuming repository's default branch. Override it with a trusted branch or tag containing the helper when validating changes. Keep fork pull requests on hosted infrastructure and do not grant write permissions to untrusted workflows. GitHub Enterprise installations need workflow-dispatch support.

## V1: runner-read credential, no probe job

Use this when you prefer an inventory check without dispatching another job. Supply a PAT or GitHub App installation token with the appropriate runner-list permissions:

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
        uses: lod-softworks/available-runner-action@v1
        with:
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

For inventory mode on v2, use the same example with `@v2` and leave `probe-workflow` unset.

## Inputs

| Input | Available in | Default | Description |
| --- | --- | --- | --- |
| `preferred-labels` | v1, v2 | `self-hosted` | Newline-separated labels; every label must match. |
| `fallback-runner` | v1, v2 | `ubuntu-latest` | Hosted runner to use when the preferred runner is unavailable. |
| `require-idle` | v1, v2 inventory mode | `true` | Exclude busy runners. Set to `false` to allow them. Probe mode measures whether a job completes within the window instead. |
| `fail-if-no-runner` | v1, v2 | `false` | Fail instead of selecting the fallback. |
| `github-token` | v1, v2 | `github.token` | Runner-read PAT/App token in inventory mode; normal token with Actions write in probe mode. |
| `probe-workflow` | v2 | empty | Helper workflow filename; enables secretless probe mode. |
| `probe-ref` | v2 | repository default branch | Trusted branch or tag containing the helper. |
| `probe-timeout-seconds` | v2 | `30` | Completion window, from 5 to 300 seconds. |

## Outputs

Both versions expose the same outputs:

| Output | Description |
| --- | --- |
| `runner` | JSON array for self-hosted labels or JSON string for the hosted fallback; use `fromJSON()` in `runs-on`. |
| `selected-type` | `self-hosted` or `github-hosted`. |
| `diagnostics` | Selection explanation, inventory counts or probe result, and API errors. |

Neither mode reserves the runner. Another job can claim it between selection and the application job; normal GitHub scheduling applies. The action does not autoscale runners or guarantee that the selected infrastructure remains available after selection.

## Migrating from v1 to secretless v2

1. Add and register the permission-free helper workflow in the consuming repository.
2. Change the action reference to `@v2`, set `probe-workflow`, and grant the selector job `actions: write`.
3. Remove the custom `github-token` input so the action uses the normal workflow token.
4. Verify successful self-hosted selection and timeout/fallback, then remove the unused discovery secret and revoke its credential if nothing else uses it.

Keep your runner manager's separate registration credentials where the manager runs. Probe mode replaces discovery credentials in the consuming repository; it does not replace runner registration or VM management.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Commit the generated `dist/` bundle whenever action logic changes. Release versions use an unprefixed semantic version (`2.0.0`), a matching full alias (`v2.0.0`), and a major alias (`v2`). Preserve all v1 tags when publishing v2.
