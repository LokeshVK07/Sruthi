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
  parser.add_argument("--catalog", choices=["tamil", "telugu"], default="tamil")
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


def catalog_config(catalog: str):
  if catalog == "telugu":
    return {
      "data_db": ROOT / "data" / "telugu" / "sruthi.db",
      "wrangler_config": CLOUDFLARE_DIR / "wrangler.telugu.jsonc",
      "baseline": CLOUDFLARE_DIR / "data" / "release-baseline-telugu.json",
      "manifest": GENERATED_DIR / "release-manifest-telugu.json",
      "duckdb": GENERATED_DIR / "release-check-telugu.duckdb",
      "seed": CLOUDFLARE_DIR / "data" / "seed-telugu.sql",
      "active_slot_var": "SRUTHI_TELUGU_ACTIVE_D1_SLOT",
      "db_a_id_var": "SRUTHI_TELUGU_D1_DB_A_ID",
      "db_a_name_var": "SRUTHI_TELUGU_D1_DB_A_NAME",
      "db_b_id_var": "SRUTHI_TELUGU_D1_DB_B_ID",
      "db_b_name_var": "SRUTHI_TELUGU_D1_DB_B_NAME",
    }

  return {
    "data_db": ROOT / "data" / "sruthi.db",
    "wrangler_config": CLOUDFLARE_DIR / "wrangler.jsonc",
    "baseline": CLOUDFLARE_DIR / "data" / "release-baseline.json",
    "manifest": GENERATED_DIR / "release-manifest.json",
    "duckdb": GENERATED_DIR / "release-check.duckdb",
    "seed": CLOUDFLARE_DIR / "data" / "seed.sql",
    "active_slot_var": "SRUTHI_ACTIVE_D1_SLOT",
    "db_a_id_var": "SRUTHI_D1_DB_A_ID",
    "db_a_name_var": "SRUTHI_D1_DB_A_NAME",
    "db_b_id_var": "SRUTHI_D1_DB_B_ID",
    "db_b_name_var": "SRUTHI_D1_DB_B_NAME",
  }


def load_repo_variables(repo: str, config: dict):
  raw = run(["gh", "variable", "list", "--repo", repo, "--json", "name,value"], capture=True)
  rows = json.loads(raw)
  variables = {row["name"]: row["value"] for row in rows}
  required = [
    "CLOUDFLARE_ACCOUNT_ID",
    config["db_a_id_var"],
    config["db_a_name_var"],
    config["db_b_id_var"],
    config["db_b_name_var"],
    config["active_slot_var"],
  ]
  missing = [name for name in required if not variables.get(name)]
  if missing:
    raise SystemExit(f"Missing required GitHub repo variables for deploy: {', '.join(missing)}")
  return variables


def resolve_target_slot(variables, config: dict):
  active = variables[config["active_slot_var"]].strip().upper()
  if active not in {"A", "B"}:
    raise SystemExit(f"{config['active_slot_var']} must be A or B, got {active!r}")

  if active == "A":
    return {
      "active": "A",
      "target": "B",
      "database_id": variables[config["db_b_id_var"]],
      "database_name": variables[config["db_b_name_var"]],
    }

  return {
    "active": "B",
    "target": "A",
    "database_id": variables[config["db_a_id_var"]],
    "database_name": variables[config["db_a_name_var"]],
  }


def build_release(config: dict):
  ensure_file(config["data_db"])
  ensure_file(config["baseline"])
  GENERATED_DIR.mkdir(parents=True, exist_ok=True)

  run(
    [
      "python3",
      str(CLOUDFLARE_DIR / "scripts" / "prepare_release.py"),
      "--db",
      str(config["data_db"]),
      "--seed",
      str(config["seed"]),
      "--baseline",
      str(config["baseline"]),
      "--manifest",
      str(config["manifest"]),
      "--duckdb-path",
      str(config["duckdb"]),
    ]
  )


def render_config(database_id: str, database_name: str, account_id: str, wrangler_config: Path):
  GENERATED_DIR.mkdir(parents=True, exist_ok=True)
  suffix = ".telugu" if wrangler_config.name == "wrangler.telugu.jsonc" else ""
  output = GENERATED_DIR / f"wrangler.deploy{suffix}.jsonc"
  run(
    [
      "python3",
      str(CLOUDFLARE_DIR / "scripts" / "render_wrangler_config.py"),
      "--input",
      str(wrangler_config),
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


def load_manifest(path: Path):
  manifest_path = path
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


def import_and_validate_remote(config_path: Path, database_name: str, manifest, seed_path: Path):
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


def update_active_slot(repo: str, target_slot: str, variable_name: str):
  if target_slot not in {"A", "B"}:
    raise SystemExit(f"Refusing to write invalid target slot {target_slot!r}")
  run(
    ["gh", "variable", "set", variable_name, "--repo", repo, "--body", target_slot],
    cwd=ROOT,
  )


def main():
  args = parse_args()
  config = catalog_config(args.catalog)
  if not args.skip_asset_sync:
    sync_public_bundle()

  variables = load_repo_variables(args.repo, config)
  target = resolve_target_slot(variables, config)

  if not args.skip_release_build:
    build_release(config)

  config_path = render_config(
    target["database_id"],
    target["database_name"],
    variables["CLOUDFLARE_ACCOUNT_ID"],
    config["wrangler_config"],
  )
  validate_rendered_config(config_path)
  manifest = load_manifest(config["manifest"])
  import_and_validate_remote(config_path, target["database_name"], manifest, config["seed"])
  deploy_worker(config_path)

  if not args.skip_slot_update:
    update_active_slot(args.repo, target["target"], config["active_slot_var"])

  print(
    json.dumps(
      {
        "ok": True,
        "repo": args.repo,
        "activeSlotBefore": target["active"],
        "activeSlotAfter": target["target"] if not args.skip_slot_update else target["active"],
        "catalog": args.catalog,
        "databaseName": target["database_name"],
        "albumCount": manifest.get("albumCount"),
        "songCount": manifest.get("songCount"),
      },
      indent=2,
    )
  )


if __name__ == "__main__":
  main()
