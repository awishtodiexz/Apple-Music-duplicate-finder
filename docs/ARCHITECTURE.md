# How it works

Apple Music Duplicate Finder is a Manifest V3 browser extension built with TypeScript and plain HTML/CSS. It has no backend, database, telemetry, or persistent content script.

## Reading playlists

When the user opens the popup on an Apple Music playlist, the extension identifies the visible playlist URL. It executes a small self-contained function in the page's MAIN world using Chrome's `scripting` API, so it can call the already initialized MusicKit instance in that Apple Music tab.

The MusicKit bridge makes only read requests. It extracts allowlisted track metadata, not account credentials or authentication tokens, and returns serializable results to the popup. Playlist data remains in browser memory.

Track pages are retrieved sequentially, preserving every occurrence and one-based playlist position. The reader validates pagination, returned counts when available, and playlist metadata before accepting a scan. A failed or detectably incomplete scan is rejected.

The bridge prefers MusicKit v3 `api.music()` with an explicit GET method and supports older `api.get()` instances. It never switches APIs to retry a failed request. Each read has a 25-second timeout. Only the visible playlist route is authoritative; playlist names and the playback queue are never used to select a different playlist.

Pages contain at most 100 entries. Continuation URLs must name the same Apple endpoint with a contiguous offset. Without continuation information or a total, the reader probes subsequent offsets until a well-formed empty page, including after short pages and exact page boundaries. It checks available totals, name, and modification markers again at the end. The 10,001-page safety bound produces an error, never a truncated success.

## Exact duplicate matching

The detector groups entries only when they share a reliable identity, preferring typed catalog-song identifiers. Conservative typed library-song IDs are used as a fallback when they can be matched unambiguously. Identical titles do not establish identity. Conflicts and unknown IDs do not produce speculative matches.

The detector is approximately O(n) in the number of playlist entries. Large result lists are displayed in batches to keep the popup usable.

Catalog IDs come from `playParams.catalogId`, typed `songs` resources, or typed catalog relationships. Library fallback requires a `library-songs` resource with an `i.…` ID. Arbitrary playlist-entry IDs and music-video IDs are excluded. The matcher first resolves library-to-catalog mappings across the full scan; conflicting mappings never connect different catalog songs. Results retain first-appearance order, with 50 groups rendered per batch.

## Browser permissions and privacy

The extension requests `activeTab` and `scripting` only. Temporary tab access is granted after the user invokes the extension. No passwords, cookies, developer/user tokens, or browser profiles are read or persisted. The popup treats song metadata as text, not HTML. No requests are made to a developer-operated server.

## Known limitations

- Song editions with different catalog IDs remain separate, even if their titles match.
- Entries without reliable IDs are excluded from matching.
- Without a total supplied by Apple, completion is based on API pagination exhaustion rather than independent count verification.
- Concurrent same-count playlist edits may not be detected if Apple does not expose a modification marker.
- The API does not provide an atomic snapshot. Navigation away and back between route checks may also escape detection.
- Closing the popup discards the current scan.
- Apple may change its web-player MusicKit API; this integration is unofficial.
- The extension **does not edit or delete** songs or playlists.

If MusicKit is unavailable or returns an unsupported format, scanning stops with an error. There is no scraping or credential-copying fallback.

## Source map

| File | Responsibility |
| --- | --- |
| `src/playlist-url.ts` | Parse the active playlist route |
| `src/musickit-bridge.ts` | Read-only MusicKit adapter in page context |
| `src/browser-source.ts` | Browser scripting transport |
| `src/playlist-reader.ts` | Pagination and completeness checking |
| `src/duplicates.ts` | Exact duplicate grouping |
| `src/popup.ts` | Popup state, status, and rendering |
| `src/errors.ts`, `src/types.ts` | Error handling and shared types |
