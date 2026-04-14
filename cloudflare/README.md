# Cloudflare Deploy

This folder contains a free-hosting deployment target for `Sruthi - ஷ்ருதி` using:

- Cloudflare Workers
- Cloudflare static assets
- Cloudflare D1

## What It Runs

The Worker in [src/worker.js](/Users/lokesh/Project_1/cloudflare/src/worker.js) serves:

- static frontend assets from [public](/Users/lokesh/Project_1/cloudflare/public)
- `/api/app-state`
- `/api/library`
- `/api/song`
- `/api/stream/:id`
- `/api/sync/status`
- lightweight no-op `/api/warmup`, `/api/prefetch`, `/api/prefetch/album`

User playlists and favourites still stay in browser local storage.

## Automatic Cloud Sync

The Worker can now update the catalog automatically on Cloudflare with no Mac involved.

How it works:

- a Cloudflare cron trigger runs every 6 hours
- the Worker fetches a MassTamilan-owned JSON feed from `SYNC_FEED_URL`
- new albums and songs are upserted into D1
- existing rows are refreshed in place

### Feed URL

By default, [wrangler.jsonc](/Users/lokesh/Project_1/cloudflare/wrangler.jsonc) points to:

- `https://www.masstamilan.dev/sruthi-sync.json`

If you want a different endpoint, change `SYNC_FEED_URL` before deploy.

### Recommended Feed Shape

```json
{
  "generatedAt": "2026-04-09T03:00:00Z",
  "albums": [
    {
      "url": "https://www.masstamilan.dev/leo-2023-songs",
      "title": "Leo",
      "pageNumber": 1,
      "year": 2023,
      "musicDirector": "Anirudh Ravichander",
      "director": "Lokesh Kanagaraj",
      "starring": "Vijay",
      "lyricists": "Vishnu Edavan",
      "updatedAt": "2026-04-09T03:00:00Z",
      "songs": [
        {
          "id": "43910",
          "title": "Badass",
          "artist": "Anirudh Ravichander",
          "singers": "Anirudh Ravichander",
          "composer": "Anirudh Ravichander",
          "movie": "Leo",
          "year": 2023,
          "songPageUrl": "https://www.masstamilan.dev/25/badass-mp3-song",
          "sourceUrl": "https://www.masstamilan.dev/leo-2023-songs",
          "imageUrl": "https://www.masstamilan.dev/uploads/album/leo-tamil-2023.jpg",
          "audio128Url": "https://www.masstamilan.dev/downloader/...128.mp3",
          "audio320Url": "https://www.masstamilan.dev/downloader/...320.mp3",
          "updatedAt": "2026-04-09T03:00:00Z"
        }
      ]
    }
  ]
}
```

### Manual Trigger

You can also trigger a sync manually:

```bash
curl -X POST https://sruthi.vklokesh70.workers.dev/api/admin/sync
```

If you set `SYNC_ADMIN_TOKEN`, pass it as:

```bash
curl -X POST https://sruthi.vklokesh70.workers.dev/api/admin/sync \
  -H "x-sync-token: YOUR_TOKEN"
```

### Sync Status

```bash
curl https://sruthi.vklokesh70.workers.dev/api/sync/status
```

## One-Time Playlist Import

If you want to bring MassTamilan playlist pages into Sruthi before the sync feed supports playlists, use the browser exporter:

- [tools/masstamilan-playlists-export.js](/Users/lokesh/Project_1/tools/masstamilan-playlists-export.js)

It exports JSON like:

```json
{
  "playlists": [
    {
      "id": "top-100-songs",
      "name": "Top 100 Songs",
      "sourceUrl": "https://www.masstamilan.dev/playlists/top-100-songs",
      "songs": [
        {
          "songPageUrl": "https://www.masstamilan.dev/25/badass-mp3-song-3",
          "title": "Badass",
          "movie": "Leo"
        }
      ]
    }
  ]
}
```

Then import it into Sruthi:

```bash
curl -X POST https://sruthi.vklokesh70.workers.dev/api/admin/import-playlists \
  -H "Content-Type: application/json" \
  --data-binary @playlists-export.json
```

You can read the imported shared playlists from:

```bash
curl https://sruthi.vklokesh70.workers.dev/api/playlists
```

## Before Deploy

1. Create a free Cloudflare account.
2. Install Wrangler locally.
3. Create a D1 database:

```bash
npx wrangler d1 create sruthi-db
```

4. Copy the returned `database_id` into [wrangler.jsonc](/Users/lokesh/Project_1/cloudflare/wrangler.jsonc).

## Export Your Current Catalog

Generate a D1 import file from your existing local SQLite catalog:

```bash
python3 /Users/lokesh/Project_1/cloudflare/scripts/export_d1_sql.py
```

That writes:

- [data/seed.sql](/Users/lokesh/Project_1/cloudflare/data/seed.sql)

## Import Into D1

From the `cloudflare` folder:

```bash
npx wrangler d1 execute sruthi-db --file ./data/seed.sql
```

## Local Worker Preview

```bash
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

That command only deploys the Worker and current static assets.

If you want the live Cloudflare site to match the full current localhost state, including the latest local frontend files and the current local SQLite catalog, use:

```bash
python3 /Users/lokesh/Project_1/tools/deploy_localhost_to_cloudflare.py
```

That local release script will:

- sync the current root frontend bundle into [public](/Users/lokesh/Project_1/cloudflare/public)
- build a validated D1 seed from [data/sruthi.db](/Users/lokesh/Project_1/data/sruthi.db)
- import it into the inactive D1 slot
- validate the remote slot counts against the local release manifest
- deploy the Worker and static assets together
- update `SRUTHI_ACTIVE_D1_SLOT` only after success

## GitHub Actions Background Refresh

The repository now includes a safe background refresh workflow at:

- [.github/workflows/background-refresh.yml](/Users/lokesh/Project_1/.github/workflows/background-refresh.yml)

How it works:

- runs on a schedule and by manual trigger
- validates the catalog in DuckDB before generating a release
- builds the D1 seed first
- imports into the inactive D1 slot
- deploys the live Worker only after import and validation succeed
- updates the active slot only after a successful deploy
- blocks overlapping workflow runs

Required GitHub repository variables:

- `SRUTHI_D1_DB_A_ID`
- `SRUTHI_D1_DB_A_NAME`
- `SRUTHI_D1_DB_B_ID`
- `SRUTHI_D1_DB_B_NAME`
- `SRUTHI_ACTIVE_D1_SLOT`

Required GitHub repository secret:

- `CLOUDFLARE_API_TOKEN`

Optional GitHub repository variable:

- `SRUTHI_UPDATE_COMMAND`

`SRUTHI_UPDATE_COMMAND` is where you can plug in an existing non-interactive refresh command if you add one later. The current browser-console MassTamilan scrapers in [tools](/Users/lokesh/Project_1/tools) are still manual and are not run directly by GitHub Actions.

## Notes

- This Cloudflare target is separate from the local Python server.
- The Worker tries stored MassTamilan links first and can do a lightweight album refresh on demand.
- The local-only toggle is not meaningful on Cloudflare deployment because browser-local mirrored files do not exist there.
