# Changelog

## [Unreleased]

### Added

- Show the number of repeated songs on the toolbar badge after a scan; **Clear results** removes it.
- Copy a single song's positions from its result row.
- Filter results by minimum copies (2+, 3+, 4+ or 5+).

### Changed

- The scan button reads **Scan again** once a scan has completed, and the completion time is shown with the result.
- The first scan after opening the popup reuses the connection metadata, removing one Apple Music round trip.
- The local cache holds a full 50,000-track result set (raised from 2 MB to 4.5 MB).
- Large position lists render about twenty times faster by reusing one number formatter.

### Fixed

- Cached results stay visible when Apple Music is unreachable or MusicKit is unavailable, instead of showing only a connection error.
- A rendering error while reporting scan progress no longer discards an otherwise valid scan.
- The toolbar badge no longer carries over when the popup is opened on a different playlist.
- A modification marker that appears between the first and last page now invalidates the scan.
- Injection failures caused by tab access now report the `TAB_ACCESS` code instead of `UNEXPECTED`.

## [1.2.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.2.0) (2026-11-08)

Feature release from the audit backlog: a results workflow (search, sort, copy, CSV, cached last scan), a manual theme control, and reliability and performance work. Permissions are unchanged.

### Added

- Add a theme control in the popup header: Auto follows the operating system, Light and Dark override it, and the choice is stored locally.
- Search and sort repeated-song results, copy the visible list, and download it as CSV.
- Restore the last completed scan when the popup reopens; clear it explicitly with **Clear**.
- Show extra-copy counts, collapse very large position lists until expanded, and expose stable error codes plus the extension version for diagnostics.
- Add `npm run benchmark` for reader, matcher, and CSV CPU measurements.
- Add `npm run check:docs` to keep package, lockfile, manifest, README, release and security version references aligned.

### Changed

- Retry-after guidance from Apple is honored for transient failures instead of always using the short fixed backoff.
- Numeric strings in MusicKit counts are accepted, and localized tab-access failures are classified from tab state rather than English error text.

### Fixed

- Unexpected page-side failures are classified as internal errors instead of being mislabeled as network failures and retried.
- Documentation now describes pagination positions as derived rather than independently verified by Apple.

## [1.1.2](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.2) (2026-11-07)

Reliability hardening after a full source audit. Matching rules, permissions, and the popup flow are unchanged.

- Retry transient failures (network, timeout, rate limit, 5xx) with bounded backoff instead of discarding an entire scan; add a `SERVER` code so permanent 4xx rejections are still not retried.
- Bound page injection to 30 seconds so a wedged renderer or discarded tab can no longer leave the popup waiting forever.
- Report unexpected extension failures honestly and log them, keep tab-access guidance for real permission denials, and report a closed tab as a playlist change.
- Raise the overall scan deadline from five to ten minutes so the documented 50,000-entry limit is reachable, and make the deadline clock monotonic.
- Normalize trailing slashes in playlist routes so the popup and page agree after router canonicalization.
- Throttle scan progress and hold live-region announcements while pages stream in, so screen readers are not flooded.
- Validate error codes against one shared list, with compile-time guards and a serialized-function isolation test.
- Derive the manifest version from `package.json` at build time.
- Add `form-action 'none'` and `frame-src 'none'` to the extension-page CSP.
- Minify the production bundle (17 KB from 27 KB).
- Run the browser, installed-extension, and packaging suites once per operating system in CI; stop gating releases on low-severity development-only advisories.
- Add ten unit tests, including the serialization guard, error-message coverage, retry behavior, injection timeout, and trailing-slash routing.
- Move community files into `.github/`, keep the root tree focused, and update contributing, security, and license attribution.
- Add direct private vulnerability reporting and contributor branch-protection guidance.

## [1.1.1](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.1) (2026-11-05)

- Prefer the visible catalog playlist's storefront over the player's storefront, falling back to the player only when the route omits one.
- Pluralize the remaining-results button correctly when exactly one song is left.
- Add `default-src 'self'` to the extension-page CSP.
- Add storefront and singular-batch regression coverage; refresh the README screenshot and verification notes.
- Configure Dependabot to defer major updates of TypeScript and Node typings to an explicit compatibility review.
- Route security reports through the security policy, add a pull-request checklist, and document required repository security settings.
- Enable private vulnerability reporting, secret scanning and push protection, Dependabot alerts and security updates, CodeQL default setup, and required CI checks on `main`.
- Add installation requirements, a feature summary, troubleshooting guidance, and checksum verification to the README.

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
