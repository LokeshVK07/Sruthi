#!/usr/bin/env python3

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "sruthi.db"
OUT_PATH = ROOT / "cloudflare" / "data" / "seed.sql"


SCHEMA = """
DROP TABLE IF EXISTS app_meta;
DROP TABLE IF EXISTS albums;
DROP TABLE IF EXISTS songs;

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE albums (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_number INTEGER NOT NULL DEFAULT 0,
  year INTEGER NOT NULL DEFAULT 0,
  music_director TEXT,
  director TEXT,
  starring TEXT,
  lyricists TEXT,
  zip_links_json TEXT NOT NULL DEFAULT '[]',
  track_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  album_url TEXT,
  title TEXT NOT NULL,
  artist TEXT,
  singers TEXT,
  composer TEXT,
  movie TEXT,
  year INTEGER NOT NULL DEFAULT 0,
  mood TEXT NOT NULL DEFAULT 'Imported',
  song_page_url TEXT,
  source_url TEXT,
  image_url TEXT,
  audio_url TEXT,
  audio_128_url TEXT,
  audio_320_url TEXT,
  remote_audio_128_url TEXT,
  remote_audio_320_url TEXT,
  local_audio_128_url TEXT,
  local_audio_320_url TEXT,
  download_links_json TEXT NOT NULL DEFAULT '[]',
  spotify_json TEXT NOT NULL DEFAULT '{}',
  last_refreshed_at TEXT,
  link_status TEXT NOT NULL DEFAULT 'unknown',
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_albums_page_number ON albums(page_number, title);
CREATE INDEX idx_songs_album_url ON songs(album_url);
CREATE INDEX idx_songs_movie_title ON songs(movie, title);
CREATE INDEX idx_songs_year ON songs(year);
CREATE INDEX idx_songs_link_status ON songs(link_status);
"""


def sql_value(value):
  if value is None:
    return "NULL"
  if isinstance(value, (int, float)):
    return str(value)
  text = str(value).replace("'", "''")
  return f"'{text}'"


def write_insert(handle, table, columns, row):
  values = ", ".join(sql_value(row[column]) for column in columns)
  handle.write(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({values});\n")


def main():
  OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
  connection = sqlite3.connect(DB_PATH)
  connection.row_factory = sqlite3.Row

  with OUT_PATH.open("w", encoding="utf-8") as handle:
    handle.write("-- Generated from local SQLite catalog for Cloudflare D1\n")
    handle.write(SCHEMA.strip())
    handle.write("\n\n")

    meta_columns = ["key", "value"]
    for row in connection.execute("SELECT key, value FROM app_meta ORDER BY key"):
      write_insert(handle, "app_meta", meta_columns, row)

    album_columns = [
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
    ]
    for row in connection.execute(
      """
      SELECT url, title, page_number, year, music_director, director, starring,
             lyricists, zip_links_json, track_count, updated_at
      FROM albums
      ORDER BY page_number, title
      """,
    ):
      write_insert(handle, "albums", album_columns, row)

    song_columns = [
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
    ]
    for row in connection.execute(
      """
      SELECT id, album_url, title, artist, singers, composer, movie, year, mood,
             song_page_url, source_url, image_url, audio_url, audio_128_url, audio_320_url,
             remote_audio_128_url, remote_audio_320_url, local_audio_128_url, local_audio_320_url,
             download_links_json, spotify_json, last_refreshed_at, link_status, updated_at
      FROM songs
      ORDER BY year DESC, movie COLLATE NOCASE, title COLLATE NOCASE
      """,
    ):
      write_insert(handle, "songs", song_columns, row)

  print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
  main()
