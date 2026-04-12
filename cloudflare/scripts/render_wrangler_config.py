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
  return parser.parse_args()


def main():
  args = parse_args()
  config = json.loads(args.input.read_text(encoding="utf-8"))
  databases = config.get("d1_databases") or []
  if not databases:
    raise RuntimeError("wrangler config has no d1_databases entry.")
  databases[0]["database_id"] = args.database_id
  databases[0]["database_name"] = args.database_name
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
  print(args.output)


if __name__ == "__main__":
  main()
