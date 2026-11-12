# Changelog

## [1.4.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.4.0) (2026-11-12)

Bug-fix release for the popup's badge, scan baseline, rescan display and keyboard focus. Duplicate matching, permissions, the read-only model, and the theme and cache storage keys are unchanged; valid v1.3.0 caches load without migration.

### Fixed

- The toolbar badge is now set on the scanned tab instead of globally, so other tabs and playlists no longer show a previous scan's duplicate count.
- Playlist metadata fetched while connecting is reused as the scan baseline only for 30 seconds. A long-open **Open in a window** window no longer fails with `INCOMPLETE` when the playlist was edited before **Scan** was clicked.
- A rescan keeps the previous completed results, search and sort visible (marked busy) until it completes, instead of clearing them for the length of the scan. **Clear results** is unavailable while a scan runs.
- Keyboard focus moves from **Scan** to **Cancel scan** when a scan starts and back to **Scan** when it completes, fails or is cancelled, and after **Retry connection**, instead of falling to the page body.

## [1.3.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.3.0) (2026-11-10)

Quality and compatibility release. This integrates six coordinated improvement areas: MusicKit compatibility, scan accuracy, UI/accessibility, results/caching lifecycle, security/privacy, and testing/performance. Permissions and the read-only model are unchanged. Existing v1.2.5 theme choices and valid cached scans remain readable without migration.

### Added

- Catalog-playlist scanning with the visible storefront, and rejection of a same-ID route change to another storefront.
- A bounded MusicKit readiness wait, raw/nested response-envelope support, nested Retry-After handling, and explicit rejection of malformed bridge requests.
- Cache freshness now compares every marker available on both sides plus the known track total; a differing revision hash marks the result stale even when the modification date matches.
- Failed, cancelled, or mid-scan-close rescans keep the last completed result, Clear action and toolbar badge visible, labelled explicitly as the previous completed scan.
- Accessibility and presentation improvements: wrapped result counts, bounded expandable position lists with focus retention and ARIA state, automatic text direction for names, omitted empty artist lines, themed placeholder contrast, forced-colors button boundaries, and outlined result actions.
- A dependency-free in-page accessibility audit, fixture network-origin allowlist, render/restore measurements, and a benchmark covering reader/pagination, matching, CSV, filter/sort, retained heap and cancellation.
- Clean-rebuild ZIP reproducibility, ZIP entry-name validation, and rejection of unexpected build files.

### Changed

- An empty page immediately after a promised continuation now fails as truncated/incomplete instead of completing successfully.
- Cache validation enforces one ascending unique position per copy, unique identities, total/copy bounds, valid playlist IDs/timestamps, bounded text and notes; corrupt entries are discarded.
- CSV formula neutralization now covers leading whitespace, control/format characters, Unicode separators, BOM, fullwidth triggers and U+2212.
- Cross-context replies and track entries must be plain records; the bridge rejects unknown actions, invalid playlist kinds, overlong IDs and non-array error envelopes.
- Wrapper and body pagination evidence must agree; conflicting totals or continuation links fail as incomplete instead of allowing a shorter body to hide more entries.
- Raw response body consumption stays inside the cancellation, timeout and route guards, the visible route is checked again after parsing, and an abort-rejecting body preserves the cancellation/timeout reason instead of becoming a generic format error.
- Unexpected error logging records a stable error label rather than provider text or raw thrown values.
- The v1.2.5 theme key and last-scan cache key/schema remain unchanged; valid v1.2.5 caches load without migration, while malformed entries are rejected.
- The CI workflow runs the benchmark on the Node 24 Linux and Windows jobs.

### Fixed

- A failed or cancelled rescan no longer erases the visible last successful result or badge.
- Copy and CSV keep the cached playlist name when MusicKit is unavailable.
- Clearing results during the initial connection can no longer resurrect a “Showing last scan” status.
- Search/filter changes no longer write a duplicate live-region message.
- Expanding a very large position list no longer drops keyboard focus or grows the document by thousands of pixels.
- The footer separator hides with **Open in a window**, and the results title no longer clips at compact widths.
- Synchronous scripting and cancellation-injection failures are classified like asynchronous failures.
- The benchmark/test harness is less prone to load-related waits, and the installed-extension popup target detection is more precise.

## [1.2.5](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.2.5) (2026-11-08)

Feature release since v1.2.0: a toolbar badge and per-song copy, a pop-out window, stale-scan detection, and reliability, accessibility and performance work. Permissions are unchanged.

### Added

- Show the number of repeated songs on the toolbar badge after a scan; **Clear results** removes it.
- Copy a single song's positions from its result row.
- Filter results by minimum copies (2+, 3+, 4+ or 5+).
- **Open in a window** keeps the popup, and any running scan, alive when focus moves elsewhere.
- Cached results now report when the playlist changed since the scan.

### Changed

- The empty results state offers **Clear search and filters**, `/` focuses search and Escape clears it, and clearing results returns focus to the scan button.
- Search matching is locale-independent, so Turkish (and similar) locales no longer break `I`/`i` matching.
- Progress and result counts announce through dedicated, throttled live regions instead of re-reading the whole status block on every update.
- Search, sort and filter controls use a border colour that meets the 3:1 contrast requirement in both themes.
- Clearing results resets the sort and filter together, and a scan with no duplicates reports "No duplicate songs found."
- CSV downloads start with a UTF-8 BOM so Excel reads non-ASCII names correctly.
- The scan button reads **Scan again** once a scan has completed, and the completion time is shown with the result.
- The first scan after opening the popup reuses the connection metadata, removing one Apple Music round trip.
- The local cache holds a full 50,000-track result set (raised from 2 MB to 4.5 MB).
- Large position lists render about twenty times faster by reusing one number formatter.
- Playlist detection now parses route segments and matches the playlist ID, so extra name or view segments, a plural `playlists` path and trailing slashes no longer break detection.
- A scan that is clearly too slow to finish within the deadline now stops early instead of running the full ten minutes, using the fastest recent page so one retry sleep cannot trigger it early.

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
