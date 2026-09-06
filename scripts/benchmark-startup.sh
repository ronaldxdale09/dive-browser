#!/usr/bin/env bash
# Every requested launch must paint, become usable, and exit normally.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${SCRIPT_DIR}/startup_benchmark.py"
