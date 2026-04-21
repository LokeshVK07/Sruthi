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

Alternate catalogs can be isolated with separate storage roots. The dedicated Telugu refresh wrapper writes to:

- [data/telugu/sruthi.db](/Users/lokesh/Project_1/data/telugu/sruthi.db)
- [media/telugu](/Users/lokesh/Project_1/media/telugu)
- [.cache/audio-telugu](/Users/lokesh/Project_1/.cache/audio-telugu)

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
- [tools/deploy_localhost_to_cloudflare.py](/Users/lokesh/Project_1/tools/deploy_localhost_to_cloudflare.py)

This path uses:

- Cloudflare Workers
- Cloudflare static assets
- Cloudflare D1

To deploy the full current localhost-visible state safely, use:

```bash
python3 /Users/lokesh/Project_1/tools/deploy_localhost_to_cloudflare.py
```

## Safe Background Refresh

A GitHub Actions workflow now exists at [/.github/workflows/background-refresh.yml](/Users/lokesh/Project_1/.github/workflows/background-refresh.yml).

It is designed to:

- run on a schedule or manually
- validate catalog data in DuckDB
- build the next D1 release first
- import into an inactive D1 slot
- deploy only after validation succeeds
- keep the current live site untouched if any step fails

## MassTamilan / MassTelugu direct export path

The same exporter logic now supports both:

- `https://www.masstamilan.dev`
- `https://masstelugu.com`

The reliable browser-driven path is:

1. Start the local site with `python3 server.py`.
2. Keep [http://localhost:8000](http://localhost:8000) open.
3. Open either [https://www.masstamilan.dev/tamil-songs?page=1](https://www.masstamilan.dev/tamil-songs?page=1) or [https://masstelugu.com/telugu-songs?page=1](https://masstelugu.com/telugu-songs?page=1) in your browser.
4. Complete any Cloudflare or anti-bot check.
5. Open DevTools console.
6. Paste the script from [tools/masstamilan-direct-export.js](/Users/lokesh/Project_1/tools/masstamilan-direct-export.js).
7. Let it crawl the detected listing pages plus the movie index pages for that site.
8. The scraper will send albums directly into the local app at `http://127.0.0.1:8000/api/catalog/batch`.

No JSON downloads are required for this flow. The integrated catalog is stored at [data/catalog.json](/Users/lokesh/Project_1/data/catalog.json) for the local site to read.

For local scripted refreshes from this workspace:

- [tools/masstamilan_refresh.py](/Users/lokesh/Project_1/tools/masstamilan_refresh.py) keeps using the default Tamil storage under [data](/Users/lokesh/Project_1/data).
- [tools/masstelugu_refresh.py](/Users/lokesh/Project_1/tools/masstelugu_refresh.py) uses the same scraper logic but writes into the isolated Telugu storage roots above.

To browse the Telugu catalog with the same UI and backend logic, run the server with:

```bash
SRUTHI_DATA_DIR=data/telugu SRUTHI_MEDIA_DIR=media/telugu SRUTHI_CACHE_AUDIO_DIR=.cache/audio-telugu python3 server.py
```

Cloud deployments are now intended to stay split the same way:

- Tamil workflow/deploy: [.github/workflows/background-refresh.yml](/Users/lokesh/Project_1/.github/workflows/background-refresh.yml)
- Telugu workflow/deploy: [.github/workflows/background-refresh-telugu.yml](/Users/lokesh/Project_1/.github/workflows/background-refresh-telugu.yml)

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
