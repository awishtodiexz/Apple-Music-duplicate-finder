# Building and testing

## Requirements

- Node.js 22.8 or newer and npm; Node.js 24 LTS is recommended.
- Git to clone the repository, or an extracted GitHub source archive.
- A desktop Chromium browser for manual testing and a local Chromium executable for browser fixture tests.

## Setup

```sh
git clone https://github.com/awishtodiexz/Apple-Music-duplicate-finder.git
cd Apple-Music-duplicate-finder
npm ci
```

If you downloaded the source archive, open a terminal in the extracted project folder and start with `npm ci`.

The browser runner defaults to `/usr/bin/chromium`. If your executable is elsewhere, set `CHROMIUM_PATH` before running `npm run check` or `npm run test:browser`.

Linux or macOS:

```sh
export CHROMIUM_PATH="/absolute/path/to/chromium"
```

PowerShell:

```powershell
$env:CHROMIUM_PATH = 'C:\path\to\chrome.exe'
```

Replace these examples with the actual executable path. The fixture runner uses an isolated headless browser context and does not use your signed-in profile. Apple Music responses are mocked; these tests require no Apple Music login.

## Commands

| Command | Result |
| --- | --- |
| `npm run build` | Type-check and build the unpacked extension in `dist/` |
| `npm test` | Run the core TypeScript tests |
| `npm run test:browser` | Build and run the browser fixtures |
| `npm run check` | Run the build and both test suites |
| `npm run package` | Build and create the installation ZIP in `artifacts/` |

The ZIP filename uses the manifest version: version `1.0.0` produces `artifacts/apple-music-duplicate-finder-v1.0.0.zip`. The GitHub release labeled **1.0** distributes that build as `apple-music-duplicate-finder-1.0.zip`.

## Try a local build

After `npm run build`, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and select **Load unpacked**. Choose `dist/`. Rebuild and click **Reload** on the Extensions page after changing the code.

Keep the folder in place and edit source files rather than generated output. For checks with a real Apple Music session, follow [Testing](TESTING.md).

## Prepare a release

1. Update `package.json`, both project version fields in `package-lock.json`, and `public/manifest.json` to the same version. Update the changelog.
2. Run `npm ci`, `npm run check`, and `npm run package`.
3. Inspect the ZIP. It should contain the manifest, popup HTML/CSS/JavaScript, four icons, `LICENSE`, and `INSTALL.txt`. Check that no credentials, account data, browser profiles, screenshots, or development files are included.
4. Commit and push the reviewed source. Create a draft GitHub release with a tag pointing to that tested commit, and attach the checked installation ZIP before publishing.
5. Publish the release, download the attached ZIP, and compare its checksum with the tested file. Confirm the README download link names the correct release asset.

Keep published tags and downloads unchanged. Publish a new version for fixes. If release immutability is enabled, the tag and assets are locked when the release is published; upload all assets while it is still a draft.

[INSTALL.txt](../INSTALL.txt) supplies the installation instructions packaged in the ZIP. Build output, test screenshots, dependencies, and ZIPs are ignored by Git. `private: true` in `package.json` prevents accidental npm publication; it does not control GitHub visibility or the MIT license.

GitHub's source archive requires building before it can be loaded as an extension.
