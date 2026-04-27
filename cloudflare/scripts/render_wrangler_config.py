#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


def parse_args():
  parser = argparse.ArgumentParser(description="Render a temporary wrangler config for a target D1 slot.")
  parser.add_argument("--input", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--database-id", required=True)
  parser.add_argument("--database-name", required=True)
  parser.add_argument("--account-id", default="")
  return parser.parse_args()


def resolve_path(base_dir: Path, raw_value: str):
  candidate = Path(raw_value)
  if not candidate.is_absolute():
    candidate = (base_dir / candidate).resolve()
  return candidate


def rewrite_path_field(config: dict, base_dir: Path, parent_key: str, field_key: str, *, must_be_dir=False):
  parent = config.get(parent_key)
  if not isinstance(parent, dict):
    return
  raw_value = parent.get(field_key)
  if not raw_value:
    return
  resolved = resolve_path(base_dir, raw_value)
  if must_be_dir:
    if not resolved.is_dir():
      raise RuntimeError(f"Expected {parent_key}.{field_key} to point to a directory, but it does not exist: {resolved}")
  else:
    if not resolved.exists():
      raise RuntimeError(f"Expected {parent_key}.{field_key} to exist, but it does not: {resolved}")
  parent[field_key] = str(resolved)


def main():
  args = parse_args()
  input_path = args.input.resolve()
  output_path = args.output.resolve()

  if not input_path.exists():
    raise RuntimeError(f"Wrangler config input file does not exist: {input_path}")

  config = json.loads(input_path.read_text(encoding="utf-8"))
  config_dir = input_path.parent
  databases = config.get("d1_databases") or []
  if not databases:
    raise RuntimeError("wrangler config has no d1_databases entry.")
  databases[0]["database_id"] = args.database_id
  databases[0]["database_name"] = args.database_name

  main_path = config.get("main")
  if not main_path:
    raise RuntimeError("wrangler config is missing the `main` worker entry.")
  resolved_main = resolve_path(config_dir, main_path)
  if not resolved_main.is_file():
    raise RuntimeError(f"Worker entry file was not found: {resolved_main}")
  config["main"] = str(resolved_main)

  rewrite_path_field(config, config_dir, "assets", "directory", must_be_dir=True)
  rewrite_path_field(config, config_dir, "site", "bucket", must_be_dir=True)
  rewrite_path_field(config, config_dir, "build", "cwd", must_be_dir=True)

  if args.account_id:
    config["account_id"] = args.account_id

  output_path.parent.mkdir(parents=True, exist_ok=True)
  output_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
  print(output_path)


if __name__ == "__main__":
  main()
