# Development

## Setup

You need Node.js 22.8+, 24 or 26.

```sh
git clone https://github.com/awishtodiexz/Apple-Music-duplicate-finder.git
cd Apple-Music-duplicate-finder
npm ci
npx playwright install chromium
```

Run `npm run build`, then load `dist/` from `chrome://extensions` with **Load unpacked**. After changing code, rebuild and click **Reload**.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and build the extension into `dist/` |
| `npm test` | Unit tests |
| `npm run test:browser` | Popup tests in Chromium against a mocked Apple Music page |
| `npm run test:extension` | Installs the real built extension in a fresh Chromium profile and drives the toolbar popup |
| `npm run test:package` | Builds the release ZIP and checks its contents, checksum and reproducibility |
| `npm run check:security` | Checks permissions, CSP and the built file list, and scans for leaked credentials |
| `npm run check:docs` | Checks that version numbers agree across files |
| `npm run check` | Runs all of the above |
| `npm run benchmark` | CPU timings for reading, matching and CSV at 1k, 10k and 50k tracks |
| `npm run audit` | `npm audit`, failing at high severity and above |

The browser tests use mocked responses, so no Apple Music account is needed. Set `CHROMIUM_PATH` to use a different browser for `test:browser`. CI runs the unit tests on every supported Node version and the full check on Linux and Windows.

## Repository layout

```
src/       extension source (TypeScript)
public/    manifest, popup HTML/CSS and icons, copied into dist/
tests/     unit tests
scripts/   build, packaging and browser test scripts
assets/    icon source and the INSTALL.txt bundled in the ZIP
docs/      this file, the architecture notes and README screenshots
```

## Releasing

1. Bump the version in `package.json` and `public/manifest.json`, then run `npm install` to update the lockfile.
2. Update the version in `README.md`, `assets/INSTALL.txt`, `.github/SECURITY.md` and the bug report template, and add a `CHANGELOG.md` entry. `npm run check:docs` will tell you if you missed one.
3. Run `npm run check` and `npm run audit`, then merge through a pull request.
4. Tag the merged commit (`vX.Y.Z`), run `npm run package`, and attach `artifacts/apple-music-duplicate-finder-vX.Y.Z.zip` and its `.sha256` file to a GitHub release.

Never replace assets on a published release; ship a new version instead.

## Verify a download

Put the ZIP and its `.sha256` file in the same folder, then run:

```sh
# Linux
sha256sum --check apple-music-duplicate-finder-v1.4.2.zip.sha256

# macOS
shasum -a 256 --check apple-music-duplicate-finder-v1.4.2.zip.sha256
```

```powershell
# Windows
(Get-FileHash apple-music-duplicate-finder-v1.4.2.zip -Algorithm SHA256).Hash -ieq (Get-Content apple-music-duplicate-finder-v1.4.2.zip.sha256).Split(' ')[0]
```
