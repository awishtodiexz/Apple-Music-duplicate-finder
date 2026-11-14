# Changelog

## [1.6](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.6) (2026-11-14)

- Simplify the popup into results, cleanup, and fresh-scan verification views, with one main extra-copy count, expandable song positions, and secondary tools in disclosures.
- Start scans in a separate window by default, with a saved option to scan in the toolbar popup.
- Add a removal checklist ordered from the highest playlist position to the lowest, with checkmarks and scan timestamps.
- Compare successful rescans with the previous completed scan, showing extra-copy changes, new repeated songs, and songs no longer repeated.

## [1.5.1](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.5.1) (2026-11-14)

- Keep catalog playlist results and pop-out connections scoped to their storefront.

## [1.5](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.5) (2026-11-14)

### Added

- **Show all** reveals the rest of long results, up to 2,000 songs per press.

### Changed

- Clearer titles after a scan: **No repeated songs**, **This playlist is empty** and **Nothing could be checked**.
- Plainer messages throughout.
- A slow Apple Music response shows **Retrying (1 of 2)…** progress.
- A more compact results list shows more songs at once. Each row reads `3 copies · 2 extra` and shows which position is kept, such as `#1 keep · #101 · #245`.
- A note says that songs are matched by Apple Music ID, not title. Same-title songs that are different Apple Music songs are labeled as such.
- **Copy all N** and **CSV (N)** say how many songs they export. The warning for results that are too large to keep names the same actions.
- Search, sort and export stay at the top of the popup while you scroll.
- Per-song **Copy** confirms on the row.
- Copied text uses the same one-line summary as the popup.
- **Cancel scan** is an outlined button.
- Control borders have stronger contrast, the scan button is easier to spot in high-contrast mode, and button and text sizes are more consistent.
- The playlist name can be expanded by keyboard or touch.

### Fixed

- The toolbar popup is always its full 380px width, instead of sometimes opening narrow and cramped.
- A page that is not a playlist shows a neutral **Open a playlist** state instead of an error and a useless retry.
- A playlist over 50,000 songs says so before scanning, with no scan button.
- The button always matches the message: **Retry scan**, **Retry connection**, or no button when retrying cannot help.
- A connection error next to your last scan is shown on its own line, below the summary.
- Screen readers hear the start of a scan right away.
- A pop-out window follows its Apple Music tab when the tab changes page or closes, and recovers after an over-limit playlist is trimmed.
- **Cancel scan** no longer offers **Retry scan**.
- Focused rows are no longer hidden under the sticky toolbar.

## [1.4.2](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.4.2) (2026-11-13)

### Changed

- Each repeated song shows a compact **3 copies** badge and its positions as `#1 · #101 · #245`, instead of two full sentences.
- The toolbar's copy button is now **Copy list**, so it no longer looks like each song's **Copy**. **Copy list** and **CSV** use neutral colors, leaving the accent color for **Scan again**.
- **Clear results**, **Copy** and **Show all positions** are smaller outlined buttons, and links are no longer underlined outside of sentences.
- The search field has a search icon, and both dropdowns have matching arrows.

## [1.4.1](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.4.1) (2026-11-12)

### Changed

- A successful scan no longer shows a technical consistency note. The warning only appears when Apple provides no modification marker.
- Shorter, clearer `INSTALL.txt` in the download.
- Rewritten README and documentation.

## [1.4.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.4.0) (2026-11-12)

### Fixed

- The toolbar badge now only appears on the tab that was scanned, instead of on every tab.
- A popup left open in its own window no longer fails with `INCOMPLETE` after the playlist was edited before scanning.
- Previous results, search and sort stay visible during a rescan instead of disappearing until it finishes.
- Keyboard focus moves between **Scan** and **Cancel scan** instead of getting lost.

## [1.3.0](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/releases/tag/v1.3.0) (2026-11-10)

### Added

- Support for catalog playlists, using the storefront from the playlist URL.
- A failed or cancelled rescan keeps the last completed result on screen, clearly labeled.
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
