# Contributing

Bug reports and ideas go in [GitHub issues](https://github.com/Papersync/obsidian-papersync/issues). Security problems go through [SECURITY.md](SECURITY.md) instead.

## Development

Use the Node version in `.nvmrc`.

```bash
npm install
npm run dev            # watch build
npm run lint           # ESLint, including the Obsidian plugin rules
npm run tsc            # type-check the plugin and the E2E suite
npm test               # unit tests
npm run test:coverage  # unit tests plus the 100% coverage gate CI enforces
npm run test:e2e       # end-to-end tests against real Obsidian (downloads it on first run)
npm run build          # production build
```

To try a build in your own vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/papersync/` and reload Obsidian.

## Pull requests

- Keep CI green: lint, type-check, unit tests at 100% coverage, bundle size budget and the E2E suite.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(sync): ...`, `feat(template): ...`).
- The plugin must stay free of telemetry and of network calls beyond Google Drive sync. Obsidian's directory policy does not allow client-side telemetry, even opt-in.
