#!/usr/bin/env python3

import os
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "tools" / "masstamilan_refresh.py"

os.environ.setdefault("SRUTHI_DATA_DIR", "data/telugu")
os.environ.setdefault("SRUTHI_MEDIA_DIR", "media/telugu")
os.environ.setdefault("SRUTHI_CACHE_AUDIO_DIR", ".cache/audio-telugu")

argv = sys.argv[1:]
if "--origin" not in argv:
    argv = ["--origin", "https://masstelugu.com", *argv]

sys.argv = [str(TARGET), *argv]
runpy.run_path(str(TARGET), run_name="__main__")
