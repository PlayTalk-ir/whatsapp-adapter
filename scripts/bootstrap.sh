#!/usr/bin/env bash
# Install a private Node 22 (does not replace the system node) and production deps.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whatsapp-adapter}"
NODE_DIR="$APP_DIR/.node"

node_ok() {
  [[ -x "$NODE_DIR/bin/node" ]] || return 1
  "$NODE_DIR/bin/node" -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<22 || (maj===22 && min<13)) process.exit(1)'
}

if ! node_ok; then
  ver=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt \
    | sed -n 's/.*node-\(v22\.[0-9.]*\)-linux-x64\.tar\.xz.*/\1/p' | head -1)
  if [[ -z "$ver" ]]; then
    echo "could not resolve the latest Node 22 release" >&2
    exit 1
  fi
  tmp=$(mktemp)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/node-${ver}-linux-x64.tar.xz" -o "$tmp"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp" -C "$NODE_DIR" --strip-components=1
  rm -f "$tmp"
  echo "installed Node $ver under $NODE_DIR"
fi

cd "$APP_DIR"
"$NODE_DIR/bin/npm" ci --omit=dev
install -d -m 0700 "$APP_DIR/data"
