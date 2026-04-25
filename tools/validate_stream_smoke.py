#!/usr/bin/env python3

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]


def parse_args():
    parser = argparse.ArgumentParser(description="Smoke-test stream playback for a deployed Sruthi worker.")
    parser.add_argument("--db", type=Path, required=True, help="SQLite database path to sample song ids from")
    parser.add_argument("--origin", required=True, help="Worker origin, e.g. https://sruthi.vklokesh70.workers.dev")
    parser.add_argument("--id-prefix", default="", help="Optional song id prefix, e.g. telugu:")
    parser.add_argument("--sample-size", type=int, default=3, help="How many songs to test")
    parser.add_argument("--label", default="", help="Optional label for logs")
    return parser.parse_args()


def resolve_db_path(path: Path):
    if path.is_absolute():
        return path
    return (ROOT / path).resolve()


def load_sample_songs(db_path: Path, sample_size: int):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT id, title, movie, album_url,
                   COALESCE(last_refreshed_at, updated_at) AS freshness
            FROM songs
            WHERE COALESCE(audio_128_url, '') <> '' OR COALESCE(audio_320_url, '') <> ''
            ORDER BY freshness DESC, year DESC, id DESC
            LIMIT 200
            """
        ).fetchall()
    finally:
        connection.close()

    samples = []
    seen_albums = set()
    for row in rows:
        album_url = (row["album_url"] or "").strip()
        if album_url and album_url in seen_albums:
            continue
        if album_url:
            seen_albums.add(album_url)
        samples.append(
            {
                "id": str(row["id"]),
                "title": (row["title"] or "").strip(),
                "movie": (row["movie"] or "").strip(),
            }
        )
        if len(samples) >= sample_size:
            break
    return samples


def validate_stream(origin: str, song_id: str):
    response = requests.get(
        f"{origin.rstrip('/')}/api/stream/{song_id}",
        headers={
            "Range": "bytes=0-1",
            "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
        },
        timeout=30,
        stream=True,
        allow_redirects=True,
    )
    try:
        content_type = (response.headers.get("Content-Type") or "").lower()
        ok = response.status_code in (200, 206) and content_type.startswith("audio/")
        return {
            "ok": ok,
            "status": response.status_code,
            "contentType": content_type,
            "contentLength": response.headers.get("Content-Length"),
        }
    finally:
        response.close()


def main():
    args = parse_args()
    db_path = resolve_db_path(args.db)
    samples = load_sample_songs(db_path, max(1, args.sample_size))
    if not samples:
        raise SystemExit(f"No playable songs found in {db_path}")

    results = []
    failures = []
    for sample in samples:
        song_id = f"{args.id_prefix}{sample['id']}"
        result = validate_stream(args.origin, song_id)
        payload = {
            "id": song_id,
            "title": sample["title"],
            "movie": sample["movie"],
            **result,
        }
        results.append(payload)
        if not result["ok"]:
            failures.append(payload)

    summary = {
        "label": args.label or args.origin,
        "origin": args.origin,
        "db": str(db_path),
        "checked": len(results),
        "failed": len(failures),
        "results": results,
    }
    print(json.dumps(summary, indent=2))
    if failures:
        raise SystemExit(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
