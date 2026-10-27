# Dependency security and compatibility

The extension has no production npm dependencies or remote runtime scripts. Development dependencies build, type-check, package, and test it. Commit `package-lock.json`; use `npm ci` for reproducible installations.

The implementation review updated esbuild from 0.25.12 to 0.28.2 and Chrome typings from 0.1.43 to 0.3.6. Node typings now target Node 22, the oldest supported major. The unit runner uses esbuild and Node's own isolated test runner, removing tsx and its loader/runtime dependency surface. fflate remains pinned at 0.8.3, Playwright resolves to 1.64.1, and TypeScript stays on compatible 5.9.3 rather than crossing a major solely for novelty.

Run `npm run audit` to audit every locked dependency, including development and optional packages. The implementation-time audit reported zero advisories; this is a point-in-time result, not a permanent safety guarantee. There are no accepted advisory exceptions or ignored vulnerabilities in the project.

The weekly CI schedule repeats the audit. Dependabot checks npm packages and pinned GitHub Actions weekly and opens reviewable pull requests. For each update, inspect upstream release notes and advisories, update the lockfile through npm, then run `npm run check` and `npm run audit`. Keep the action pins at reviewed full commit SHAs and verify they belong to the official upstream repository.

Static security checks enforce the exact built-file allowlist, manifest permissions, CSP, safe rendering/network invariants, and selected current-file credential patterns. They never print matched secret values. They are not a full secret-history scanner or a substitute for code review.

ZIPs have fixed entry ordering and timestamps and include a SHA-256 sidecar. The package test checks every decompressed file against the build/source, repeats packaging for deterministic bytes, and rejects modified checksums/archives. A sidecar detects corruption but does not authenticate the publisher. Release publication stays manual.

## Apple API evidence and limits

Apple documents `lastModifiedDate` for catalog playlists and includes optional `playParams.versionHash` values in some response examples. These are useful change indicators, but the reviewed documentation does not provide an atomic snapshot contract for all paginated library/catalog playlist reads. The extension compares available markers and always explains the residual consistency limit.

- [Apple playlist attributes](https://developer.apple.com/documentation/applemusicapi/playlists/attributes-data.dictionary)
- [Apple library playlist response examples](https://developer.apple.com/documentation/applemusicapi/get-all-library-playlists)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
- [Node 22.8 CLI options](https://nodejs.org/download/release/v22.8.0/docs/api/cli.html)
