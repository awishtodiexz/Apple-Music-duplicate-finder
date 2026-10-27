# Release checklist

Releases are prepared from reviewed source, merged through a pull request, and published manually after authorization. GitHub Actions verifies builds and packages but never publishes a release.

## Prepare and validate

1. Fetch `origin` and inspect `main`, the feature branch, existing tags, and GitHub releases. If the intended version already exists, stop; never replace a published tag or release asset.
2. Update the version in `package.json`, the root and project entries of `package-lock.json`, and `public/manifest.json`. Update README downloads, the changelog, security support information, installation instructions, and release notes in `docs/releases/`.
3. Run `npm ci`, install the locked Chromium browser, then run `npm run check` and `npm run audit`. Validate `.github/workflows/ci.yml` with `actionlint`. Check every supported Node major, including the stated minimum where practical.
4. Review the complete diff from the previous release. Confirm the duplicate matcher, native toolbar popup, styling, safe text rendering, and minimal permissions are preserved. Inspect the exact staged file list and exclude caches, browser profiles, temporary files, account data, and credentials.
5. Commit and push the feature branch without force-pushing. Open a pull request against `main` with the change summary, executed checks, and known limitations. Resolve failures and wait for all required checks before merging; do not bypass protections.

## Package the merged source

1. Fetch after merging and confirm the final `origin/main` commit. Build from that exact commit with a clean worktree. If main advanced with unrelated work, review and validate the actual release commit before proceeding.
2. Run `npm ci`, `npm run check`, and `npm run audit` on the merged source. The package test compares every ZIP entry with the build/source, verifies its SHA-256 sidecar, rejects tampering, and checks repeated packaging for identical bytes.
3. For v1.1.0 the only release attachments are:

   - `apple-music-duplicate-finder-v1.1.0.zip`
   - `apple-music-duplicate-finder-v1.1.0.zip.sha256`

4. The ZIP contains `manifest.json`, `popup.html`, `popup.css`, `popup.js`, four icons, `LICENSE`, and `INSTALL.txt`. It must not contain tests, screenshots, profiles, caches, development dependencies, or credentials. The generated manifest must report `1.1.0`, retain only `activeTab` and `scripting`, and use `action.default_popup` without a side panel.

## Tag and publish

1. Recheck that neither the `v1.1.0` tag nor release exists. Create an annotated tag at the verified merged commit and push that tag normally.
2. Create a draft release titled **Apple Music Duplicate Finder v1.1.0**, using `docs/releases/v1.1.0.md`. When copying notes to GitHub, use the public repository URL for relative documentation links so they resolve from the release page.
3. Upload both verified files while the release is a draft. Confirm their names, sizes, and contents. Publish the release as the latest stable release, not a prerelease. Do not publish to an extension marketplace.
4. Download both public attachments into a separate directory, verify their checksum and byte equality with the tested package, and confirm the tag resolves to the final merged commit. Verify the README, changelog, release notes, required checks, and `main` synchronization. Never silently overwrite an existing release to fix a failed verification.

Published release tags and assets remain unchanged. Corrections require a new version. A checksum sidecar detects corruption but is not a cryptographic signature or independent authentication of the publisher.

## Verify a download

Download the ZIP and its `.sha256` file into the same directory.

Linux:

```sh
sha256sum --check apple-music-duplicate-finder-v1.1.0.zip.sha256
```

macOS:

```sh
shasum -a 256 --check apple-music-duplicate-finder-v1.1.0.zip.sha256
```

PowerShell:

```powershell
$expected = (Get-Content -LiteralPath './apple-music-duplicate-finder-v1.1.0.zip.sha256').Split(' ')[0]
$actual = (Get-FileHash -LiteralPath './apple-music-duplicate-finder-v1.1.0.zip' -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw 'SHA-256 mismatch' }
Write-Output 'SHA-256 verified'
```
