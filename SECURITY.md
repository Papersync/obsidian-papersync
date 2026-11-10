# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately via
this repository's GitHub "Report a vulnerability" (Security advisories) page, or
email contact@papersync.ai. We aim to respond within a few days.

Fixes ship in the latest release only. Update before reporting if you can.

## The Google OAuth client secret is intentionally in the source

`src/config.ts` ships a Google `client_id` and `client_secret` (a `GOCSPX-`
value). This is deliberate and is not a leak.

Papersync authenticates to Google Drive with the OAuth 2.0 flow for installed /
desktop apps (RFC 8252): Authorization Code with PKCE, an ephemeral loopback
redirect on `127.0.0.1`, and the narrow `drive.file` scope. For this client
type, Google documents that the client secret is not confidential:

> "In this context, the client secret is obviously not treated as a secret."
> ("Installed applications", developers.google.com/identity/protocols/oauth2)

> "Installed apps are distributed to individual devices, and it is assumed that
> these apps cannot keep secrets."
> (developers.google.com/identity/protocols/oauth2/native-app)

### What actually protects your data

Security does not rest on the secret being hidden. It rests on:

- **PKCE (S256):** a stolen authorization code is useless without the
  per-session code verifier, which is sent only to Google, over TLS, when the
  code is exchanged.
- **Loopback redirect:** the authorization code is delivered only to a local
  server on your own machine.
- **Per-user consent:** each user grants access through Google's own screen.
- **`drive.file` scope:** Papersync can only see files it created, not your
  whole Drive.
- **No Papersync server:** your tokens are sent to Google and nowhere else.

### Where your sign-in token is stored

- Your Google refresh token is saved through Obsidian's `secretStorage` API.
  Papersync never writes it to `data.json`. The short-lived access token lives
  only in memory.
- Obsidian keeps its secrets in its own app data on your device, outside your
  vault, encrypted with a key that your operating system protects: the macOS
  Keychain, Windows DPAPI, or a Linux secret store such as GNOME Keyring or
  KWallet. The token itself is not an entry in those stores.
- Because that storage is device-local, the token does not travel with your
  synced vault. Connect Google Drive once per device.
- You can see the entry, named `papersync-oauth-refresh-token`, in Obsidian
  under Settings, Keychain.

Know the limits of that storage:

- **No secret store, no encryption.** If your system offers no secret store
  (some Linux setups), Obsidian stores its secrets unencrypted and shows a
  warning in its Keychain settings. Papersync cannot detect this, so check
  there if you are unsure.
- **Other plugins can read it.** Obsidian's secret storage is shared by every
  plugin in the vault. Install only plugins you trust.
- **Other programs on Windows.** DPAPI protects the key from other user
  accounts, not from other programs running as you.

If Obsidian refuses to store the token, Papersync keeps it in memory for that
session only and asks you to reconnect. If the stored token cannot be read at
startup (for example, a locked keychain), Drive stays disconnected and shows the
normal sync-error status until you reconnect.

The rest of `data.json` (sync preferences, folder paths) holds no credentials.
It sits in your vault under `.obsidian/plugins/papersync/` and goes wherever
your vault is synced or backed up.

### Disconnecting

- **Change storage** and **Full reset** sign you out for real. Papersync clears
  the token from your device first, then posts it to Google's revocation
  endpoint (`oauth2.googleapis.com/revoke`), which kills the refresh token
  server-side. Any access token already issued expires within about an hour.
  **Reset settings** keeps your account connected.
- **Revocation is best-effort.** If you disconnect while offline, the local
  clear still completes, but the refresh token stays valid at Google until you
  [remove Papersync's access](https://support.google.com/accounts/answer/3466521#remove-access)
  in your Google Account, or Google expires it after six months without use.
  The failure is logged, never surfaced as an error.
- **Uninstalling does not disconnect.** Use Change storage first. Otherwise the
  token stays in Obsidian's Keychain settings and stays valid at Google; remove
  it in both places yourself.
- A revoked token that somehow reappears on a later load self-heals on first
  use, when Google rejects it with `invalid_grant` and the plugin clears it
  again.

## Scan text is treated as untrusted

A scan's text comes from a synced folder or your Drive, and from whatever page
was photographed, so Papersync treats it as untrusted before it reaches a note:

- Templater command tags (`<%` and `%>`) are broken with an invisible
  zero-width space, so Templater never runs them, even with "Trigger Templater
  on new file creation" turned on.
- Code blocks that other plugins run (`dataview`, `dataviewjs`, `js-engine`,
  `tasks`, Meta Bind and Buttons blocks) and Dataview inline JS (`` `$=` ``)
  are broken the same way, so they show as plain code. This holds inside lists
  and block quotes too, nested or indented.
- Every image that is not a vault file becomes a plain link: remote images
  (`![](https://...)`), images with an encoded or escaped address, and
  reference-style images in all three forms (`![x][ref]`, `![x][]`, `![x]`),
  since their definition can point anywhere. HTML tags that load something
  (`<img>`, `<iframe>`, `<video>` and the like) are shown as text, so opening a
  note makes no request.
- Titles and summaries are escaped to plain text. The provider and model names
  are too, keeping the punctuation model names use (`-`, `.`, `/`, `:`, `@`,
  `_`), so they cannot add code, images, embeds or HTML.
- Scan text cannot mark another scan as already imported: the import comment
  older versions wrote (`%% papersync:<id> %%`) is broken in scan text, and is
  only trusted on a line of its own. Scan text placed at the top of a new note
  never becomes the note's properties.

Other plugins may define their own executable syntax that this list does not
cover. If you run such plugins, review imported notes before you let them
process the note.

### For contributors and security scanners

Automated secret scanners (including GitHub secret scanning) may flag the
`GOCSPX-` value. That is expected: the credential is public for this client
type per the Google documentation above, so such alerts are not actionable.

Do not disable the secret in reaction to an alert. Every installed copy uses it
for sign-in and token refresh, so disabling it breaks Drive sync until each
user updates. A planned rotation causes no outage: Google allows two active
secrets per client, so add the new one, ship a release that carries it, and
disable the old one once users have updated.
