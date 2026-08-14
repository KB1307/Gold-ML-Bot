#!/usr/bin/env bash
# ITEM 77(d) — Resolver deployment drift-check.
# Three controlled probes in one command so resolver deployment state is
# checkable from now on. Repo/production drift has cost this project twice
# (migration 003 and the resolver itself); this script makes a third occurrence
# immediately detectable.
#
#   1. POSITIVE CONTROL: refresh-sr-zones (known deployed)
#   2. NEGATIVE CONTROL: no-such-function-xyz (known nonexistent)
#   3. TARGET: resolve-emitted-signals (the function under test)
#
# Usage:  bash scripts/check_resolver_deployment.sh
# Exit 0 if all three probes return expected codes, 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Load from expo/.env (where Rork places it) or project-root .env
ENV_FILE=""
for candidate in "$PROJECT_ROOT/expo/.env" "$PROJECT_ROOT/.env" "$SCRIPT_DIR/../.env"; do
  if [ -f "$candidate" ]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [ -n "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SUPA_URL="${EXPO_PUBLIC_SUPABASE_URL:-}"
SRK="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPA_URL" ] || [ -z "$SRK" ]; then
  echo "ERROR: EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
  exit 1
fi

echo "=== Resolver Deployment Drift Check ==="
echo "Target: $SUPA_URL"
echo "Time:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Probe 1: Positive control
STATUS1=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SUPA_URL/functions/v1/refresh-sr-zones" \
  -H "Authorization: Bearer $SRK" \
  -H "apikey: $SRK")
echo "PROBE 1 — POSITIVE CONTROL (refresh-sr-zones): HTTP $STATUS1"
if [ "$STATUS1" = "200" ]; then echo "  PASS"; else echo "  FAIL — expected 200"; fi
echo ""

# Probe 2: Negative control
STATUS2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SUPA_URL/functions/v1/no-such-function-xyz" \
  -H "Authorization: Bearer $SRK" \
  -H "apikey: $SRK")
echo "PROBE 2 — NEGATIVE CONTROL (no-such-function-xyz): HTTP $STATUS2"
if [ "$STATUS2" = "404" ]; then echo "  PASS"; else echo "  FAIL — expected 404"; fi
echo ""

# Probe 3: Target
RESPONSE3=$(curl -s -w "\n%{http_code}" -X POST \
  "$SUPA_URL/functions/v1/resolve-emitted-signals" \
  -H "Authorization: Bearer $SRK" \
  -H "apikey: $SRK")
STATUS3=$(echo "$RESPONSE3" | tail -1)
BODY3=$(echo "$RESPONSE3" | head -n -1)
echo "PROBE 3 — TARGET (resolve-emitted-signals): HTTP $STATUS3"
echo "  Body: $BODY3"
if [ "$STATUS3" = "200" ]; then echo "  PASS"; else echo "  FAIL — expected 200"; fi
echo ""

# Summary
ALL_PASS=true
[ "$STATUS1" != "200" ] && ALL_PASS=false
[ "$STATUS2" != "404" ] && ALL_PASS=false
[ "$STATUS3" != "200" ] && ALL_PASS=false

if [ "$ALL_PASS" = true ]; then
  echo "RESULT: All probes passed. Resolver is deployed and reachable."
  exit 0
else
  echo "RESULT: One or more probes FAILED. Repo/production drift detected."
  exit 1
fi
