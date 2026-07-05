# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately via
this repository's GitHub "Report a vulnerability" (Security advisories) page, or
contact the maintainer through the profile linked in `manifest.json`. We aim to
respond within a few days.

## The Google OAuth client secret is intentionally in the source

`src/config.ts` ships a Google `client_id` and `client_secret` (a `GOCSPX-`
value). This is deliberate and is not a leak.

PaperSync authenticates to Google Drive with the OAuth 2.0 flow for installed /
desktop apps (RFC 8252): Authorization Code with PKCE, an ephemeral loopback
redirect on `127.0.0.1`, and the narrow `drive.file` scope. For this client
type, Google documents that the client secret is not confidential:

> "In this context, the client secret is obviously not treated as a secret."
> ("Installed applications", developers.google.com/identity/protocols/oauth2)

> "Installed apps are distributed to individual devices, and it is assumed that
> these apps cannot keep secrets."

The secret is embedded in every shipped build (`main.js`) by design, so moving
it to an environment variable would change nothing while breaking
`git clone && npm run build` for contributors.

### What actually protects your data

Security does not rest on the secret being hidden. It rests on:

- **PKCE (S256):** a stolen authorization code is useless without the
  per-session code verifier, which never leaves your device.
- **Loopback redirect:** the authorization code is delivered only to a local
  server on your own machine.
- **Per-user consent:** each user grants access through Google's own screen.
- **`drive.file` scope:** PaperSync can only see files it created, not your
  whole Drive.
- **Local tokens:** your refresh and access tokens live in the vault's local
  plugin data (`data.json`), which is gitignored and never transmitted to us
  (there is no PaperSync server). Guard that file as you would any credential.

### For contributors and security scanners

Automated secret scanners (including GitHub secret scanning) may flag the
`GOCSPX-` value. That is expected. The credential is intentionally public for
this client type per the Google documentation above, so such alerts are not
actionable and the secret should not be rotated reactively. Rotating it would
break token refresh for every already-installed copy until users re-authorize.
