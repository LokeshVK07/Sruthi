#!/usr/bin/env python3

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = ROOT / "data" / "sruthi.db"
DEFAULT_SEED_PATH = ROOT / "cloudflare" / "data" / "seed.sql"
DEFAULT_BASELINE_PATH = ROOT / "cloudflare" / "data" / "release-baseline.json"
DEFAULT_MANIFEST_PATH = ROOT / "cloudflare" / "data" / "release-manifest.json"
DEFAULT_DUCKDB_PATH = ROOT / "cloudflare" / "data" / "release-check.duckdb"


def parse_args():
  parser = argparse.ArgumentParser(description="Validate Sruthi catalog data and generate a D1 seed.")
  parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
  parser.add_argument("--seed", type=Path, default=DEFAULT_SEED_PATH)
  parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE_PATH)
  parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
  parser.add_argument("--duckdb-path", type=Path, default=DEFAULT_DUCKDB_PATH)
  return parser.parse_args()


def load_rows(connection, sql):
  return [tuple(row) for row in connection.execute(sql)]


def validate_sqlite_source(db_path: Path):
  if not db_path.exists():
    raise RuntimeError(f"SQLite database not found: {db_path}")
  if db_path.stat().st_size < 4096:
    raise RuntimeError(f"SQLite database is unexpectedly small: {db_path.stat().st_size} bytes")

  connection = sqlite3.connect(db_path)
  try:
    quick_check = connection.execute("PRAGMA quick_check").fetchone()
    if quick_check and quick_check[0] != "ok":
      raise RuntimeError(f"SQLite integrity check failed: {quick_check[0]}")
    album_rows = load_rows(
      connection,
      """
      SELECT url, title, year, track_count, updated_at
      FROM albums
      """,
    )
    song_rows = load_rows(
      connection,
      """
      SELECT id, album_url, title, movie, composer, artist, year,
             COALESCE(audio_128_url, ''), COALESCE(audio_320_url, ''), updated_at
      FROM songs
      """,
    )
    updated_at_row = connection.execute("SELECT value FROM app_meta WHERE key = 'updatedAt'").fetchone()
  finally:
    connection.close()

  if not album_rows or not song_rows:
    raise RuntimeError("Catalog database is empty. Refusing to build a release.")

  return {
    "albums": album_rows,
    "songs": song_rows,
    "updatedAt": updated_at_row[0] if updated_at_row else None,
  }


def compute_metrics(source, duckdb_path: Path):
  duckdb_path.parent.mkdir(parents=True, exist_ok=True)
  if duckdb_path.exists():
    duckdb_path.unlink()

  connection = duckdb.connect(str(duckdb_path))
  try:
    connection.execute(
      """
      CREATE TABLE albums (
        url VARCHAR,
        title VARCHAR,
        year INTEGER,
        track_count INTEGER,
        updated_at VARCHAR
      )
      """
    )
    connection.execute(
      """
      CREATE TABLE songs (
        id VARCHAR,
        album_url VARCHAR,
        title VARCHAR,
        movie VARCHAR,
        composer VARCHAR,
        artist VARCHAR,
        year INTEGER,
        audio_128_url VARCHAR,
        audio_320_url VARCHAR,
        updated_at VARCHAR
      )
      """
    )
    connection.executemany("INSERT INTO albums VALUES (?, ?, ?, ?, ?)", source["albums"])
    connection.executemany("INSERT INTO songs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", source["songs"])

    metrics = connection.execute(
      """
      SELECT
        (SELECT COUNT(*) FROM albums) AS album_count,
        (SELECT COUNT(*) FROM songs) AS song_count,
        (SELECT COUNT(*) FROM songs WHERE COALESCE(audio_128_url, '') <> '' OR COALESCE(audio_320_url, '') <> '') AS playable_song_count,
        (SELECT COUNT(*) FROM (SELECT id FROM songs GROUP BY id HAVING COUNT(*) > 1)) AS duplicate_song_ids,
        (SELECT COUNT(*) FROM songs WHERE TRIM(COALESCE(title, '')) = '') AS blank_song_titles,
        (SELECT COUNT(*) FROM songs WHERE TRIM(COALESCE(movie, '')) = '') AS blank_song_movies,
        (SELECT COUNT(*) FROM albums WHERE TRIM(COALESCE(url, '')) = '') AS blank_album_urls,
        (SELECT COUNT(DISTINCT movie) FROM songs WHERE TRIM(COALESCE(movie, '')) <> '') AS distinct_movie_count,
        (SELECT MAX(updated_at) FROM songs) AS latest_song_updated_at
      """
    ).fetchone()
  finally:
    connection.close()

  return {
    "albumCount": int(metrics[0] or 0),
    "songCount": int(metrics[1] or 0),
    "playableSongCount": int(metrics[2] or 0),
    "duplicateSongIds": int(metrics[3] or 0),
    "blankSongTitles": int(metrics[4] or 0),
    "blankSongMovies": int(metrics[5] or 0),
    "blankAlbumUrls": int(metrics[6] or 0),
    "distinctMovieCount": int(metrics[7] or 0),
    "latestSongUpdatedAt": metrics[8],
  }


def validate_metrics(metrics, baseline_path: Path):
  errors = []

  if metrics["duplicateSongIds"] > 0:
    errors.append(f"Found {metrics['duplicateSongIds']} duplicate song ids.")
  if metrics["blankSongTitles"] > 0:
    errors.append(f"Found {metrics['blankSongTitles']} songs with blank titles.")
  if metrics["blankAlbumUrls"] > 0:
    errors.append(f"Found {metrics['blankAlbumUrls']} albums with blank URLs.")

  if baseline_path.exists():
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    minimums = {
      "albumCount": int(baseline.get("minAlbumCount", 1)),
      "songCount": int(baseline.get("minSongCount", 1)),
      "playableSongCount": int(baseline.get("minPlayableSongCount", 1)),
      "distinctMovieCount": int(baseline.get("minDistinctMovieCount", 1)),
    }
    for key, minimum in minimums.items():
      if metrics[key] < minimum:
        errors.append(f"{key}={metrics[key]} is below the safe minimum {minimum}.")

  if errors:
    raise RuntimeError("Release validation failed:\n- " + "\n- ".join(errors))


def generate_seed(db_path: Path, seed_path: Path):
  subprocess.run(
    [
      sys.executable,
      str(ROOT / "cloudflare" / "scripts" / "export_d1_sql.py"),
      "--db",
      str(db_path),
      "--out",
      str(seed_path),
    ],
    cwd=str(ROOT),
    check=True,
  )
  if not seed_path.exists():
    raise RuntimeError(f"Seed file was not generated: {seed_path}")
  if seed_path.stat().st_size < 4096:
    raise RuntimeError(f"Seed file is unexpectedly small: {seed_path.stat().st_size} bytes")

  text = seed_path.read_text(encoding="utf-8", errors="ignore")
  required_markers = [
    "CREATE TABLE app_meta",
    "CREATE TABLE albums",
    "CREATE TABLE songs",
    "INSERT INTO app_meta",
    "INSERT INTO albums",
    "INSERT INTO songs",
  ]
  missing_markers = [marker for marker in required_markers if marker not in text]
  if missing_markers:
    raise RuntimeError(f"Seed file is missing required SQL markers: {', '.join(missing_markers)}")


def write_manifest(manifest_path: Path, metrics, source_updated_at):
  manifest_path.parent.mkdir(parents=True, exist_ok=True)
  manifest_path.write_text(
    json.dumps(
      {
        "albumCount": metrics["albumCount"],
        "songCount": metrics["songCount"],
        "playableSongCount": metrics["playableSongCount"],
        "distinctMovieCount": metrics["distinctMovieCount"],
        "latestSongUpdatedAt": metrics["latestSongUpdatedAt"],
        "catalogUpdatedAt": source_updated_at,
      },
      indent=2,
      sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
  )


def main():
  args = parse_args()
  args.db = args.db.resolve()
  args.seed = args.seed.resolve()
  args.baseline = args.baseline.resolve()
  args.manifest = args.manifest.resolve()
  args.duckdb_path = args.duckdb_path.resolve()
  source = validate_sqlite_source(args.db)
  metrics = compute_metrics(source, args.duckdb_path)
  validate_metrics(metrics, args.baseline)
  generate_seed(args.db, args.seed)
  write_manifest(args.manifest, metrics, source["updatedAt"])
  print(json.dumps({"ok": True, "metrics": metrics}, indent=2))


if __name__ == "__main__":
  main()
