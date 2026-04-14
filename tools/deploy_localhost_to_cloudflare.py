#!/usr/bin/env python3

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLOUDFLARE_DIR = ROOT / "cloudflare"
PUBLIC_DIR = CLOUDFLARE_DIR / "public"
GENERATED_DIR = CLOUDFLARE_DIR / ".generated"
DEFAULT_REPO = "LokeshVK07/Sruthi"

ROOT_PUBLIC_FILES = [
  "index.html",
  "app.js",
  "app-new.js",
  "styles.css",
  "styles-new.css",
  "Sruthi_kutty.jpg",
]


def parse_args():
  parser = argparse.ArgumentParser(
    description="Deploy the full current localhost-visible Sruthi state to Cloudflare safely."
  )
  parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repo used to read and update deploy slot variables.")
  parser.add_argument("--skip-slot-update", action="store_true", help="Deploy without updating SRUTHI_ACTIVE_D1_SLOT.")
  parser.add_argument("--skip-asset-sync", action="store_true", help="Assume cloudflare/public is already in sync.")
  parser.add_argument("--skip-release-build", action="store_true", help="Assume cloudflare/data/seed.sql is already valid.")
  return parser.parse_args()


def run(cmd, *, cwd=ROOT, capture=False):
  print(f"$ {' '.join(cmd)}")
  result = subprocess.run(
    cmd,
    cwd=str(cwd),
    check=False,
    text=True,
    capture_output=capture,
  )
  if result.returncode != 0:
    if capture:
      if result.stdout:
        print(result.stdout)
      if result.stderr:
        print(result.stderr, file=sys.stderr)
    raise SystemExit(result.returncode)
  return result.stdout if capture else ""


def ensure_file(path: Path):
  if not path.exists():
    raise SystemExit(f"Required file is missing: {path}")


def sync_public_bundle():
  PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
  for relative in ROOT_PUBLIC_FILES:
    source = ROOT / relative
    destination = PUBLIC_DIR / relative
    ensure_file(source)
    shutil.copy2(source, destination)

  # Keep -new assets aligned with the current localhost source of truth.
  shutil.copy2(ROOT / "app.js", ROOT / "app-new.js")
  shutil.copy2(ROOT / "styles.css", ROOT / "styles-new.css")
  shutil.copy2(ROOT / "app.js", PUBLIC_DIR / "app-new.js")
  shutil.copy2(ROOT / "styles.css", PUBLIC_DIR / "styles-new.css")


def load_repo_variables(repo: str):
  raw = run(["gh", "variable", "list", "--repo", repo, "--json", "name,value"], capture=True)
  rows = json.loads(raw)
  variables = {row["name"]: row["value"] for row in rows}
  required = [
    "CLOUDFLARE_ACCOUNT_ID",
    "SRUTHI_D1_DB_A_ID",
    "SRUTHI_D1_DB_A_NAME",
    "SRUTHI_D1_DB_B_ID",
    "SRUTHI_D1_DB_B_NAME",
    "SRUTHI_ACTIVE_D1_SLOT",
  ]
  missing = [name for name in required if not variables.get(name)]
  if missing:
    raise SystemExit(f"Missing required GitHub repo variables for deploy: {', '.join(missing)}")
  return variables


def resolve_target_slot(variables):
  active = variables["SRUTHI_ACTIVE_D1_SLOT"].strip().upper()
  if active not in {"A", "B"}:
    raise SystemExit(f"SRUTHI_ACTIVE_D1_SLOT must be A or B, got {active!r}")

  if active == "A":
    return {
      "active": "A",
      "target": "B",
      "database_id": variables["SRUTHI_D1_DB_B_ID"],
      "database_name": variables["SRUTHI_D1_DB_B_NAME"],
    }

  return {
    "active": "B",
    "target": "A",
    "database_id": variables["SRUTHI_D1_DB_A_ID"],
    "database_name": variables["SRUTHI_D1_DB_A_NAME"],
  }


def build_release():
  ensure_file(ROOT / "data" / "sruthi.db")
  ensure_file(CLOUDFLARE_DIR / "data" / "release-baseline.json")
  GENERATED_DIR.mkdir(parents=True, exist_ok=True)

  run(
    [
      "python3",
      str(CLOUDFLARE_DIR / "scripts" / "prepare_release.py"),
      "--db",
      str(ROOT / "data" / "sruthi.db"),
      "--seed",
      str(CLOUDFLARE_DIR / "data" / "seed.sql"),
      "--baseline",
      str(CLOUDFLARE_DIR / "data" / "release-baseline.json"),
      "--manifest",
      str(GENERATED_DIR / "release-manifest.json"),
      "--duckdb-path",
      str(GENERATED_DIR / "release-check.duckdb"),
    ]
  )


def render_config(database_id: str, database_name: str, account_id: str):
  GENERATED_DIR.mkdir(parents=True, exist_ok=True)
  output = GENERATED_DIR / "wrangler.deploy.jsonc"
  run(
    [
      "python3",
      str(CLOUDFLARE_DIR / "scripts" / "render_wrangler_config.py"),
      "--input",
      str(CLOUDFLARE_DIR / "wrangler.jsonc"),
      "--output",
      str(output),
      "--database-id",
      database_id,
      "--database-name",
      database_name,
      "--account-id",
      account_id,
    ]
  )
  ensure_file(output)
  return output


def load_manifest():
  manifest_path = GENERATED_DIR / "release-manifest.json"
  ensure_file(manifest_path)
  return json.loads(manifest_path.read_text(encoding="utf-8"))


def extract_count_from_d1_json(payload_text: str):
  payload = json.loads(payload_text)
  stack = [payload]
  while stack:
    item = stack.pop()
    if isinstance(item, dict):
      if "count" in item:
        return int(item["count"])
      stack.extend(item.values())
    elif isinstance(item, list):
      stack.extend(item)
  raise SystemExit("Unable to find count field in D1 JSON response.")


def validate_rendered_config(config_path: Path):
  payload = json.loads(config_path.read_text(encoding="utf-8"))
  main_path = Path(payload.get("main", ""))
  assets_dir = Path((payload.get("assets") or {}).get("directory", ""))
  d1_databases = payload.get("d1_databases") or []
  if not main_path.is_file():
    raise SystemExit(f"Rendered Wrangler main entry is invalid: {main_path}")
  if not assets_dir.is_dir():
    raise SystemExit(f"Rendered Wrangler assets directory is invalid: {assets_dir}")
  if not d1_databases or not d1_databases[0].get("database_id") or not d1_databases[0].get("database_name"):
    raise SystemExit("Rendered Wrangler config is missing D1 database binding details.")


def import_and_validate_remote(config_path: Path, database_name: str, manifest):
  seed_path = CLOUDFLARE_DIR / "data" / "seed.sql"
  ensure_file(seed_path)

  run(
    [
      "npx",
      "wrangler",
      "d1",
      "execute",
      database_name,
      "--remote",
      "--file",
      str(seed_path),
      "--config",
      str(config_path),
    ],
    cwd=CLOUDFLARE_DIR,
  )

  album_payload = run(
    [
      "npx",
      "wrangler",
      "d1",
      "execute",
      database_name,
      "--remote",
      "--command",
      "SELECT COUNT(*) AS count FROM albums;",
      "--config",
      str(config_path),
      "--json",
    ],
    cwd=CLOUDFLARE_DIR,
    capture=True,
  )
  song_payload = run(
    [
      "npx",
      "wrangler",
      "d1",
      "execute",
      database_name,
      "--remote",
      "--command",
      "SELECT COUNT(*) AS count FROM songs;",
      "--config",
      str(config_path),
      "--json",
    ],
    cwd=CLOUDFLARE_DIR,
    capture=True,
  )

  remote_album_count = extract_count_from_d1_json(album_payload)
  remote_song_count = extract_count_from_d1_json(song_payload)
  expected_album_count = int(manifest.get("albumCount", 0))
  expected_song_count = int(manifest.get("songCount", 0))

  if remote_album_count != expected_album_count or remote_song_count != expected_song_count:
    raise SystemExit(
      "Remote D1 validation failed: "
      f"expected albums={expected_album_count}, songs={expected_song_count} "
      f"but got albums={remote_album_count}, songs={remote_song_count}"
    )


def deploy_worker(config_path: Path):
  run(
    ["npx", "wrangler", "deploy", "--config", str(config_path)],
    cwd=CLOUDFLARE_DIR,
  )


def update_active_slot(repo: str, target_slot: str):
  if target_slot not in {"A", "B"}:
    raise SystemExit(f"Refusing to write invalid target slot {target_slot!r}")
  run(
    ["gh", "variable", "set", "SRUTHI_ACTIVE_D1_SLOT", "--repo", repo, "--body", target_slot],
    cwd=ROOT,
  )


def main():
  args = parse_args()
  if not args.skip_asset_sync:
    sync_public_bundle()

  variables = load_repo_variables(args.repo)
  target = resolve_target_slot(variables)

  if not args.skip_release_build:
    build_release()

  config_path = render_config(
    target["database_id"],
    target["database_name"],
    variables["CLOUDFLARE_ACCOUNT_ID"],
  )
  validate_rendered_config(config_path)
  manifest = load_manifest()
  import_and_validate_remote(config_path, target["database_name"], manifest)
  deploy_worker(config_path)

  if not args.skip_slot_update:
    update_active_slot(args.repo, target["target"])

  print(
    json.dumps(
      {
        "ok": True,
        "repo": args.repo,
        "activeSlotBefore": target["active"],
        "activeSlotAfter": target["target"] if not args.skip_slot_update else target["active"],
        "databaseName": target["database_name"],
        "albumCount": manifest.get("albumCount"),
        "songCount": manifest.get("songCount"),
      },
      indent=2,
    )
  )


if __name__ == "__main__":
  main()
