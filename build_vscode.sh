#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

pnpm build:all
cd packages/vscode
pnpm package
