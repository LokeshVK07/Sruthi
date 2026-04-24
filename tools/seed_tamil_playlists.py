#!/usr/bin/env python3

import argparse
import json
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from playlist_catalog import ensure_playlist_tables, seed_playlists


DEFAULT_DB_PATH = ROOT / "data" / "sruthi.db"


def parse_args():
    parser = argparse.ArgumentParser(description="Seed curated Tamil playlists into the local SQLite catalog.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--json", action="store_true", help="Print only JSON summary.")
    return parser.parse_args()


def main():
    args = parse_args()
    db_path = args.db.resolve()
    if not db_path.exists():
        raise SystemExit(f"SQLite database not found: {db_path}")

    connection = sqlite3.connect(db_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")

    ensure_playlist_tables(connection)
    summary = seed_playlists(connection, log_warning=lambda message: print(message, file=sys.stderr))
    connection.close()

    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return

    print(f"Playlists created: {summary['created']}")
    print(f"Playlists updated: {summary['updated']}")
    print(f"Playlists processed: {summary['playlistCount']}")
    print(f"Playlist items inserted: {summary['playlistItemsInserted']}")
    print(f"Missing songs: {summary['missingSongCount']}")
    print(f"Ambiguous songs skipped: {summary['ambiguousSongCount']}")
    print(f"Composer mismatches skipped: {summary['composerMismatchCount']}")
    print()
    for playlist in summary["playlists"]:
        print(
            f"{playlist['name']}: prev={playlist['previousSongCount']} "
            f"final={playlist['finalSongCount']} inserted={playlist['newlyInsertedCount']} "
            f"missing={playlist['skippedMissingCount']} ambiguous={playlist['skippedAmbiguousCount']} "
            f"composer_mismatch={playlist['composerMismatchCount']}"
        )
    print()
    print("Missing songs by playlist:")
    for name, missing in summary["missingSongs"].items():
        print(f"- {name}: {len(missing)}")
        for title in missing:
            print(f"  - {title}")


if __name__ == "__main__":
    main()
