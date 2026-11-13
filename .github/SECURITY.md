# Security policy

Only the latest release, currently 1.4.2, receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's advisory form](https://github.com/awishtodiexz/Apple-Music-duplicate-finder/security/advisories/new), not in a public issue.

Include the extension version, what an attacker could do, and steps to reproduce using made-up data. Never include passwords, cookies, tokens or the contents of your own playlists.

This is a small project, so there's no guaranteed response time, but reports are taken seriously.

## Scope

The extension reads playlists through the Apple Music tab you already have open, using only the `activeTab` and `scripting` permissions. It has no server and sends nothing anywhere. Issues that break those guarantees are in scope.
