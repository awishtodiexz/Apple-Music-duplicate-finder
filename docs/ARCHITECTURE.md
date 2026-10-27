# How it works

Apple Music Duplicate Finder is a Manifest V3 browser extension built with TypeScript and plain HTML/CSS. It has no backend, database, telemetry, or persistent content script.

## Reading playlists

When the user opens the popup on an Apple Music playlist, the extension identifies the visible playlist URL. It executes a small self-contained function in the page's MAIN world using Chrome's `scripting` API, so it can call the already initialized MusicKit instance in that Apple Music tab.

The MusicKit bridge makes only read requests. It extracts allowlisted track metadata, not account credentials or authentication tokens, and returns serializable results to the popup. Playlist data remains in browser memory.

Track pages are retrieved sequentially, preserving every occurrence and one-based playlist position. The reader validates pagination, returned counts when available, and playlist metadata before accepting a scan. Failed requests or detected inconsistencies invalidate the scan; partial results are discarded.

The bridge prefers MusicKit v3 `api.music()` with an explicit GET method and supports older `api.get()` instances. It never switches APIs to retry a failed request. Each read waits up to 25 seconds. For v3, an AbortSignal is passed through `fetchOptions`; cancellation and timeout request an abort when that player implementation supports it. Legacy or signal-ignoring implementations may finish the request in the page, but late replies and failures cannot advance the cancelled scan or update a later scan. Only the visible playlist route is authoritative; playlist names and the playback queue are never used to select a different playlist.

Pages contain at most 100 entries. Continuation URLs must name the same playlist's track endpoint with a contiguous offset. When a page has no continuation link, the reader stops if it has reached the reported total. Otherwise, it probes the next offset, even after a short page or an exact page boundary. With no reported total, a well-formed empty page marks exhaustion. An empty page before a known total is reached fails the scan. The reader checks available totals, name, modification date, and optional `playParams.versionHash` again at the end. Changed or lost initial markers invalidate the scan.

The reader enforces a five-minute overall deadline, 50,000 entries, 2,000 pages, and 16 million retained metadata characters. These limits include validation and cannot be raised by a caller. Exceeding a limit, cancelling, timing out, or failing discards the scan; no partial results are displayed as success. Progress includes retrieved counts, elapsed time at each page, and the final validation phase.

Cancellation propagates from the popup through an AbortController. A separate MAIN-world injection dispatches an event scoped by a random per-request UUID; listeners are removed on completion. The transport and reader independently stop awaiting cancelled operations. The browser transport validates the shape and bounded fields of replies at runtime. The event conveys no credentials or playlist metadata and grants no extra permission.

## Exact duplicate matching

The detector groups entries only when they share a reliable identity, preferring typed catalog-song identifiers. Conservative typed library-song IDs are used as a fallback when they can be matched unambiguously. Identical titles do not establish identity. Conflicts and unknown IDs do not produce speculative matches.

The detector is approximately O(n) in the number of playlist entries. Large result lists are displayed in batches to keep the popup usable.

Tracks remain bounded in memory until validation completes. Incremental final grouping was deliberately avoided: later library-to-catalog mappings and conflicts can change earlier identities. Retaining the existing two-pass matcher preserves those rules, and there is no extra copy of the full raw API response. Results still render in batches of 50.

Catalog IDs come from `playParams.catalogId`, typed `songs` resources, or typed catalog relationships. Library fallback requires a `library-songs` resource with an `i.…` ID. Arbitrary playlist-entry IDs and music-video IDs are excluded. The matcher first resolves library-to-catalog mappings across the full scan; conflicting mappings never connect different catalog songs. An entry with its own unambiguous catalog ID can still match by that ID, even when its library mapping conflicts. Results retain first-appearance order, with 50 groups rendered per batch.

## Browser permissions and privacy

The extension requests `activeTab` and `scripting` only. Temporary tab access is granted after the user invokes the extension. No passwords, cookies, developer/user tokens, or browser profiles are read or persisted. The popup treats song metadata as text, not HTML. No requests are made to a developer-operated server.

## Known limitations

- Song editions with different catalog IDs remain separate, even if their titles match.
- Entries without reliable IDs are excluded from matching.
- Without a total supplied by Apple, completion is based on API pagination exhaustion rather than independent count verification.
- Concurrent same-count playlist edits may not be detected if Apple does not expose a modification marker.
- A matching modification marker is a consistency check, not proof of an atomic snapshot. Optional version hashes are observed on some resources, not a guaranteed revision mechanism for every playlist. The popup warns in both cases, and highlights when no marker was available.
- The API does not provide an atomic snapshot. Navigation away and back between route checks may also escape detection.
- The native toolbar popup closes when focus is lost, including clicking outside it. Closing it discards the current scan. v1.1.0 retains this behavior and does not add a side panel.
- Apple may change its web-player MusicKit API; this integration is unofficial.
- The extension **does not edit or delete** songs or playlists.

If MusicKit is unavailable or returns an unsupported format, scanning stops with an error. There is no scraping or credential-copying fallback.

## Source map

| File | Responsibility |
| --- | --- |
| [playlist-url.ts](../src/playlist-url.ts) | Parse the active playlist route |
| [musickit-bridge.ts](../src/musickit-bridge.ts) | Read-only MusicKit adapter in page context |
| [browser-source.ts](../src/browser-source.ts) | Browser scripting transport |
| [playlist-reader.ts](../src/playlist-reader.ts) | Pagination and completeness checking |
| [duplicates.ts](../src/duplicates.ts) | Exact duplicate grouping |
| [popup.ts](../src/popup.ts) | Popup state, status, and rendering |
| [errors.ts](../src/errors.ts), [types.ts](../src/types.ts) | Error handling and shared types |
