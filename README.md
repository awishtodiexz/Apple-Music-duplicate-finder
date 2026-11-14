<div align="center">

<img src="public/icon-128.png" width="96" alt="">

# Apple Music Duplicate Finder

Find the songs that show up more than once in your Apple Music playlists.

[**Download v1.6**](https://github.com/awishtodiexz/Apple-Music-Playlist-Duplicate-Finder/releases/download/v1.6/apple-music-duplicate-finder-v1.6.zip) · [Install](#install) · [Privacy](#privacy)

[![CI](https://github.com/awishtodiexz/Apple-Music-Playlist-Duplicate-Finder/actions/workflows/ci.yml/badge.svg)](https://github.com/awishtodiexz/Apple-Music-Playlist-Duplicate-Finder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshot-dark.png">
  <img src="docs/images/screenshot-light.png" width="340" alt="Example scan showing extra copies found and the Start cleanup action">
</picture>

<small>Example scan using sample playlist data.</small>

</div>

## Features

- **Exact matches.** Songs are matched by their Apple Music ID, not by title, so different versions of a song stay separate.
- **Positions.** See every spot in the playlist where a song appears.
- **Search, sort and export.** Filter the list, copy it, or save it as CSV.
- **Read-only.** It never edits, reorders or deletes anything. You decide what to remove.
- **Remembers your last scan** and tells you when the playlist has changed since then.
- **Cleanup checklist.** Work through extra copies from the bottom of the playlist upward, then rescan to see what changed.
- **Separate scan window by default.** Clicking back into Apple Music keeps your scan running. Your window preference is saved.
- **Light and dark themes**, keyboard support, and a toolbar badge with the duplicate count.

## Install

Works in Chrome and Edge 111 or newer. It isn't on the Chrome Web Store, so you load it manually:

1. [Download the ZIP](https://github.com/awishtodiexz/Apple-Music-Playlist-Duplicate-Finder/releases/download/v1.6/apple-music-duplicate-finder-v1.6.zip) and extract it to a folder you'll keep.
2. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the extracted folder.

To update, extract the new ZIP over the same folder and click **Reload** on the extensions page.

> [!NOTE]
> Download `apple-music-duplicate-finder-v1.6.zip` from the release, not GitHub's *Source code* archive, which needs to be built first. Each release also has a `.zip.sha256` checksum if you want to [verify it](docs/DEVELOPMENT.md#verify-a-download).

## Usage

1. Open a playlist on [music.apple.com](https://music.apple.com) while signed in.
2. Click the extension icon and press **Scan for duplicates**.
3. The scan starts in a separate window, so you can click back into Apple Music while it runs. Keep that window open until it finishes. To scan in the toolbar popup instead, open **Settings** and turn off **Keep scans open in a separate window**.

The headline shows how many extra copies were found. Each song row shows how many copies to remove; expand it to see the suggested keep and extra playlist positions. Search stays visible, while **Filter, sort & export** contains the minimum-copy filter, sort order, Copy, and CSV controls.

Choose **Start cleanup** to replace the results list with all extra copies in descending position order, including songs hidden by search or filters. Use the playlist's original order. Remove copies from the highest position to the lowest so earlier positions stay valid. Checkboxes track your progress locally; they do not edit Apple Music. Rescan after reordering the playlist or making other edits.

Choose **Verify changes** to run a fresh scan. The verification view shows how many extra copies remain and what changed, with resolved song names available to expand. Choose **Continue cleanup** if extras remain, or **Done** when none remain. **Back to results** returns to the searchable song list. Failed or cancelled verification preserves your checkmarks. If either scan contains songs without usable IDs, the comparison says changes cannot be confirmed.

Scans stop after a ten-minute limit or 50,000 songs, and a failed scan never shows partial results.

### Troubleshooting

| Message | What to do |
| --- | --- |
| Open a playlist | Go to a playlist on music.apple.com and reopen the popup. |
| The Apple Music player hasn't finished loading | Wait for the player to load, then press Retry connection. |
| Sign in to Apple Music in this tab | Your Apple Music session expired. Sign in again, then press Retry connection. |

## Privacy

Everything runs in your browser. The extension talks only to Apple Music, using the session already open in your tab. No accounts, no analytics, no servers. It asks for just two permissions, `activeTab` and `scripting`, and the last scan is stored locally until you press **Clear results**.

Curious how it works? See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
npm ci
npx playwright install chromium
npm run check
```

This builds the extension into `dist/` and runs the full test suite. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for more.

## Contributing

Bug reports and pull requests are welcome. Please read the [contributing guide](.github/CONTRIBUTING.md) first, and report security issues [privately](.github/SECURITY.md).

## License

[MIT](LICENSE). Not affiliated with Apple. Apple Music is a trademark of Apple Inc.
