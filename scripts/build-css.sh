#!/usr/bin/env bash
# Compile public/tailwind.css from the class names used in public/ (see tailwind.config.js).
# deploy.sh runs this before every hosting deploy, so a new class can never ship unstyled.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./node_modules/.bin/tailwindcss ] || { echo "ERROR: run npm install first (tailwindcss missing)."; exit 1; }
./node_modules/.bin/tailwindcss -c tailwind.config.js -i scripts/css/tailwind.input.css -o public/tailwind.css --minify
echo "Built public/tailwind.css ($(wc -c < public/tailwind.css | tr -d ' ') bytes)"
