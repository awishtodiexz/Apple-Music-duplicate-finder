# How it works

The extension is a Manifest V3 popup written in TypeScript with plain HTML and CSS. There is no backend, content script or telemetry.

## Reading a playlist

When you open the popup on a playlist, it reads the playlist ID from the tab's URL. It then uses the `scripting` API to run a small, self-contained function in the page, which calls the MusicKit instance Apple Music has already set up. That function makes read-only requests and sends back only the track fields the extension needs, never tokens or cookies.

Tracks are fetched 100 at a time, one page after another. The reader checks that the pages line up: offsets are contiguous, continuation links point at the same playlist, and the total matches when Apple provides one. The playlist's name, modification date and version hash are checked again at the end. If anything doesn't add up, the scan fails rather than showing results that might be incomplete.

Network errors, timeouts, rate limits and 5xx responses are retried twice with backoff, honouring `Retry-After` up to 60 seconds. Other errors are not retried.

A scan is capped at ten minutes, 50,000 entries, 2,000 pages and 16 million characters of metadata. Cancelling or hitting a limit discards the scan; if there was a previous result, it stays on screen, labelled as the previous scan.

## Matching duplicates

Two entries are the same song only if they share a reliable ID:

1. The catalog song ID, from `playParams.catalogId` or a typed `songs` resource.
2. Otherwise, a library song ID (`i.…`), when it maps cleanly to a single catalog song.

Titles are never used, and entries without a usable ID are left out and counted separately. Matching is a single linear pass after all pages are read, so the library-to-catalog mapping sees the whole playlist. Results keep the order in which songs first appear and render 50 at a time.

## Storage

The last completed scan and the theme choice are kept in `localStorage` (`amdf:last-scan:v1`, `amdf:theme:v1`). The cache is size-limited, validated on load, and marked stale when the playlist's markers or track count change.

## Limitations

- Apple's API has no snapshot reads. Editing a playlist mid-scan is usually caught, but an edit that keeps the same track count may not be.
- The toolbar popup closes when it loses focus, which cancels a running scan. **Open in a window** avoids this.
- The integration relies on Apple's web player, which can change without notice.

## Source layout

| File | Purpose |
| --- | --- |
| [`popup.ts`](../src/popup.ts) | Popup state and rendering |
| [`playlist-url.ts`](../src/playlist-url.ts) | Parses the playlist route from the tab URL |
| [`musickit-bridge.ts`](../src/musickit-bridge.ts) | Read-only MusicKit calls, run inside the page |
| [`browser-source.ts`](../src/browser-source.ts) | Injects the bridge and handles cancellation |
| [`playlist-reader.ts`](../src/playlist-reader.ts) | Pagination, retries, limits and consistency checks |
| [`duplicates.ts`](../src/duplicates.ts) | Groups entries by song identity |
| [`results.ts`](../src/results.ts) | Search, sort, copy text and CSV |
| [`storage.ts`](../src/storage.ts) | Cached last scan and theme preference |
| [`theme.ts`](../src/theme.ts), [`errors.ts`](../src/errors.ts), [`types.ts`](../src/types.ts) | Shared helpers and types |
