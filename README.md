# Tamil Music Vault

Fast static web UI for a Tamil song platform.

## Storage

Sruthi now uses SQLite as its primary local database for:

- albums
- songs
- stored `128 kbps` / `320 kbps` links
- download link metadata
- refresh metadata

Database file:

- [data/sruthi.db](/Users/lokesh/Project_1/data/sruthi.db)

The JSON files under [data](/Users/lokesh/Project_1/data) are still written as backup/export artifacts, but the app runtime now reads from SQLite-backed state.

## Run

Run the integrated local server:

```bash
python3 server.py
```

Then open `http://localhost:8000`.

## Cloudflare Deploy

A free-hosting Cloudflare target now exists under [cloudflare](/Users/lokesh/Project_1/cloudflare).

Start here:

- [cloudflare/README.md](/Users/lokesh/Project_1/cloudflare/README.md)
- [cloudflare/wrangler.jsonc](/Users/lokesh/Project_1/cloudflare/wrangler.jsonc)
- [cloudflare/scripts/export_d1_sql.py](/Users/lokesh/Project_1/cloudflare/scripts/export_d1_sql.py)

This path uses:

- Cloudflare Workers
- Cloudflare static assets
- Cloudflare D1

## Safe Background Refresh

A GitHub Actions workflow now exists at [/.github/workflows/background-refresh.yml](/Users/lokesh/Project_1/.github/workflows/background-refresh.yml).

It is designed to:

- run on a schedule or manually
- validate catalog data in DuckDB
- build the next D1 release first
- import into an inactive D1 slot
- deploy only after validation succeeds
- keep the current live site untouched if any step fails

## MassTamilan direct export path

MassTamilan is behind Cloudflare, so direct scraping from this workspace is blocked. The reliable path is:

1. Start the local site with `python3 server.py`.
2. Keep [http://localhost:8000](http://localhost:8000) open.
3. Open [https://www.masstamilan.dev/tamil-songs?page=1](https://www.masstamilan.dev/tamil-songs?page=1) in your browser.
4. Complete any Cloudflare or anti-bot check.
5. Open DevTools console.
6. Paste the script from [tools/masstamilan-direct-export.js](/Users/lokesh/Project_1/tools/masstamilan-direct-export.js).
7. Let it crawl pages `1` through `480`.
8. The scraper will send albums directly into the local app at `http://127.0.0.1:8000/api/catalog/batch`.

No JSON downloads are required for this flow. The integrated catalog is stored at [data/catalog.json](/Users/lokesh/Project_1/data/catalog.json) for the local site to read.

## Playback Model

The app now streams through Sruthi's backend:

- `/api/library` returns `audioUrl` as `/api/stream/<song_id>`
- `/api/stream/<song_id>` prefers a valid local mirrored file first
- if no valid local file exists, it tries the stored remote `320 kbps` / `128 kbps` link
- if that remote link is stale or returns HTML instead of audio, Sruthi re-fetches the album page inline, updates SQLite, and retries the stream

If you want to view only mirrored tracks, use the `Local Only` filter in the UI. It is off by default.

## Inline Link Refresh

MassTamilan download links can expire. Sruthi now handles that inline during playback:

1. A stream request comes into `/api/stream/<song_id>`
2. Sruthi tries the stored audio link
3. If the upstream response is not valid audio, Sruthi re-fetches the album page
4. It extracts fresh `128 kbps` / `320 kbps` links from `window.albumTracks`
5. The refreshed album is written back into SQLite and the stream is retried

If the inline refresh still cannot recover a working source, the stream endpoint returns `502 Upstream stream unavailable`.

## Full Catalog Refresh

To refresh every stored album link in one run, open a verified MassTamilan tab and paste [tools/masstamilan-full-refresh.js](/Users/lokesh/Project_1/tools/masstamilan-full-refresh.js) into DevTools.

That script:

- ignores the processed-albums cache
- crawls all listing pages
- re-scrapes every album page
- overwrites the local catalog by album URL
- refreshes stored `128 kbps` and `320 kbps` links in bulk
