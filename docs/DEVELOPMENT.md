# Building and testing

## Requirements

- Node.js 22 (22.8+), 24, or 26 and npm. Use a current patched release; Node.js 24 is a suitable default. Odd-numbered and future major versions are not declared supported.
- Git to clone the repository, or an extracted GitHub source archive.
- A desktop Chromium browser for manual testing. Automated tests use the full Chromium browser pinned by the Playwright lockfile.

## Setup

```sh
git clone https://github.com/awishtodiexz/Apple-Music-duplicate-finder.git
cd Apple-Music-duplicate-finder
npm ci
npx --no-install playwright install chromium
```

If you downloaded the source archive, open a terminal in the extracted project folder and start with `npm ci`.

Both browser suites default to Playwright's bundled full Chromium. On Linux CI, install its system dependencies with `npx --no-install playwright install --with-deps chromium`. Browser downloads and test profiles are separate from your signed-in browser profile.

For the UI fixture suite only, `CHROMIUM_PATH` can select an existing executable. The installed-extension smoke test deliberately uses pinned Chromium: branded Chrome and Edge no longer support the required command-line extension sideloading. See [Playwright's extension testing documentation](https://playwright.dev/docs/chrome-extensions).

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
| `npm test` | Compile TypeScript tests with esbuild and run Node's default isolated test processes; works on Node 22 without version-specific flags |
| `npm run test:browser` | Build and run the browser fixtures |
| `npm run test:extension` | Install the actual production extension in a fresh Chromium profile and exercise its real toolbar popup and permissions |
| `npm run test:package` | Build/package, inspect ZIP contents, verify SHA-256 and tamper rejection, and compare repeated packaging byte-for-byte |
| `npm run check:security` | Verify built-file/permission/CSP invariants and scan current files for selected credential patterns without printing values |
| `npm run audit` | Audit the full dependency tree, including development packages; fail on any reported vulnerability |
| `npm run check` | Build, type-check, run all three test suites, verify packaging, and run static security checks |
| `npm run package` | Build and create the installation ZIP in `artifacts/` |

The ZIP filename uses the manifest version: version `1.1.0` produces `artifacts/apple-music-duplicate-finder-v1.1.0.zip`. Its checksum is `artifacts/apple-music-duplicate-finder-v1.1.0.zip.sha256`. Historical release 1.0 used a different download filename; do not rename or replace that published asset.

New builds also generate a `.zip.sha256` sidecar. ZIP entry order and timestamps are fixed, so packaging identical build files produces identical bytes. The sidecar detects corruption; it is not a signature or independent proof of the publisher. Published release assets remain unchanged until a new release is explicitly prepared.

## Continuous integration and dependency review

The CI workflow runs on pushes, pull requests, manual dispatch, and a weekly schedule. Linux jobs exercise Node 22.8.0, current Node 22, 24, and 26; a Windows job exercises Node 24. All jobs use `npm ci`, pinned action commits, read-only repository permissions, and no persisted Git credentials. No job publishes a release or extension.

Dependabot proposes weekly npm and GitHub Actions updates. Review advisories and changelogs, update the lockfile, and run the complete checks before accepting an update. Do not automatically cross TypeScript major versions just to obtain a newer version. See [dependency security notes](DEPENDENCIES.md).

## Try a local build

After `npm run build`, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and select **Load unpacked**. Choose `dist/`. Rebuild and click **Reload** on the Extensions page after changing the code.

Keep the folder in place and edit source files rather than generated output. For checks with a real Apple Music session, follow [Testing](TESTING.md).

## Prepare a release

Follow [the release checklist](RELEASING.md). Keep package, lockfile, manifest, changelog, documentation, release notes, and filenames consistent. Validate the final merged source and the generated ZIP before tagging or publication. Publishing stays manual and requires authorization; CI never publishes a release.

[INSTALL.txt](../INSTALL.txt) supplies the installation instructions packaged in the ZIP. Build output, test screenshots, dependencies, and ZIPs are ignored by Git. `private: true` in `package.json` prevents accidental npm publication; it does not control GitHub visibility or the MIT license.

GitHub's source archive requires building before it can be loaded as an extension.
