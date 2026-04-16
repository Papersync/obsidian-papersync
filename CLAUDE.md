# obsidian-papersynced Plugin

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

## Key Patterns

- **BackendType:** `'drive' | 'folder' | 'none'` (was `'icloud'` before v2 migration)
- **Settings migration:** `migrateSettings()` in `settings.ts` — version-based `if (version < N)` cascade
- **SyncBackend interface:** Both `DriveBackend` and `FolderBackend` implement `discoverUnsynced`, `fetchScan`, `fetchImage`, `markSynced`, `start`, `stop`
- **Desktop only:** `isDesktopOnly: true` — no mobile support
- **No local DB:** Sync state lives in cloud (ScanFile `synced` field) and vault (note presence)
- **Sync location detection:** `detectSyncLocations()` in `utils/platform.ts` — probes iCloud, Dropbox, OneDrive, Syncthing, Obsidian Sync
- **Equal-weight UX invariant:** Settings tab shows all detected sync locations at equal visual weight — no pre-selection, no "recommended" badge
