#!/bin/bash
# Diff two WS_UNSORTED vectors index-for-index.
# Usage: ./diff_ws_vectors.sh <run1_file> <run2_file> <output_file>
# Extracts the WS_UNSORTED vector from each harness output, saves one value per line,
# then diffs index-for-index and reports which evaluations differ and whether they
# crossed the 0.55 conviction threshold.

set -e

RUN1="$1"
RUN2="$2"
OUT="$3"

# Extract WS_UNSORTED vector (between BEGIN and END markers) from each run
grep -oP 'WS_UNSORTED_BEGIN \K[0-9.,]+(?= WS_UNSORTED_END)' "$RUN1" | tr ',' '\n' > /tmp/ws_vec1.txt
grep -oP 'WS_UNSORTED_BEGIN \K[0-9.,]+(?= WS_UNSORTED_END)' "$RUN2" | tr ',' '\n' > /tmp/ws_vec2.txt

LEN1=$(wc -l < /tmp/ws_vec1.txt)
LEN2=$(wc -l < /tmp/ws_vec2.txt)

echo "RUN1 vector length: $LEN1" | tee "$OUT"
echo "RUN2 vector length: $LEN2" | tee -a "$OUT"
echo "" | tee -a "$OUT"

if [ "$LEN1" -ne "$LEN2" ]; then
  echo "ERROR: Vector lengths differ ($LEN1 vs $LEN2) — cannot diff index-for-index." | tee -a "$OUT"
  exit 1
fi

# Python script for the diff
python3 -c "
import sys

with open('/tmp/ws_vec1.txt') as f:
    v1 = [float(line.strip()) for line in f if line.strip()]
with open('/tmp/ws_vec2.txt') as f:
    v2 = [float(line.strip()) for line in f if line.strip()]

THRESHOLD = 0.55
n = min(len(v1), len(v2))
diffs = []
crossed = 0
run1_pass = sum(1 for v in v1 if v >= THRESHOLD)
run2_pass = sum(1 for v in v2 if v >= THRESHOLD)
both_pass = 0
neither_pass = 0
run1_only = 0
run2_only = 0

for i in range(n):
    if abs(v1[i] - v2[i]) > 0.0001:
        diffs.append(i)
        r1_above = v1[i] >= THRESHOLD
        r2_above = v2[i] >= THRESHOLD
        if r1_above != r2_above:
            crossed += 1
            label = ' *** CROSSED ***'
        else:
            label = ''
        print(f'idx={i:<6d} run1={v1[i]:.4f} ({\"ABOVE\" if r1_above else \"below\"}) run2={v2[i]:.4f} ({\"ABOVE\" if r2_above else \"below\"}){label}')
    if v1[i] >= THRESHOLD and v2[i] >= THRESHOLD:
        both_pass += 1
    elif v1[i] < THRESHOLD and v2[i] < THRESHOLD:
        neither_pass += 1
    elif v1[i] >= THRESHOLD:
        run1_only += 1
    else:
        run2_only += 1

print()
print(f'=== SUMMARY ===')
print(f'total values:     {n}')
print(f'differences:      {len(diffs)}')
print(f'crossed {THRESHOLD}:     {crossed}')
print()
print(f'RUN1 pass (>={THRESHOLD}): {run1_pass}')
print(f'RUN2 pass (>={THRESHOLD}): {run2_pass}')
print(f'both pass:          {both_pass}')
print(f'neither pass:       {neither_pass}')
print(f'RUN1-only pass:     {run1_only}')
print(f'RUN2-only pass:     {run2_only}')
print()
pct_diff = len(diffs) / n * 100 if n > 0 else 0
pct_crossed = crossed / n * 100 if n > 0 else 0
pct_rejection = abs(run1_pass - run2_pass) / n * 100 if n > 0 else 0
print(f'rejection-count residual: {abs(run1_pass - run2_pass)} / {n} = {pct_rejection:.4f}%')
print(f'value-distribution residual (differences): {len(diffs)} / {n} = {pct_diff:.4f}%')
print(f'threshold crossings: {crossed} / {len(diffs)} shifted = {crossed / len(diffs) * 100 if diffs else 0:.1f}% of shifts crossed 0.55')
" | tee -a "$OUT"
