/**
 * ITEM 5: Re-test SELL suppression on clean bar-verified outcomes.
 *
 * MEASUREMENT ONLY. Changes nothing. allowShortSignals stays as-is.
 *
 * Re-resolves every export signal against real gold_m1_bars via
 * resolveSignalWithBars(fromScratch: true), compares old-stored vs
 * bar-verified outcomes side by side, and recomputes BUY vs SELL
 * WR/PF/EV on bar-verified data only.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via anon key.
 * No Rork backend, no GC=F/TwelveData, no priceHistory ticks.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), "expo/.env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

const env = loadEnv();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  status: string;
  id: string;
  generatedMs: number;
  confidence: number;
  exitPrice: number | null;
  targetsHit: number;
}

// ── Parse the diagnostics export ─────────────────────────────────────────────

function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  const lines = raw.split("\n");
  let current: Partial<ParsedSignal> | null = null;

  for (const line of lines) {
    const sigMatch = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (sigMatch) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(sigMatch[1]),
        direction: sigMatch[2] as "BUY" | "SELL",
        entry: parseFloat(sigMatch[3]),
        status: sigMatch[4],
        targetsHit: 0,
        exitPrice: null,
      };
      continue;
    }

    if (current) {
      const idMatch = line.match(/^\s+id:\s+(\S+)/);
      if (idMatch && !current.id) current.id = idMatch[1];

      const genMatch = line.match(/^\s+generated:\s+(\S+)/);
      if (genMatch && current.generatedMs === undefined) {
        const ts = new Date(genMatch[1]).getTime();
        if (!isNaN(ts)) current.generatedMs = ts;
      }

      const confMatch = line.match(/^\s+confidence:\s+([\d.]+)%/);
      if (confMatch && current.confidence === undefined) current.confidence = parseFloat(confMatch[1]);

      // TP1: 4067.7   TP2: 4070.5   TP3: 4074.9   SL: 4054.1
      const tpMatch = line.match(/TP1:\s+([\d.]+)\s+TP2:\s+([\d.]+)\s+TP3:\s+([\d.]+)\s+SL:\s+([\d.]+)/);
      if (tpMatch) {
        current.tp1 = parseFloat(tpMatch[1]);
        current.tp2 = parseFloat(tpMatch[2]);
        current.tp3 = parseFloat(tpMatch[3]);
        current.sl = parseFloat(tpMatch[4]);
      }

      // targets hit: 0
      const thMatch = line.match(/targets hit:\s+(\d+)/);
      if (thMatch) current.targetsHit = parseInt(thMatch[1]);

      // exit price: 4054.1    exit time: 11:23
      const exitMatch = line.match(/exit price:\s+([\d.]+)/);
      if (exitMatch) current.exitPrice = parseFloat(exitMatch[1]);
    }
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

// ── Bar-based outcome resolution (mirrors resolveSignalWithBars fromScratch) ─

interface BarVerifiedOutcome {
  status: string;
  targetsHit: number;
  exitPrice: number;
  isWin: boolean;
  pnlDollars: number;
  rMultiple: number;
}

function resolveFromBars(sig: ParsedSignal, bars: Bar[]): BarVerifiedOutcome | null {
  if (!sig.sl || !sig.tp1 || !sig.tp2 || !sig.tp3) return null;
  if (!sig.generatedMs) return null;

  const pip = 0.1;
  const wickPen = 0.1; // SL_WICK_PENETRATION_PIPS
  const slSlack = wickPen * pip;
  const createdAtMs = sig.generatedMs;
  const safeBarStart = createdAtMs + 60 * 1000;

  // Get bars after signal creation
  const evalBars = bars.filter(b => new Date(b.timestamp).getTime() >= safeBarStart);
  if (evalBars.length === 0) return null;

  const isBuy = sig.direction === "BUY";
  const entry = sig.entry;
  const sl = sig.sl;
  const tp1 = sig.tp1;
  const tp2 = sig.tp2;
  const tp3 = sig.tp3;

  let targetsHit = 0;
  let slHit = false;
  let exitPrice = entry;
  let slHitPrice = 0;

  for (const bar of evalBars) {
    const barHigh = bar.high;
    const barLow = bar.low;

    // Check SL first (conservative: SL hit before TP in same bar)
    if (isBuy) {
      if (barLow <= sl + slSlack) {
        slHit = true;
        slHitPrice = sl;
      }
      if (!slHit) {
        if (targetsHit < 1 && barHigh >= tp1) targetsHit = 1;
        if (targetsHit < 2 && barHigh >= tp2) targetsHit = 2;
        if (targetsHit < 3 && barHigh >= tp3) targetsHit = 3;
      }
    } else {
      if (barHigh >= sl - slSlack) {
        slHit = true;
        slHitPrice = sl;
      }
      if (!slHit) {
        if (targetsHit < 1 && barLow <= tp1) targetsHit = 1;
        if (targetsHit < 2 && barLow <= tp2) targetsHit = 2;
        if (targetsHit < 3 && barLow <= tp3) targetsHit = 3;
      }
    }

    if (slHit && targetsHit === 0) {
      exitPrice = slHitPrice;
      break;
    }
    if (slHit && targetsHit > 0) {
      // Partial win — SL after TP(s)
      // Post-TP1 lock: entry + 0.35R for BUY, entry - 0.35R for SELL
      const stopDist = Math.abs(entry - sl);
      const lockDist = Math.max(5 * pip, stopDist * 0.35);
      const lockPrice = isBuy ? entry + lockDist : entry - lockDist;
      // Cap at 90% of TP1 distance
      const tp1Dist = Math.abs(tp1 - entry);
      const cap = tp1Dist * 0.9;
      const actualLock = Math.min(lockDist, cap);
      const lockPriceCapped = isBuy ? entry + actualLock : entry - actualLock;
      exitPrice = lockPriceCapped;
      break;
    }
    if (targetsHit === 3) {
      exitPrice = tp3;
      break;
    }
  }

  // If no terminal event, check if bars ran out
  if (!slHit && targetsHit === 0) {
    // No SL, no TP — CLOSED flat
    exitPrice = entry;
  } else if (!slHit && targetsHit > 0 && targetsHit < 3) {
    // Partial win, bars ran out — exit at last bar close
    exitPrice = isBuy
      ? Math.max(entry + (Math.abs(entry - sl) * 0.35), entry) // at least the lock
      : Math.min(entry - (Math.abs(entry - sl) * 0.35), entry);
  }

  const pnl = isBuy ? exitPrice - entry : entry - exitPrice;
  const risk = Math.abs(entry - sl);
  const rMult = risk > 0 ? pnl / risk : 0;

  let status: string;
  if (slHit && targetsHit === 0) status = "SL_HIT";
  else if (slHit && targetsHit > 0) status = "PARTIAL_WIN_SL_HIT";
  else if (targetsHit >= 3) status = "ALL_TARGETS_HIT";
  else if (targetsHit >= 1) status = `TP${targetsHit}_HIT`;
  else status = "CLOSED";

  const isWin = pnl > 0;

  return {
    status,
    targetsHit,
    exitPrice,
    isWin,
    pnlDollars: pnl,
    rMultiple: rMult,
  };
}

// ── Paginated bar fetch ──────────────────────────────────────────────────────

async function fetchBars(fromTs: string): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100_000) break;
  }
  return out;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

interface Metrics {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  pf: number;
  evPerSignal: number;
  netDollars: number;
}

function computeMetrics(signals: { rMultiple: number; pnlDollars: number }[]): Metrics {
  const n = signals.length;
  if (n === 0) return { n: 0, wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0, pf: 0, evPerSignal: 0, netDollars: 0 };
  const wins = signals.filter(s => s.rMultiple > 0);
  const losses = signals.filter(s => s.rMultiple <= 0);
  const grossProfit = wins.reduce((a, b) => a + b.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.rMultiple, 0));
  const sumR = signals.reduce((a, b) => a + b.rMultiple, 0);
  const netDollars = signals.reduce((a, b) => a + b.pnlDollars, 0);
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / n) * 100,
    grossProfit,
    grossLoss,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    evPerSignal: sumR / n,
    netDollars,
  };
}

function printMetrics(label: string, m: Metrics): void {
  const pf = Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf";
  const ev = (m.evPerSignal >= 0 ? "+" : "") + m.evPerSignal.toFixed(4) + "R";
  const net = (m.netDollars >= 0 ? "+" : "") + "$" + m.netDollars.toFixed(1);
  console.log(`  ${label.padEnd(45)} n=${String(m.n).padStart(3)}  WR=${m.winRate.toFixed(1).padStart(5)}%  PF=${pf.padStart(6)}  EV=${ev.padStart(10)}  net=${net.padStart(10)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(90));
  console.log("ITEM 5 — RE-TEST SELL SUPPRESSION ON CLEAN BAR-VERIFIED OUTCOMES");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(90));

  // 1. Fetch ALL bars
  const fromTs = "2026-06-18T00:00:00Z";
  console.log(`\nFetching M1 bars from ${fromTs}...`);
  const bars = await fetchBars(fromTs);
  console.log(`Total bars: ${bars.length}`);
  console.log(`Window: ${bars[0]?.timestamp} → ${bars[bars.length - 1]?.timestamp}`);

  // 2. Parse the export
  const exportSignals = parseExport("/tmp/diagnostics_export.txt");
  console.log(`\nParsed ${exportSignals.length} signals from export`);
  console.log(`  BUY: ${exportSignals.filter(s => s.direction === "BUY").length}`);
  console.log(`  SELL: ${exportSignals.filter(s => s.direction === "SELL").length}`);

  // 3. Re-resolve every signal against real bars
  console.log("\n── RE-RESOLVING ALL SIGNALS AGAINST REAL BARS (fromScratch) ──");
  let resolved = 0;
  let unresolved = 0;
  let statusChanged = 0;
  const changedSignals: { id: string; dir: string; oldStatus: string; newStatus: string; oldExit: number | null; newExit: number }[] = [];

  const barVerifiedResults: { sig: ParsedSignal; outcome: BarVerifiedOutcome }[] = [];

  for (const sig of exportSignals) {
    const outcome = resolveFromBars(sig, bars);
    if (!outcome) {
      unresolved++;
      continue;
    }
    resolved++;
    barVerifiedResults.push({ sig, outcome });

    // Compare old-stored vs bar-verified
    if (sig.status !== outcome.status) {
      statusChanged++;
      changedSignals.push({
        id: sig.id,
        dir: sig.direction,
        oldStatus: sig.status,
        newStatus: outcome.status,
        oldExit: sig.exitPrice,
        newExit: outcome.exitPrice,
      });
    }
  }

  console.log(`  Resolved: ${resolved}, Unresolved (missing TP/SL/timestamp): ${unresolved}`);
  console.log(`  Status changed (old-stored vs bar-verified): ${statusChanged}/${resolved} (${((statusChanged / resolved) * 100).toFixed(1)}%)`);

  // 4. Report old-stored vs bar-verified status changes
  if (changedSignals.length > 0) {
    console.log(`\n── STATUS CHANGES (old-stored → bar-verified) ──`);
    console.log(`  (showing first 50 of ${changedSignals.length})`);
    for (const c of changedSignals.slice(0, 50)) {
      const exitStr = c.oldExit !== null ? c.oldExit.toFixed(1) : "n/a";
      console.log(`  ${c.dir.padEnd(4)} ${c.id.slice(-12)}  ${c.oldStatus.padEnd(20)} → ${c.newStatus.padEnd(20)}  exit ${exitStr} → ${c.newExit.toFixed(1)}`);
    }
    if (changedSignals.length > 50) console.log(`  ... and ${changedSignals.length - 50} more`);
  }

  // 5. Compute BUY vs SELL on bar-verified data
  console.log("\n" + "=".repeat(90));
  console.log("  BUY vs SELL — BAR-VERIFIED OUTCOMES (fromScratch against gold_m1_bars)");
  console.log("=".repeat(90));

  const buyResults = barVerifiedResults.filter(r => r.sig.direction === "BUY").map(r => ({ rMultiple: r.outcome.rMultiple, pnlDollars: r.outcome.pnlDollars }));
  const sellResults = barVerifiedResults.filter(r => r.sig.direction === "SELL").map(r => ({ rMultiple: r.outcome.rMultiple, pnlDollars: r.outcome.pnlDollars }));
  const allResults = barVerifiedResults.map(r => ({ rMultiple: r.outcome.rMultiple, pnlDollars: r.outcome.pnlDollars }));

  printMetrics("ALL (bar-verified)", computeMetrics(allResults));
  printMetrics("BUY (bar-verified)", computeMetrics(buyResults));
  printMetrics("SELL (bar-verified)", computeMetrics(sellResults));

  // 6. Compare with old-stored outcomes
  console.log("\n── OLD-STORED OUTCOMES (for comparison) ──");

  function oldIsWin(status: string): boolean {
    return status === "ALL_TARGETS_HIT" || status === "PARTIAL_WIN_SL_HIT" || status === "CLOSED" || status === "TP_HIT" || status.startsWith("TP");
  }

  const oldBuy = exportSignals.filter(s => s.direction === "BUY");
  const oldSell = exportSignals.filter(s => s.direction === "SELL");
  const oldBuyWins = oldBuy.filter(s => oldIsWin(s.status)).length;
  const oldSellWins = oldSell.filter(s => oldIsWin(s.status)).length;

  console.log(`  BUY  (old-stored):  n=${oldBuy.length}  WR=${((oldBuyWins / oldBuy.length) * 100).toFixed(1)}%`);
  console.log(`  SELL (old-stored):   n=${oldSell.length}  WR=${((oldSellWins / oldSell.length) * 100).toFixed(1)}%`);

  // 7. The key question: does the evidence still support suppressing SELL?
  console.log("\n" + "=".repeat(90));
  console.log("  VERDICT: DOES THE EVIDENCE STILL SUPPORT SUPPRESSING SELL?");
  console.log("=".repeat(90));

  const buyM = computeMetrics(buyResults);
  const sellM = computeMetrics(sellResults);

  console.log(`\n  BUY  bar-verified: WR=${buyM.winRate.toFixed(1)}%  EV=${(buyM.evPerSignal >= 0 ? "+" : "") + buyM.evPerSignal.toFixed(4)}R  net=$${buyM.netDollars.toFixed(1)}`);
  console.log(`  SELL bar-verified: WR=${sellM.winRate.toFixed(1)}%  EV=${(sellM.evPerSignal >= 0 ? "+" : "") + sellM.evPerSignal.toFixed(4)}R  net=$${sellM.netDollars.toFixed(1)}`);

  if (buyM.evPerSignal > 0 && sellM.evPerSignal < 0) {
    console.log(`\n  → YES: BUY is profitable (+${buyM.evPerSignal.toFixed(4)}R) and SELL is negative (${sellM.evPerSignal.toFixed(4)}R).`);
    console.log(`    The evidence STILL SUPPORTS suppressing SELL.`);
  } else if (buyM.evPerSignal > 0 && sellM.evPerSignal > 0) {
    console.log(`\n  → MIXED: both BUY and SELL are profitable on bar-verified data.`);
    console.log(`    The evidence NO LONGER SUPPORTS suppressing SELL — both directions are positive.`);
  } else if (buyM.evPerSignal < 0 && sellM.evPerSignal < 0) {
    console.log(`\n  → NEITHER direction is profitable on bar-verified data.`);
    console.log(`    Suppressing SELL is moot — the system loses on both sides.`);
  } else if (buyM.evPerSignal < 0 && sellM.evPerSignal > 0) {
    console.log(`\n  → INVERTED: SELL is profitable (+${sellM.evPerSignal.toFixed(4)}R) and BUY is negative (${buyM.evPerSignal.toFixed(4)}R).`);
    console.log(`    The evidence OPPOSES suppressing SELL — SELL is the profitable direction.`);
  }

  console.log(`\n  NOTE: This is a MEASUREMENT ONLY. allowShortSignals is UNCHANGED.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
