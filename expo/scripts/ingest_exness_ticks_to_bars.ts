/**
 * ONE-OFF DATA TOOL: aggregates raw Exness XAUUSDm bid/ask tick exports (CSV)
 * into 1-minute OHLC bars and writes a CSV ready for COPY-loading into the
 * Supabase `gold_m1_bars` table.
 *
 * INPUT CSV FORMAT (as provided by the user):
 *   col A: broker tag (e.g. "exness")            - ignored
 *   col B: symbol (e.g. "XAUUSDm")                - ignored
 *   col C: tick timestamp, UTC+0, e.g.
 *          "2026-07-13 00:00:00.009Z"             - AUTHORITATIVE, parsed as
 *          true UTC (the trailing "Z" makes JS Date parse it as an absolute
 *          instant regardless of the space instead of "T" separator).
 *   col D: a spreadsheet-computed UTC+2 helper column - NOT used here. It is
 *          truncated to whole seconds and has occasional "#VALUE!" errors at
 *          day boundaries, so it is unreliable. We derive UTC+2 (or any other
 *          zone) purely by formatting the epoch-ms value from column C - the
 *          absolute instant is already correct, so no manual offset math is
 *          needed or should be applied.
 *   col E: Bid
 *   col F: Ask
 *
 * Aggregation: mid price = (bid + ask) / 2 per tick. Bars are floored to the
 * minute (UTC). open = first mid in the minute, close = last mid, high/low =
 * extremes, volume = tick count in that minute.
 *
 * Usage:
 *   bun run expo/scripts/ingest_exness_ticks_to_bars.ts <in1.csv> [in2.csv ...] <out.csv>
 *   (last argument is always the output path)
 */
import { createReadStream, createWriteStream } from 'fs';
import * as readline from 'readline';

interface Bucket {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
}

async function aggregateFile(path: string, buckets: Map<number, Bucket>): Promise<{ rows: number; skipped: number }> {
  const rl = readline.createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let rows = 0;
  let skipped = 0;
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const cols = line.split(',');
    if (cols.length < 6) { skipped++; continue; }
    const rawTs = cols[2].trim();
    const bid = Number(cols[4]);
    const ask = Number(cols[5]);
    if (!rawTs || !Number.isFinite(bid) || !Number.isFinite(ask)) { skipped++; continue; }
    const ms = Date.parse(rawTs);
    if (!Number.isFinite(ms)) { skipped++; continue; }
    const mid = (bid + ask) / 2;
    const bucketTs = Math.floor(ms / 60000) * 60000;
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, { ts: bucketTs, open: mid, high: mid, low: mid, close: mid, count: 1 });
    } else {
      existing.high = Math.max(existing.high, mid);
      existing.low = Math.min(existing.low, mid);
      existing.close = mid;
      existing.count += 1;
    }
    rows++;
  }
  return { rows, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: bun run ingest_exness_ticks_to_bars.ts <in1.csv> [in2.csv ...] <out.csv>');
    process.exit(1);
  }
  const outPath = args[args.length - 1];
  const inputPaths = args.slice(0, -1);

  const buckets = new Map<number, Bucket>();
  let totalRows = 0;
  let totalSkipped = 0;
  for (const p of inputPaths) {
    console.log(`Reading ${p} ...`);
    const { rows, skipped } = await aggregateFile(p, buckets);
    totalRows += rows;
    totalSkipped += skipped;
    console.log(`  ticks parsed: ${rows}, skipped: ${skipped}`);
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
  console.log(`\nTotal ticks: ${totalRows} (skipped ${totalSkipped}) -> ${sorted.length} 1-minute bars`);
  if (sorted.length > 0) {
    console.log(`First bar: ${new Date(sorted[0].ts).toISOString()}`);
    console.log(`Last bar:  ${new Date(sorted[sorted.length - 1].ts).toISOString()}`);
    const expectedMinutes = Math.round((sorted[sorted.length - 1].ts - sorted[0].ts) / 60000) + 1;
    console.log(`Coverage: ${sorted.length}/${expectedMinutes} minutes present (${((sorted.length / expectedMinutes) * 100).toFixed(2)}%)`);
  }

  const out = createWriteStream(outPath, { encoding: 'utf8' });
  out.write('timestamp,open,high,low,close,volume\n');
  for (const b of sorted) {
    out.write(`${new Date(b.ts).toISOString()},${b.open.toFixed(3)},${b.high.toFixed(3)},${b.low.toFixed(3)},${b.close.toFixed(3)},${b.count}\n`);
  }
  await new Promise<void>((resolve) => out.end(resolve));
  console.log(`\nWrote ${sorted.length} bars to ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
