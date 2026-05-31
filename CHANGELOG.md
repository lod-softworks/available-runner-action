# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-31

### Added

- Initial release of `available-runner-action`.
- `preferred-labels` input: newline-separated list of runner labels that must all match.
- `fallback-runner` input: the GitHub-hosted runner to use when no self-hosted runner is available (default: `ubuntu-latest`).
- `require-idle` input: when `true` (default), only idle runners are considered.
- `fail-if-no-runner` input: when `true`, the action fails instead of falling back.
- `github-token` input: optional token override for the GitHub Actions API.
- `runner` output: JSON-encoded value suitable for use with `fromJSON()` in `runs-on`.
- `selected_type` output: `self-hosted` or `github-hosted`.
- `diagnostics` output: human-readable explanation of the selection.
- Repository-scope runner query via `GET /repos/{owner}/{repo}/actions/runners`.
- Organization-scope runner query via `GET /orgs/{org}/actions/runners`.
- Automatic deduplication of runners that appear in both scopes.
- Graceful fallback when either API call fails (errors surfaced in diagnostics).
