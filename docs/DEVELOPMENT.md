# Building and testing

## Requirements

- Node.js 22.8 or newer (Node.js 24 LTS recommended)
- npm
- Chromium-based desktop browser for manual testing
- A local Chromium executable for browser fixture tests

## Commands

```sh
npm ci
npm run build
npm test
npm run test:browser
npm run package
```

`npm run check` runs the build and automated test suites. `npm run package` creates an extension ZIP under `artifacts/`.

The browser fixture runner defaults to `/usr/bin/chromium`; set `CHROMIUM_PATH` when necessary. Its mocked tests do not prove compatibility with every authenticated Apple Music session.

On Linux or macOS, for example: `CHROMIUM_PATH=/path/to/chromium npm run test:browser`. In PowerShell, use `$env:CHROMIUM_PATH = 'C:\path\to\chrome.exe'` before running the command. Use an installed Chromium browser executable. The fixture runner creates an isolated headless browser context; it does not use your signed-in browser profile.

## Install a local build

Load `dist/` from the browser's Extensions page with Developer mode enabled. Reload the extension after rebuilding. Do not hand-edit generated files.

## Release checklist

1. Ensure `package.json`, `package-lock.json`, and `public/manifest.json` use the same version.
2. Update `CHANGELOG.md` with user-relevant changes.
3. Run `npm run check` and `npm run package`.
4. Inspect the ZIP: it should contain `manifest.json`, `popup.html`, `popup.css`, `popup.js`, icons, `LICENSE`, and `INSTALL.txt`.
5. Check that no account information, local browser profiles, secrets, or generated test artifacts are committed or included in the release ZIP.
6. Publish the tested ZIP as an asset of a GitHub release matching the version.
7. Download the uploaded asset and verify that it matches the tested package.

`INSTALL.txt` is the single source for the installation instructions included in the ZIP. Keep it focused on installation, updates, and usage. Build output, test screenshots, dependencies, and ZIPs are ignored by Git. `private: true` in `package.json` prevents accidental npm publication; it does not control GitHub visibility or the MIT license.

A GitHub source-code ZIP is not interchangeable with the prebuilt extension ZIP.
