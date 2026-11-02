#!/usr/bin/env bash
# WORKAROUND: Herdr (seen on 0.1.12) draws nothing for an svg()/image() path that resolves
# through a symlink outside ~/.config/herdr-app: a symlinked mod folder (mods/<mod> -> this repo)
# or a symlink to the image file itself. The mod's JS loads fine either way. So copy each mod's
# images into a real folder, ~/.config/herdr-app/assets/<mod>/, and reference them as
# "assets/<mod>/<file>". Rerun after adding or changing an image. Remove this once Herdr loads
# assets through symlinks.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

for mod in "$repo"/mods/*/; do
  name="$(basename "$mod")"
  shopt -s nullglob
  images=("$mod"*.svg "$mod"*.png "$mod"*.jpg "$mod"*.jpeg "$mod"*.webp "$mod"*.gif)
  shopt -u nullglob
  [ ${#images[@]} -eq 0 ] && continue
  dest="$home/assets/$name"
  mkdir -p "$dest"
  for f in "${images[@]}"; do
    rm -f "$dest/$(basename "$f")"
    cp "$f" "$dest/"
    echo "copied assets/$name/$(basename "$f")"
  done
done
