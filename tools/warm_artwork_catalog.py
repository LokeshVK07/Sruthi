#!/usr/bin/env python3

import argparse
import concurrent.futures
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]


def load_album_song_ids(db_path, id_prefix=""):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT MIN(id) AS song_id, album_url
            FROM songs
            WHERE album_url IS NOT NULL AND album_url != ''
            GROUP BY album_url
            ORDER BY album_url
            """
        ).fetchall()
        return [f"{id_prefix}{row['song_id']}" for row in rows if row["song_id"]]
    finally:
        connection.close()


def request_artwork(origin, song_id):
    url = f"{origin.rstrip('/')}/api/artwork?id={quote(song_id, safe='')}&v=bulk"
    result = subprocess.run(
        [
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "20",
            url,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    status_text = (result.stdout or "").strip()
    try:
        status = int(status_text)
    except ValueError:
        status = 0
    return song_id, status, result.returncode


def main():
    parser = argparse.ArgumentParser(description="Warm artwork for all albums through the API endpoint.")
    parser.add_argument("--origin", required=True, help="API origin, e.g. https://sruthi.vklokesh70.workers.dev")
    parser.add_argument("--db", action="append", required=True, help="SQLite DB path to read songs from")
    parser.add_argument("--id-prefix", action="append", default=[], help="Optional id prefix per DB, e.g. telugu:")
    parser.add_argument("--workers", type=int, default=12, help="Concurrent request count")
    parser.add_argument("--limit", type=int, default=0, help="Optional cap for testing")
    args = parser.parse_args()

    prefixes = list(args.id_prefix)
    while len(prefixes) < len(args.db):
        prefixes.append("")

    song_ids = []
    for db_path, prefix in zip(args.db, prefixes):
        song_ids.extend(load_album_song_ids(ROOT / db_path if not Path(db_path).is_absolute() else Path(db_path), prefix))

    if args.limit > 0:
        song_ids = song_ids[: args.limit]

    total = len(song_ids)
    completed = 0
    ok = 0
    failed = 0
    lock = threading.Lock()

    def run(song_id):
        nonlocal completed, ok, failed
        _, status, returncode = request_artwork(args.origin, song_id)
        with lock:
            completed += 1
            if returncode == 0 and 200 <= status < 300:
                ok += 1
            else:
                failed += 1
                print(f"[artwork-warm] failed {song_id} status={status} curl={returncode}", file=sys.stderr)
            if completed % 100 == 0 or completed == total:
                print(f"[artwork-warm] {completed}/{total} ok={ok} failed={failed}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        list(executor.map(run, song_ids))

    print(f"[artwork-warm] done total={total} ok={ok} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
