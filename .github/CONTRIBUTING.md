# Contributing

Thanks for helping out. This project is meant to stay small, so for anything bigger than a bug fix, please open an issue first to talk it through.

## Getting started

See [DEVELOPMENT.md](../docs/DEVELOPMENT.md) for setup. Before opening a pull request, run:

```sh
npm run check
```

## Guidelines

- Keep pull requests focused on one change.
- Add a test when you change how playlists are read, how songs are matched, or how errors are handled.
- The extension stays read-only and keeps its two permissions (`activeTab`, `scripting`). Changes that write to playlists or need broader access won't be accepted.
- Don't commit build output (`dist/`, `artifacts/`) or anything from your own Apple Music account: playlist data, screenshots, tokens or cookies.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
