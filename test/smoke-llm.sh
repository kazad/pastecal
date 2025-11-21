#!/usr/bin/env bash
set -euo pipefail

tool="/Users/kazad/dev/llm-toolbox/bin/llm-snap"
url="http://localhost:8000/"
desc="smoke-llm"

if [[ ! -x "$tool" ]]; then
  echo "llm-snap not found at $tool" >&2
  exit 1
fi

output="$($tool "$url" --desc="$desc" 2>&1)" || true
echo "$output"

# Fail on errors surfaced by llm-snap console capture
if grep -E "\[ERROR\]" <<<"$output"; then
  printf '\033[31mFAILED\033[0m smoke: console errors detected\n' >&2
  exit 1
fi

printf '\033[32mPASSED\033[0m smoke: no console errors\n'
