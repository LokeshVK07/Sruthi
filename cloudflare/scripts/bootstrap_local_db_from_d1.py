#!/usr/bin/env python3

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
  sys.path.insert(0, str(ROOT))

from cloudflare.scripts.export_d1_sql import SCHEMA


def parse_args():
  parser = argparse.ArgumentParser(description="Bootstrap a local SQLite catalog from a remote Cloudflare D1 database.")
  parser.add_argument("--db", type=Path, required=True, help="Local SQLite path to create or replace.")
  parser.add_argument("--config", type=Path, required=True, help="Wrangler config to use for the remote query.")
  parser.add_argument("--database", required=True, help="Remote D1 database name.")
  return parser.parse_args()


def run_wranger_json(database_name: str, config_path: Path, command: str):
  result = subprocess.run(
    [
      "npx",
      "wrangler",
      "d1",
      "execute",
      database_name,
      "--remote",
      "--command",
      command,
      "--config",
      str(config_path),
      "--json",
    ],
    cwd=str(ROOT / "cloudflare"),
    text=True,
    capture_output=True,
    check=False,
  )
  if result.returncode != 0:
    raise RuntimeError(f"D1 query failed for command {command!r}:\n{result.stderr or result.stdout}")
  return json.loads(result.stdout)


def extract_rows(payload):
  rows = []
  stack = [payload]
  while stack:
    item = stack.pop()
    if isinstance(item, dict):
      results = item.get("results")
      if isinstance(results, list):
        for row in results:
          if isinstance(row, dict):
            rows.append(row)
      stack.extend(item.values())
    elif isinstance(item, list):
      stack.extend(item)
  return rows


def table_exists(database_name: str, config_path: Path, table_name: str):
  payload = run_wranger_json(
    database_name,
    config_path,
    f"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '{table_name}';",
  )
  return any((row.get("name") == table_name) for row in extract_rows(payload))


def insert_rows(connection, table_name: str, columns, rows):
  if not rows:
    return
  placeholders = ", ".join(["?"] * len(columns))
  sql = f"INSERT INTO {table_name} ({', '.join(columns)}) VALUES ({placeholders})"
  payload = []
  for row in rows:
    payload.append(tuple(row.get(column) for column in columns))
  connection.executemany(sql, payload)


def main():
  args = parse_args()
  db_path = args.db.resolve()
  config_path = args.config.resolve()

  db_path.parent.mkdir(parents=True, exist_ok=True)
  if db_path.exists():
    db_path.unlink()

  connection = sqlite3.connect(db_path)
  try:
    connection.executescript(SCHEMA)

    table_queries = {
      "app_meta": {
        "columns": ["key", "value"],
        "query": "SELECT key, value FROM app_meta ORDER BY key;",
      },
      "albums": {
        "columns": [
          "url",
          "title",
          "page_number",
          "year",
          "music_director",
          "director",
          "starring",
          "lyricists",
          "zip_links_json",
          "track_count",
          "updated_at",
        ],
        "query": """
          SELECT url, title, page_number, year, music_director, director, starring,
                 lyricists, zip_links_json, track_count, updated_at
          FROM albums
          ORDER BY page_number, title;
        """,
      },
      "songs": {
        "columns": [
          "id",
          "album_url",
          "title",
          "artist",
          "singers",
          "composer",
          "movie",
          "year",
          "mood",
          "song_page_url",
          "source_url",
          "image_url",
          "audio_url",
          "audio_128_url",
          "audio_320_url",
          "remote_audio_128_url",
          "remote_audio_320_url",
          "local_audio_128_url",
          "local_audio_320_url",
          "download_links_json",
          "spotify_json",
          "last_refreshed_at",
          "link_status",
          "updated_at",
        ],
        "query": """
          SELECT id, album_url, title, artist, singers, composer, movie, year, mood,
                 song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
                 remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
                 download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
          FROM songs
          ORDER BY year DESC, movie COLLATE NOCASE, title COLLATE NOCASE;
        """,
      },
    }

    optional_table_queries = {
      "playlists": {
        "columns": [
          "id",
          "name",
          "slug",
          "description",
          "category",
          "cover_url",
          "tags",
          "is_featured",
          "created_at",
          "updated_at",
        ],
        "query": """
          SELECT id, name, slug, description, category, cover_url, tags, is_featured, created_at, updated_at
          FROM playlists
          ORDER BY lower(category), lower(name), id;
        """,
      },
      "playlist_items": {
        "columns": ["id", "playlist_id", "song_id", "position", "created_at"],
        "query": """
          SELECT id, playlist_id, song_id, position, created_at
          FROM playlist_items
          ORDER BY playlist_id, position, song_id;
        """,
      },
    }

    imported_counts = {}

    for table_name, spec in table_queries.items():
      payload = run_wranger_json(args.database, config_path, spec["query"])
      rows = extract_rows(payload)
      insert_rows(connection, table_name, spec["columns"], rows)
      imported_counts[table_name] = len(rows)

    for table_name, spec in optional_table_queries.items():
      if not table_exists(args.database, config_path, table_name):
        imported_counts[table_name] = 0
        continue
      payload = run_wranger_json(args.database, config_path, spec["query"])
      rows = extract_rows(payload)
      insert_rows(connection, table_name, spec["columns"], rows)
      imported_counts[table_name] = len(rows)

    connection.commit()
  finally:
    connection.close()

  if imported_counts.get("albums", 0) <= 0 or imported_counts.get("songs", 0) <= 0:
    raise RuntimeError(
      f"Remote D1 bootstrap produced an empty catalog: albums={imported_counts.get('albums', 0)}, songs={imported_counts.get('songs', 0)}"
    )

  print(json.dumps({"ok": True, "imported": imported_counts, "db": str(db_path)}, indent=2))


if __name__ == "__main__":
  main()
