#!/usr/bin/env bash
# ==============================================================================
# Dive Browser Optimization — E2E Test Suite Runner
# Executes Tiers 1-4 requirement-driven opaque-box integration & E2E tests.
#
# Usage:
#   ./scripts/run-e2e-tests.sh [options]
#
# Options:
#   --tier <1|2|3|4|all>      Run only tests in the specified tier (default: all)
#   --feature <r1|r2|r3|r4>   Filter by feature area (default: all)
#   --verbose, -v             Show full test output and logging
#   --help, -h                Show this help message
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TIER="all"
FEATURE="all"
VERBOSE=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      TIER="$2"
      shift 2
      ;;
    --feature)
      FEATURE="$2"
      shift 2
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      head -n 14 "$0" | tail -n 12
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

FILTER=""

# Apply Tier filtering
case "$TIER" in
  1)
    FILTER="tier1_feature_coverage"
    ;;
  2)
    FILTER="tier2_boundaries"
    ;;
  3)
    FILTER="tier3_interactions"
    ;;
  4)
    FILTER="tier4_scenarios"
    ;;
  all)
    FILTER=""
    ;;
  *)
    echo "Unknown tier: $TIER. Valid values: 1, 2, 3, 4, all" >&2
    exit 1
    ;;
esac

# Apply Feature filtering if specified
if [[ "$FEATURE" != "all" ]]; then
  case "$FEATURE" in
    r1|R1)
      if [[ -z "$FILTER" ]]; then
        FILTER="r1"
      else
        FILTER="${FILTER}::.*r1"
      fi
      ;;
    r2|R2)
      if [[ -z "$FILTER" ]]; then
        FILTER="r2"
      else
        FILTER="${FILTER}::.*r2"
      fi
      ;;
    r3|R3)
      if [[ -z "$FILTER" ]]; then
        FILTER="r3"
      else
        FILTER="${FILTER}::.*r3"
      fi
      ;;
    r4|R4)
      if [[ -z "$FILTER" ]]; then
        FILTER="r4"
      else
        FILTER="${FILTER}::.*r4"
      fi
      ;;
    *)
      echo "Unknown feature: $FEATURE. Valid values: r1, r2, r3, r4, all" >&2
      exit 1
      ;;
  esac
fi

echo "=============================================================================="
echo "          Dive Browser Optimization — E2E Test Suite Runner"
echo "=============================================================================="
echo "Workspace: $ROOT_DIR"
echo "Tier:      $TIER"
echo "Feature:   $FEATURE"
echo "Filter:    ${FILTER:-<none>}"
echo "=============================================================================="
echo ""

CARGO_CMD=("cargo" "test" "-p" "dive-integration")

if [[ -n "$FILTER" ]]; then
  CARGO_CMD+=("$FILTER")
fi

CARGO_CMD+=("--")

if [[ "$VERBOSE" = true ]]; then
  CARGO_CMD+=("--nocapture")
fi

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  CARGO_CMD+=("${EXTRA_ARGS[@]}")
fi

START_TIME=$(date +%s)

set +e
"${CARGO_CMD[@]}"
EXIT_CODE=$?
set -e

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=============================================================================="
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "  STATUS: PASSED (Duration: ${DURATION}s)"
  echo "  All requirement-driven E2E tests verified successfully."
else
  echo "  STATUS: FAILED (Exit Code: $EXIT_CODE, Duration: ${DURATION}s)"
fi
echo "=============================================================================="

exit $EXIT_CODE
