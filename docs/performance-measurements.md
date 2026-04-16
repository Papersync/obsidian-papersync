# Performance Measurements

## Environment

- **Date:** (pending manual measurement)
- **Obsidian version:** 
- **Plugin version:** 1.0.0
- **macOS version:** 

## Measurements

| NFR | Target | Measured | Pass/Fail |
|-----|--------|----------|-----------|
| NFR1 — onload time | ≤ 200ms | — | — |
| NFR2 — idle memory | ≤ 30MB | — | — |
| NFR3 — scan processing | ≤ 3s | — | — |
| NFR5 — Drive poll cycle | ≤ 2s | — | — |
| NFR6 — Watcher event latency | ≤ 1s | — | — |

## Drive Quota Watermark (NFR27)

The Drive list query uses `createdTime > <lastSyncTimestamp>` to fetch only new files each poll cycle. At the default 30s interval, this produces 2 queries/minute/user. With ~500 users at Day-90, that's 1000 queries/minute — well within the 12,000-query/100-second quota.
