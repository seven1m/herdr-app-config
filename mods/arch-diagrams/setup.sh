#!/usr/bin/env bash
# Installs the Mermaid renderer this mod runs: mermaid-cli and a headless Chrome, both kept in
# hidden folders (and node_modules) here so installing them doesn't reload the mod.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || eval "$(devbox global shellenv)"
npm install --prefix . --no-save --no-package-lock @mermaid-js/mermaid-cli
PUPPETEER_CACHE_DIR="$PWD/.chrome" npx --prefix . puppeteer browsers install chrome-headless-shell
chrome=$(echo "$PWD"/.chrome/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell)
printf '{"executablePath":"%s","headless":"shell"}\n' "$chrome" > .puppeteer.json
command -v node > .node-path
echo "ready: $(cat .node-path), $chrome"
