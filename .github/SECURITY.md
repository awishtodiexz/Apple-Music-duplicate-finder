# Security policy

## Supported version

Security reports are accepted for the latest release, currently 1.4.0. This is a community project; there is no guaranteed response time.

## Reporting a vulnerability

Please **do not publish sensitive security vulnerabilities or exploit instructions in public issues**.

This repository uses GitHub private vulnerability reporting. Use the [private report form](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/security/advisories/new) or **Security → Report a vulnerability**; do not open a public issue for a sensitive report.

Never send Apple Music passwords, cookies, authorization headers, user tokens, or private playlist contents.

Include the affected extension version, the impact, and steps to reproduce using fictional data. Avoid raw MusicKit responses or network captures that may contain account information. Do not test against Apple Music accounts or playlists you do not own.

## Project security model

The extension is designed to be read-only. It uses the active Apple Music browser tab and its existing MusicKit session for playlist GET requests, then processes returned track metadata locally. It requests only `activeTab` and `scripting`, does not collect credentials, and does not use a backend or analytics. The last completed scan is cached in extension-local storage until replaced or cleared.

The integration relies on Apple Music web-player behavior that Apple may change. This project is independent and is not affiliated with Apple.
