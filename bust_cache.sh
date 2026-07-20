#!/usr/bin/env bash
# Bust cache by appending a version query param to local JS/CSS in public/index.html
# Uses a cross-platform Python helper instead of fragile sed.

set -euo pipefail

TARGET="public/index.html"
VERSION=$(date +%s)

python3 - "$TARGET" "$VERSION" <<'PYCODE'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text()

def needs_bust(url: str) -> bool:
    return not (url.startswith("http://") or url.startswith("https://") or url.startswith("//"))

def add_version(url: str) -> str:
    base, sep, query = url.partition('?')
    # strip existing v param if present
    if sep:
        params = [p for p in query.split('&') if not p.startswith('v=')]
        query = '&'.join(params)
        sep = '?' if query else ''
    if not needs_bust(base):
        return f"{base}{sep}{query}"
    joiner = '&' if query else '?'
    return f"{base}{sep}{query}{joiner}v={version}"

def replacer(match):
    prefix, url, suffix = match.groups()
    if not needs_bust(url):
        return match.group(0)
    new_url = add_version(url)
    return f"{prefix}{new_url}{suffix}"

# Update src/href attributes for local JS/CSS
pattern = re.compile(r'((?:src|href)=["\'])([^"\']+\.(?:js|css))(?:\?[^"\']*)?(["\'])')
text = pattern.sub(replacer, text)

# Update selftest dynamic loader (if present)
text = re.sub(r"('/selftest\.js)(\?[^']*)?'", rf"\1?v={version}'", text)

path.write_text(text)
print(f"Updated {path} assets to version {version}")
PYCODE
