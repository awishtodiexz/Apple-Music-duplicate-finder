# Verification and known limitations

The automated test suite covers exact-ID matching, identifier conflicts, pagination, errors, incomplete scans, large playlists, and popup behavior. Browser fixture tests exercise the extension UI and MusicKit adapter with **mocked** Apple Music responses, including legacy and v3 API surfaces.

Run all available local checks:

```sh
npm run check
npm run package
```

For 1.0 the suites contain 47 core tests and 40 browser fixture scenarios across the legacy and v3 MusicKit APIs. They cover failed HTTP response wrappers, failures after partial retrieval, exact page boundaries, 10,000-entry matching, safe text rendering, recovery, result batching, keyboard focus, icon dimensions, and scrolling at popup sizes down to 300 × 300 in both color schemes. The fixtures use a Chrome API adapter; they do not install the extension or verify toolbar permission grants.

## Live compatibility

The project has been reported working in a real Chrome session with a 1,200-track Apple Music playlist. This is useful evidence for that session, but does not guarantee compatibility with every account, browser, region, or playlist format. Edge and other Chromium browsers should be tested separately.

Known limitations:

- The Apple Music web player may change its MusicKit interface.
- Identical recordings with different catalog IDs may not be matched.
- Tracks without reliable IDs are excluded from duplicate matching.
- API completeness cannot always be independently verified if Apple supplies no total.
- Concurrent same-count playlist edits can escape detection when modification metadata is unavailable.
- Closing the popup discards the current scan; re-open it to start again.
- The extension finds duplicates but does not delete songs.

When filing bugs, redact account identifiers, tokens, cookies, private playlist URLs, and personal information.
