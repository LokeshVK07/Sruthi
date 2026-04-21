#!/usr/bin/env python3

import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "tools" / "deploy_localhost_to_cloudflare.py"

sys.argv = [str(TARGET), "--catalog", "telugu", *sys.argv[1:]]
runpy.run_path(str(TARGET), run_name="__main__")
