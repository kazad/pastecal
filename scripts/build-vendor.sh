#!/usr/bin/env bash
# Build the self-hosted Syncfusion bundle: only the packages the calendar needs.
#
#   ./scripts/build-vendor.sh
#
# Writes public/vendor/syncfusion-<version>/:
#   ej2-calendar.min.js    the 15 packages ej2-schedule needs, in dependency order
#   material.css           their light theme
#   material-dark.css      their dark theme
#   MANIFEST.txt           sources, sizes and sha256 of each piece
#
# Why: the page used to load ej2.min.js -- all 50 Syncfusion packages, 4.4 MB over the
# wire, 20 MB to parse -- to use four of them (schedule, splitbuttons, data, base).
# On Fast 3G the calendar took 32s to appear, on Slow 3G 112s. This bundle is ~650 KB
# of JS. It also pins the CSS: index.html loaded the UNVERSIONED /ej2/material.css,
# which follows Syncfusion's latest release while the JS stayed on 23.2.6, so the theme
# and the components it styles could drift apart without any deploy of ours.
#
# The output is committed. Rerun only to change the Syncfusion version or the package
# list; the order below is ej2-schedule's dependency graph at this version (resolved
# from the npm registry), dependencies before dependents.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="23.2.6"
CDN="https://cdn.syncfusion.com/ej2/${VERSION}"
OUT="public/vendor/syncfusion-${VERSION}"

# ej2-icons ships no JS; ej2-base carries the icon font in its CSS.
PACKAGES=(
  ej2-base ej2-data ej2-buttons ej2-lists ej2-popups ej2-splitbuttons ej2-inputs
  ej2-calendars ej2-navigations ej2-notifications ej2-dropdowns
  ej2-file-utils ej2-compression ej2-excel-export ej2-schedule
)
# Packages with no stylesheet of their own.
NO_CSS=" ej2-data ej2-file-utils ej2-compression ej2-excel-export "

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
: > "$TMP/js"; : > "$TMP/light"; : > "$TMP/dark"
{
  echo "Syncfusion ${VERSION} -- calendar subset. Built by scripts/build-vendor.sh."
  echo "Do not edit; rerun the script."
  echo
} > "$TMP/manifest"

fetch() { # url dest
  local code
  code=$(curl -sSL -o "$2" -w '%{http_code}' "$1")
  [ "$code" = "200" ] || { echo "ERROR: $1 -> HTTP $code" >&2; exit 1; }
  [ -s "$2" ] || { echo "ERROR: $1 is empty" >&2; exit 1; }
}

for p in "${PACKAGES[@]}"; do
  fetch "$CDN/$p/dist/global/$p.min.js" "$TMP/$p.js"
  printf '\n/* ---- %s %s ---- */\n' "$p" "$VERSION" >> "$TMP/js"
  cat "$TMP/$p.js" >> "$TMP/js"
  echo "$(shasum -a 256 "$TMP/$p.js" | cut -c1-16)  $(wc -c < "$TMP/$p.js" | tr -d ' ') bytes  $CDN/$p/dist/global/$p.min.js" >> "$TMP/manifest"

  if [[ "$NO_CSS" != *" $p "* ]]; then
    for theme in material material-dark; do
      fetch "$CDN/$p/styles/$theme.css" "$TMP/$p.$theme.css"
      dest="$TMP/light"; [ "$theme" = "material-dark" ] && dest="$TMP/dark"
      cat "$TMP/$p.$theme.css" >> "$dest"; printf '\n' >> "$dest"
    done
  fi
done

# A remote @import must come first in a stylesheet or browsers ignore it; each package
# CSS starts with the same Roboto import, so hoist ONE to the top and drop the rest.
for theme in light dark; do
  python3 - "$TMP/$theme" <<'PY'
import re, sys
p = sys.argv[1]
css = open(p, encoding='utf8').read()
imports = re.findall(r'@import\s*(?:url\()?["\'][^"\']+["\']\)?\s*;', css)
css = re.sub(r'@import\s*(?:url\()?["\'][^"\']+["\']\)?\s*;', '', css)
keep = imports[:1]
open(p, 'w', encoding='utf8').write(''.join(keep) + '\n' + css)
PY
done

cp "$TMP/js" "$OUT/ej2-calendar.min.js"
cp "$TMP/light" "$OUT/material.css"
cp "$TMP/dark" "$OUT/material-dark.css"
{
  cat "$TMP/manifest"
  echo
  for f in ej2-calendar.min.js material.css material-dark.css; do
    echo "$f  $(wc -c < "$OUT/$f" | tr -d ' ') bytes  sha256 $(shasum -a 256 "$OUT/$f" | cut -c1-16)"
  done
} > "$OUT/MANIFEST.txt"

echo "Built $OUT:"
ls -la "$OUT"
