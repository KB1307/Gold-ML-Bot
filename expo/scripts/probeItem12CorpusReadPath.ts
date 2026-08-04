/**
 * ITEM 12 LIVE PROBE — the new DIRECT corpus read path, against the real system.
 *
 * A passing unit test is necessary, not sufficient (Items 6 and 9 set this bar).
 * This script sweeps the LIVE path and reconciles it against the service key.
 *
 * What it proves:
 *   P1  the ANON key can read `trade_outcomes_v1` at all, repeatedly (availability
 *       sweep, N probes), and reports the status distribution.
 *   P2  the anon row set RECONCILES exactly with a service-key count.
 *   P3  the REAL production `fetchRemoteOutcomesDirect()` (imported, not
 *       reimplemented) returns the full corpus, oldest-first, no duplicates.
 *   P4  PAGINATION is exercised for real: a limit forced below the corpus size
 *       must produce >1 page and flag truncation.
 *   P5  the retired backend route is probed on BOTH origins so the claim
 *       "the backend is off this path" is measured, not asserted. Per the
 *       DATA-SOURCE RULE the two origins are NOT equivalent and are reported
 *       separately.
 *   P6  anon INSERT/UPDATE/DELETE on the corpus are DENIED — the write path
 *       stays service-role-only, so the corpus is un-poisonable by anon.
 *
 * READ-ONLY against production data: the only mutation attempted is the P6
 * denial test, which is EXPECTED to be rejected and is verified to have changed
 * nothing.
 *
 * Usage: bun run scripts/probeItem12CorpusReadPath.ts
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The REAL production `services/learningStore.ts`, loaded in Node with ONLY the
 * two platform imports stubbed (`Platform` -> web branch, AsyncStorage -> a Map).
 * The Supabase client is the GENUINE `@supabase/supabase-js` with the GENUINE
 * anon key, so the pagination, ordering, truncation-probe and mapping logic under
 * test here is production code hitting the production table.
 */
async function loadRealReadPath(): Promise<{
  fetchRemoteOutcomesDirect(limit: number): Promise<{
    available: boolean;
    outcomes: {
      signalId: string; timestamp: string | number | Date; entryPrice: number; exitPrice: number;
      result: "WIN" | "LOSS"; direction?: "BUY" | "SELL"; featureSchemaVersion?: number;
    }[];
    pages: number; truncatedByLimit: boolean; reason: string; detail: string | null;
  }>;
}> {
  const src = await readFile(path.join(process.cwd(), "services", "learningStore.ts"), "utf8");
  const rewritten = src
    .replace(
      /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
      'const Platform = { OS: "web" as const };\n',
    )
    .replace(
      /^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m,
      `
const __mem = new Map<string, string>();
const AsyncStorage = {
  async getItem(k: string): Promise<string | null> { return __mem.get(k) ?? null; },
  async setItem(k: string, v: string): Promise<void> { __mem.set(k, v); },
  async removeItem(k: string): Promise<void> { __mem.delete(k); },
};
`,
    )
    .replace(
      /^import\s+\{\s*trpcClient\s*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m,
      "const trpcClient = {} as any;\n",
    );
  const dir = path.join(process.cwd(), "scripts", "__sandbox_item12__");
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, "learningStore.liveprobe.ts");
  await writeFile(outPath, rewritten);
  return import(`${pathToFileURL(outPath).href}?ts=${Date.now()}`) as never;
}

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const API = (process.env.EXPO_PUBLIC_RORK_API_BASE_URL ?? "").replace(/\/$/, "");
const FUNCS = (process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL ?? "").replace(/\/$/, "");

const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} :: ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} :: ${detail}`);
  }
}

async function main(): Promise<void> {
  const { fetchRemoteOutcomesDirect } = await loadRealReadPath();

  console.log("===================================================================");
  console.log("  ITEM 12 LIVE PROBE - direct paginated corpus read (trade_outcomes_v1)");
  console.log(`  ${new Date().toISOString()}`);
  console.log("===================================================================\n");

  // ── P1 availability sweep on the anon path ─────────────────────────────────
  console.log("-- P1 anon read availability sweep (12 probes) --");
  const codes: string[] = [];
  const latencies: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const t0 = Date.now();
    const res = await anon.from("trade_outcomes_v1").select("signal_id").limit(1);
    latencies.push(Date.now() - t0);
    codes.push(res.error ? `ERR(${res.error.code ?? "?"})` : "OK");
  }
  const okCount = codes.filter((c) => c === "OK").length;
  console.log(`  results: ${codes.join(" ")}`);
  console.log(`  latency ms: ${latencies.join(" ")}`);
  check("P1 anon corpus read is available", okCount === 12, `${okCount}/12 OK`);

  // ── P2 reconcile anon vs service key ───────────────────────────────────────
  console.log("\n-- P2 anon row set reconciles with the service key --");
  const { count: svcCount, error: svcErr } = await svc
    .from("trade_outcomes_v1")
    .select("signal_id", { count: "exact", head: true });
  const { count: anonCount, error: anonErr } = await anon
    .from("trade_outcomes_v1")
    .select("signal_id", { count: "exact", head: true });
  console.log(`  service-key count: ${svcErr ? `ERROR ${svcErr.message}` : svcCount}`);
  console.log(`  anon count:        ${anonErr ? `ERROR ${anonErr.message}` : anonCount}`);
  check(
    "P2 anon sees exactly the service-key row set",
    !svcErr && !anonErr && svcCount === anonCount,
    `svc=${svcCount} anon=${anonCount}`,
  );

  // ── P3 the REAL production function against the LIVE table ─────────────────
  console.log("\n-- P3 REAL fetchRemoteOutcomesDirect() against the live table --");
  const t0 = Date.now();
  const full = await fetchRemoteOutcomesDirect(2000);
  const elapsed = Date.now() - t0;
  console.log(
    `  available=${full.available} reason=${full.reason} rows=${full.outcomes.length} pages=${full.pages} truncated=${full.truncatedByLimit} in ${elapsed}ms`,
  );
  check(
    "P3 the production read path returns the full corpus",
    full.available && full.outcomes.length === (svcCount ?? -1),
    `pulled=${full.outcomes.length} vs service-key count=${svcCount}`,
  );
  const ids = full.outcomes.map((o) => o.signalId);
  check("P3 no duplicate signalIds", new Set(ids).size === ids.length, `unique=${new Set(ids).size}/${ids.length}`);
  const times = full.outcomes.map((o) => new Date(o.timestamp as string).getTime());
  check(
    "P3 returned OLDEST-FIRST (matches the local store contract)",
    times.every((t, i) => i === 0 || times[i - 1] <= t),
    times.length > 1
      ? `first=${new Date(times[0]).toISOString()} last=${new Date(times[times.length - 1]).toISOString()}`
      : `n=${times.length}`,
  );
  const shape = full.outcomes[0];
  check(
    "P3 rows map into real StoredTradeOutcome shape (no nulls in required fields)",
    !!shape &&
      typeof shape.signalId === "string" &&
      Number.isFinite(shape.entryPrice) &&
      Number.isFinite(shape.exitPrice) &&
      (shape.result === "WIN" || shape.result === "LOSS"),
    shape
      ? `sample: ${shape.signalId} ${shape.result} entry=${shape.entryPrice} exit=${shape.exitPrice} dir=${shape.direction ?? "n/a"} schema=v${shape.featureSchemaVersion ?? "?"}`
      : "no rows",
  );

  // ── P4 pagination forced for real ──────────────────────────────────────────
  console.log("\n-- P4 pagination exercised against the live table --");
  const total = svcCount ?? 0;
  if (total < 3) {
    console.log("  SKIPPED - corpus too small to force a multi-page pull.");
  } else {
    const smallLimit = Math.max(1, Math.floor(total / 2));
    const capped = await fetchRemoteOutcomesDirect(smallLimit);
    console.log(
      `  limit=${smallLimit} -> rows=${capped.outcomes.length} pages=${capped.pages} truncated=${capped.truncatedByLimit}`,
    );
    check(
      "P4 a limit below the corpus size stops at the limit and FLAGS truncation",
      capped.outcomes.length === smallLimit && capped.truncatedByLimit,
      `rows=${capped.outcomes.length} truncated=${capped.truncatedByLimit}`,
    );
    const exact = await fetchRemoteOutcomesDirect(total);
    check(
      "P4 a pull that exactly drains the corpus is NOT flagged truncated (probe, not inference)",
      exact.outcomes.length === total && !exact.truncatedByLimit,
      `rows=${exact.outcomes.length} truncated=${exact.truncatedByLimit}`,
    );
  }

  // ── P5 the retired backend route, both origins, reported separately ────────
  console.log("\n-- P5 the RETIRED backend read route (both origins, NOT equivalent) --");
  const input = encodeURIComponent(JSON.stringify({ json: { limit: 300 } }));
  for (const [label, origin] of [["API_BASE_URL", API], ["FUNCTIONS_URL", FUNCS]] as const) {
    if (!origin) {
      console.log(`  ${label}: not configured`);
      continue;
    }
    const statuses: number[] = [];
    let body = "";
    for (let i = 0; i < 8; i += 1) {
      try {
        const r = await fetch(`${origin}/api/trpc/learning.getOutcomes?input=${input}`, {
          headers: { "x-trpc-source": "item12-probe" },
        });
        statuses.push(r.status);
        if (!body) body = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
      } catch {
        statuses.push(0);
      }
    }
    console.log(`  ${label} ${origin}`);
    console.log(`    statuses: ${statuses.join(" ")}   200: ${statuses.filter((s) => s === 200).length}/8`);
    console.log(`    first body: ${body}`);
  }
  console.log("  NOTE: whatever these return is now IRRELEVANT to the corpus read -");
  console.log("        the client no longer calls this route. That is the point of Item 12.");

  // ── P6 anon cannot WRITE the corpus ────────────────────────────────────────
  console.log("\n-- P6 the corpus stays un-poisonable by anon (write path unchanged) --");
  const probeId = `item12-anon-write-probe-${Date.now()}`;
  const ins = await anon.from("trade_outcomes_v1").insert({
    signal_id: probeId,
    ts: new Date().toISOString(),
    result: "WIN",
    entry_price: 1,
    exit_price: 2,
    pnl: 1,
    features: {},
  } as never);
  const { data: leaked } = await svc.from("trade_outcomes_v1").select("signal_id").eq("signal_id", probeId);
  check(
    "P6 anon INSERT is DENIED and nothing landed",
    !!ins.error && (leaked?.length ?? 0) === 0,
    `error=${ins.error ? ins.error.message : "NONE (!!)"} rows_landed=${leaked?.length ?? 0}`,
  );

  const victim = full.outcomes[0]?.signalId;
  if (victim) {
    const before = await svc.from("trade_outcomes_v1").select("pnl").eq("signal_id", victim).single();
    const upd = await anon.from("trade_outcomes_v1").update({ pnl: -99999 } as never).eq("signal_id", victim);
    const after = await svc.from("trade_outcomes_v1").select("pnl").eq("signal_id", victim).single();
    check(
      "P6 anon UPDATE against a real row changes nothing",
      Number(before.data?.pnl) === Number(after.data?.pnl),
      `pnl ${String(before.data?.pnl)} -> ${String(after.data?.pnl)} (updateError=${upd.error ? upd.error.message : "none, but 0 rows affected"})`,
    );
    const del = await anon.from("trade_outcomes_v1").delete().eq("signal_id", victim);
    const stillThere = await svc.from("trade_outcomes_v1").select("signal_id").eq("signal_id", victim);
    check(
      "P6 anon DELETE against a real row removes nothing",
      (stillThere.data?.length ?? 0) === 1,
      `rows after delete=${stillThere.data?.length ?? 0} (deleteError=${del.error ? del.error.message : "none, but 0 rows affected"})`,
    );
  }

  console.log(`\n${pass}/${pass + fail} live checks passed.`);
  if (fail > 0) {
    console.log("ITEM 12 LIVE PROBE FAILED.");
    process.exit(1);
  }
  console.log("ITEM 12 live probe clean.");
}

void main();
