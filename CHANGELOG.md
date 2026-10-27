# Changelog

## [1.1.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.0) (2026-10-27)

- Keep Node 22 support with isolated compiled unit tests; remove the version-specific test flag and tsx dependency.
- Add CI for Node 22/24/26, scheduled dependency audits, Dependabot, and real unpacked-extension smoke tests.
- Add scan cancellation, a five-minute deadline, practical resource limits, bounded metadata, and late-response isolation.
- Check optional playlist version hashes and show clear warnings about consistency and missing modification markers.
- Validate page-world replies, production permissions/CSP, package contents, deterministic ZIPs, and SHA-256 sidecars.
- Update esbuild and Chrome typings while retaining compatible TypeScript and Playwright versions.

## 1.0

First release.

- Scan the playlist open in Apple Music, including playlists with multiple pages of tracks.
- Find repeated songs by their identifiers and show their names, artists, and playlist positions.
- Show progress and stop when requests fail or missing data is detected.
- Browse results in a popup with light and dark themes and keyboard support.
- Process results locally without editing your music or collecting credentials.

Install in Chrome or Edge using the extension ZIP attached to the [release](../../releases/tag/v1.0). Updates are manual.
