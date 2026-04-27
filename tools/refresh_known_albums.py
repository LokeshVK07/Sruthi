#!/usr/bin/env python3

import argparse
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server
import tools.masstamilan_refresh as refresher


def parse_args():
    parser = argparse.ArgumentParser(description="Refresh already-known album pages into a local Sruthi SQLite catalog.")
    parser.add_argument("--db", required=True, help="SQLite database path to refresh")
    parser.add_argument("--origin", required=True, help="Catalog origin, e.g. https://www.masstamilan.dev")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--album-delay", type=float, default=0.2)
    parser.add_argument("--retry-count", type=int, default=4)
    parser.add_argument("--retry-base-delay", type=float, default=2.0)
    parser.add_argument("--batch-commit-size", type=int, default=32)
    parser.add_argument("--limit", type=int, default=0, help="Optional max album count to refresh")
    return parser.parse_args()


def load_album_seeds(db_path: Path):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT url, title, COALESCE(page_number, 0) AS page_number
            FROM albums
            ORDER BY updated_at DESC, title COLLATE NOCASE
            """
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "url": (row["url"] or "").strip(),
            "title": (row["title"] or "").strip() or "Untitled album",
            "pageNumber": int(row["page_number"] or 0),
        }
        for row in rows
        if (row["url"] or "").strip()
    ]


def main():
    args = parse_args()
    db_path = Path(args.db).resolve()
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    refresher.SCRAPE_SITE_ORIGIN = args.origin.rstrip("/")
    session = refresher.make_session()
    seeds = load_album_seeds(db_path)
    if args.limit > 0:
        seeds = seeds[: args.limit]
    total = len(seeds)
    if not total:
        raise SystemExit(f"No albums found in {db_path}")

    print(
        {
            "mode": "refresh-known-albums",
            "db": str(db_path),
            "origin": refresher.SCRAPE_SITE_ORIGIN,
            "workers": max(1, args.workers),
            "albumCount": total,
        }
    )

    entries = []
    failures = []
    start = time.time()

    def fetch_one(seed):
        refresher.sleep_with_jitter(args.album_delay, 0.2)
        html = refresher.fetch_html(session, seed["url"], args.retry_count, args.retry_base_delay)
        parsed = refresher.parse_album_page(html, seed)
        if not parsed.get("tracks"):
            raise RuntimeError(f"No tracks parsed for {seed['url']}")
        return seed, parsed, refresher.compute_album_hash(parsed)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(fetch_one, seed): seed for seed in seeds}
        completed = 0
        for future in as_completed(futures):
            seed = futures[future]
            completed += 1
            try:
                entries.append(future.result())
            except Exception as error:  # noqa: BLE001
                failures.append({"url": seed["url"], "title": seed["title"], "error": str(error)})
                print(f"[{completed}/{total}] FAILED: {seed['title']} -> {error}", file=sys.stderr)
            else:
                if completed % 25 == 0 or completed == total:
                    print(f"[{completed}/{total}] fetched ({len(failures)} failed, {time.time() - start:.0f}s elapsed)")

    if not entries:
        raise SystemExit("No album pages were refreshed successfully.")

    write_stats = server.batch_upsert_albums_into_db(entries, db_path=db_path, batch_size=max(1, args.batch_commit_size))
    print(
        {
            "fetched": len(entries),
            "failed": len(failures),
            "writeStats": write_stats,
            "elapsedSeconds": round(time.time() - start, 1),
        }
    )
    return 0 if len(failures) < total else 1


if __name__ == "__main__":
    raise SystemExit(main())
