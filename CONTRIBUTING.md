# Contributing

Thanks for helping improve Apple Music Duplicate Finder.

## Before you begin

Check existing issues before opening a duplicate report. For new functionality, start a discussion in an issue so the project can stay small, reliable, and easy to maintain.

## Local setup

Supports Node.js 22 (22.8+), 24, and 26 with npm. Browser tests use Playwright's pinned Chromium; see [development instructions](docs/DEVELOPMENT.md).

```sh
npm ci
npx --no-install playwright install chromium
npm run check
npm run audit
```

To test an unpacked build, enable Developer mode in your browser's Extensions page and load the generated `dist/` directory.

## Pull requests

- Keep changes focused and explain the problem they solve.
- Add regression tests for changes to playlist retrieval, song matching, or error handling.
- Preserve the read-only design and native toolbar popup. Do not introduce playlist writes, credential interception, unnecessary browser permissions, or a side panel as part of a maintenance change.
- Run `npm run check` before submitting.
- Avoid unrelated formatting changes and new dependencies unless justified.
- Do not add private playlist data, screenshots containing account details, tokens, cookies, or other personal information to tests, issues, or pull requests.

## Bug reports

Include your browser/version, extension/version, steps to reproduce, expected behavior, and actual behavior. Redact personal and account information from screenshots and logs. For security vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than posting exploit details publicly.

For versioning, release checks, artifacts, and publication, follow the [release checklist](docs/RELEASING.md).
