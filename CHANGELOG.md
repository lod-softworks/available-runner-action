# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-11-14

### Added

- Explicit `mode: pat` and `mode: probe` choices in one maintained action release.
- `mode: auto` compatibility: infer probe from `probe-workflow`, otherwise use PAT inventory.
- Conventional `available-runner-probe.yml` helper default in explicit probe mode.
- Fail-fast mode validation and tests proving discovery methods do not silently switch after errors.

### Changed

- Document both discovery methods with v3 examples, tradeoffs, token permissions, and migration guidance.
- Preserve existing v1/v2 releases and tags as historical versions; future maintenance targets v3.

## [2.0.0] - 2026-11-13

### Added

- Optional secretless workflow-probe mode using the normal workflow token with Actions write permission.
- Probe helper example, bounded completion window, exact run correlation, cancellation cleanup, and failure diagnostics.
- Bounded retries for transient 404 responses immediately after workflow dispatch.
- Side-by-side v1 credential-based and v2 probe-based setup and migration guidance.

### Changed

- Correct inventory API permission documentation and explain the extra VM lifecycle for ephemeral probes.
- Use the supported Node.js 24 action runtime.
- Publish the probe generation as v2; preserve the existing 1.0.0, v1.0.0, and v1 tags. Inventory mode remains available in v2.

## [1.0.0] - 2026-05-31

### Added

- Initial release of `available-runner-action`.
- `preferred-labels` input: newline-separated list of runner labels that must all match.
- `fallback-runner` input: the GitHub-hosted runner to use when no self-hosted runner is available (default: `ubuntu-latest`).
- `require-idle` input: when `true` (default), only idle runners are considered.
- `fail-if-no-runner` input: when `true`, the action fails instead of falling back.
- `github-token` input: optional token override for the GitHub Actions API.
- `runner` output: JSON-encoded value suitable for use with `fromJSON()` in `runs-on`.
- `selected-type` output: `self-hosted` or `github-hosted`.
- `diagnostics` output: human-readable explanation of the selection.
- Repository-scope runner query via `GET /repos/{owner}/{repo}/actions/runners`.
- Organization-scope runner query via `GET /orgs/{org}/actions/runners`.
- Automatic deduplication of runners that appear in both scopes.
- Graceful fallback when either API call fails (errors surfaced in diagnostics).
