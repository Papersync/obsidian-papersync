# obsidian-papersync Plugin

## Testing

### Unit Tests
```bash
cd plugin && npm test
```
Jest with `jest.config.cjs`. Tests in `plugin/tests/`. Obsidian APIs mocked via `tests/__mocks__/obsidian.ts`.

### E2E Tests
```bash
cd plugin && npm run test:e2e
```
Uses WebdriverIO (`wdio`) with `wdio-obsidian-service`. Requires Obsidian installed and available. Tests in `plugin/test/e2e/`. Config at `wdio.conf.mts`.

E2E tests automate a real Obsidian instance with the plugin loaded from a test vault at `test/vault/`.

### Type Checking
```bash
cd plugin && npx tsc --noEmit
```

## Releasing
```bash
npm run release -- prepare patch   # local checks, version bump and commit on a branch
npm run release -- draft 0.1.4     # after PR merge + green default-branch CI, push only the tag
npm run release -- publish 0.1.4   # after reviewing the draft's notes and assets
```
For already-bumped 0.1.4, skip prepare. Each remote stage needs the founder's
explicit approval. Scripts: `scripts/release.sh` and `scripts/release.mjs`.
Full process and recovery: [RELEASING.md](RELEASING.md).

## Key Patterns

- **BackendType:** `'drive' | 'folder' | 'none'` (was `'icloud'` before v2 migration)
- **Settings migration:** `migrateSettings()` in `settings.ts` — version-based `if (version < N)` cascade
- **SyncBackend interface:** Both `DriveBackend` and `FolderBackend` implement `discoverUnsynced`, `fetchScan`, `fetchImage`, `markSynced`, `start`, `stop`
- **Desktop only:** `isDesktopOnly: true` — no mobile support
- **No local DB:** Sync state lives in cloud (ScanFile `synced` field) and vault (note presence)
- **Sync location detection:** `detectSyncLocations()` in `utils/platform.ts` — probes iCloud, Dropbox, OneDrive, Syncthing (Obsidian Sync is deliberately excluded: the mobile app cannot deliver scans into it)
- **Equal-weight UX invariant:** Settings tab shows all detected sync locations at equal visual weight — no pre-selection, no "recommended" badge
