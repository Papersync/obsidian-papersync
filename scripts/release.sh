#!/usr/bin/env bash
# Keep the existing npm entry point; all three explicit stages live in release.mjs.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/release.mjs" "$@"
