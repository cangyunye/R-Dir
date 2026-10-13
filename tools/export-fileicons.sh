#!/usr/bin/env bash
#
# export-fileicons.sh — scale 1024 transparent masters into the app asset set.
#
# Layout (repo root = R-Dir):
#   assets-src/fileicons/masters/{kind}.png          1024x1024 transparent master
#   rust-file-manager/src/assets/fileicons/
#     {kind}-lg.png        128px   (icon view, down-uses: 48/64/96/128)
#     {kind}-lg@2x.png      256px
#     {kind}-sm.png         16px   (detail rows / search / quick jump)
#     {kind}-sm@2x.png      32px
#
# If a simplified small variant exists as {kind}-sm-src.png in the master dir,
# it is used for the sm outputs instead of down-sampling the detailed master
# (keeps 16px icons recognizable). This is progressive — optional.
#
# 缩放用 PIL（Lanczos）而不是 sips：sips 缩放 RGBA 会损坏 alpha 通道
# （大面积不透明区域被错误半透明化，白纸图标在深色模式下只剩描边）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"            # rust-file-manager
REPO_ROOT="$(cd "$APP_ROOT/.." && pwd)"       # R-Dir
MASTER_DIR="$REPO_ROOT/assets-src/fileicons/masters"
OUT_DIR="$APP_ROOT/src/assets/fileicons"

mkdir -p "$OUT_DIR"
python3 - "$MASTER_DIR" "$OUT_DIR" <<'PY'
import os
import sys

from PIL import Image

master_dir, out_dir = sys.argv[1], sys.argv[2]
KINDS = ["folder", "image", "video", "audio", "archive", "code", "doc",
         "sheet", "slide", "text", "pdf", "app", "file"]
SPECS = [  # (输出名, 目标边长, 小图回退来源)
    ("-lg.png", 128, None), ("-lg@2x.png", 256, None),
    ("-sm.png", 16, "-sm-src"), ("-sm@2x.png", 32, "-sm-src"),
]

def load(master_path: str, kind: str, sm_fallback: str | None) -> Image.Image:
    if sm_fallback:
        p = os.path.join(master_dir, kind + sm_fallback + ".png")
        if os.path.isfile(p):
            return Image.open(p).convert("RGBA")
    return Image.open(master_path).convert("RGBA")

for kind in KINDS:
    master_path = os.path.join(master_dir, kind + ".png")
    if not os.path.isfile(master_path):
        print(f"!! missing master: {master_path} (skip, falls back to lucide)", file=sys.stderr)
        continue
    for suffix, size, sm_fallback in SPECS:
        im = load(master_path, kind, sm_fallback if size <= 32 else None)
        out = im.resize((size, size), Image.LANCZOS)
        out.save(os.path.join(out_dir, kind + suffix))
    print("ok ", kind)
print("exported ->", out_dir)
PY
