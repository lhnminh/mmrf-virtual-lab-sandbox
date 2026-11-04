#!/usr/bin/env bash
# Builds build/agent.zip for AgentCore Runtime: ARM64 Linux, Python 3.13, modules at the zip root.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
build="$root/build"
target="$build/agent"

rm -rf "$build"
mkdir -p "$target"

(cd "$root/agent" && uv export --frozen --no-dev --no-emit-project --no-hashes -o "$build/requirements.txt" >/dev/null)
uv pip install --quiet --target "$target" \
  --python-platform aarch64-manylinux2014 --python-version 3.13 --only-binary=:all: \
  -r "$build/requirements.txt"

cp "$root/agent/main.py" "$root/agent/runs.py" "$root/agent/cohort.py" "$target/"
find "$target" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$target" -type d -exec chmod 755 {} +
find "$target" -type f -exec chmod 644 {} +

(cd "$target" && zip -q -r -X "$build/agent.zip" .)
echo "$build/agent.zip"
