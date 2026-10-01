#!/usr/bin/env bash
# Converts SVG figures to PDF for docs/main.tex, keeping them as vectors, by printing each one from headless Chrome at its own size.
#
#     scripts/figures_pdf.sh docs/figures/11-benchmark-picture-rate.svg ...
set -euo pipefail
chrome=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
if [ -z "$chrome" ]; then
  echo "needs Chrome or Chromium to print the figures" >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for svg in "$@"; do
  read -r w h < <(grep -o 'viewBox="0 0 [0-9.]* [0-9.]*"' "$svg" | head -1 | tr -dc '0-9. ' | awk '{print $3, $4}')
  html="$tmp/$(basename "$svg" .svg).html"
  printf '<html><head><style>@page{size:%spx %spx;margin:0}html,body{margin:0}</style></head><body>%s</body></html>' "$w" "$h" "$(cat "$svg")" > "$html"
  "$chrome" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${svg%.svg}.pdf" "file://$html" 2>/dev/null
  echo "${svg%.svg}.pdf"
done
