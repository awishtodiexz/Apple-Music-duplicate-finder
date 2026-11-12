# Changelog

## [1.4.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.4.0) (2026-11-12)

### Fixed

- The toolbar badge now only appears on the tab that was scanned, instead of on every tab.
- A popup left open in its own window no longer fails with `INCOMPLETE` after the playlist was edited before scanning.
- Previous results, search and sort stay visible during a rescan instead of disappearing until it finishes.
- Keyboard focus moves between **Scan** and **Cancel scan** instead of getting lost.
- A successful scan no longer shows a technical consistency note. The warning only appears when Apple provides no modification marker.

## [1.3.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.3.0) (2026-11-10)

### Added

- Support for catalog playlists, using the storefront from the playlist URL.
- A failed or cancelled rescan keeps the last completed result on screen, clearly labelled.
- Accessibility improvements: proper text direction for song names, better contrast, forced-colors support and expandable position lists that keep focus.

### Changed

- Stricter checks on Apple's responses. Truncated or inconsistent pages now fail the scan instead of passing silently.
- The cached scan is marked stale if the playlist's version or track count changed.
- CSV export guards against spreadsheet formula injection in more cases.

### Fixed

- Copy and CSV keep the playlist name when MusicKit is unavailable.
- Clearing results while the popup connects no longer brings them back.
- Expanding a huge position list no longer drops focus or stretches the popup.
- Layout fixes for the footer and the results title at narrow widths.

## [1.2.5](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.2.5) (2026-11-08)

### Added

- Duplicate count on the toolbar badge.
- Copy a single song's positions.
- Filter results by minimum copies.
- **Open in a window**, so a scan survives the popup losing focus.
- Cached results tell you when the playlist has changed since the scan.

### Changed

- `/` focuses search and Escape clears it.
- CSV files include a BOM so Excel reads non-English names correctly.
- The cache now fits a full 50,000-song scan.
- Faster rendering of long position lists.
- More tolerant playlist URL detection.
- Scans that clearly can't finish in time stop early.

### Fixed

- Cached results stay visible when Apple Music can't be reached.
- The badge no longer carries over to a different playlist.
- Search no longer breaks on Turkish and similar locales.

## [1.2.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.2.0) (2026-11-08)

### Added

- Theme switch: Auto, Light or Dark.
- Search, sort, copy and CSV export for results.
- The last completed scan is restored when you reopen the popup.
- Extra-copy counts, collapsible position lists, and error codes for bug reports.

### Changed

- `Retry-After` from Apple is respected when retrying.

### Fixed

- Unexpected errors are no longer reported as network failures.

## [1.1.2](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.2) (2026-11-07)

- Retry network errors, timeouts and rate limits instead of failing the whole scan.
- Time out a stuck page after 30 seconds instead of waiting forever.
- Raise the scan limit from five to ten minutes.
- Fix playlist detection for URLs with a trailing slash.
- Fewer screen-reader announcements while a scan is running.
- Tighter content security policy and a smaller bundle.

## [1.1.1](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.1) (2026-11-05)

- Use the playlist's own storefront for catalog playlists.
- Fix "1 more songs" wording.
- Tighter content security policy.

## [1.1.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.1.0) (2026-10-27)

- Cancel a running scan.
- Scan limits and protection against late responses.
- Warnings when Apple can't confirm the playlist didn't change during a scan.
- Reproducible release ZIPs with SHA-256 checksums.

## [1.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.0) (2026-10-24)

First release.
