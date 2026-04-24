# Stop false Stop-Loss recordings and add a true 15-pip profit-lock after TP1

## What's actually going wrong

After carefully tracing the 8:09 SELL example tick-for-tick through the code, the history is being poisoned from three separate sources, each of which needs its own fix:

1. **Outlier "spike" ticks from the price feed are being written into the 1‑minute bar store.** Those bad high/low values then survive into the audit, so even the audit agrees there was an SL wick — even though no real trade ever printed that price. This is the single biggest cause of "SL hit at a price that was never reached".
2. **The live stop-loss check confirms far too easily** — it accepts any tick that pokes 0.1 pips past the SL for 0 milliseconds. One glitch tick is enough to close the trade as a loss.
3. **"Move SL to breakeven after TP1" is only a label today** — the trade never actually closes at that trailing level, so profits given back are never banked, and you asked for a real 15‑pip profit lock instead of breakeven.

## What I will change

**Feature fixes**
- Reject obvious outlier ticks (the same 8‑pip / 500 ms filter that already guards signal evaluation) **before** they are written into the 1‑minute, 5‑minute and 1‑hour bar store, so the bars themselves stay clean.
- Make a live stop-loss only confirm after a real, sustained breach (at least ~1.5 pips past SL for ~2.5 seconds), so a single glitch tick can no longer close a trade.
- After TP1 is achieved, replace the current "move to breakeven" behaviour with a real **+15 pip profit lock**: for a BUY the trailing stop becomes entry + 15 pips, for a SELL it becomes entry − 15 pips. If price retraces to that level, the trade closes as a protected partial win that banks both TP1 and the 15‑pip lock. This is enforced in the live tick monitor, the historical bar resolver **and** the audit path, so every screen agrees.
- Manual Audit now force-refreshes the authoritative 1‑minute bars from the remote data provider (Tiingo) for each signal's window and temporarily ignores any locally-cached bars, so previously poisoned bars cannot "re-confirm" a false SL hit. Once cleaned bars arrive, they are written back into the local store.
- Manual Audit clears the audit-version lock for every terminal signal and re-resolves each one against the freshly fetched clean bars, so the existing false SL outcomes (including 8:09, 7:44, 6:13, 4:44) are corrected automatically and the machine‑learning engine receives the corrected WIN/LOSS records.

**Safety / sandbox before I hand it back**
- Before presenting, I will run the existing in-repo signal simulation harness to replay the scenarios you called out (straight-to-TP SELL, straight-to-SL BUY, TP1 → retrace past entry, TP1 → retrace to entry‑15) and assert the recorded outcome matches price action tick-for-tick. I will only present the result after these pass.

**Performance metrics**
- Once the audit corrects the historical false SL hits, win-rate, P&L and ML learning weights automatically recompute from the corrected history — no extra action needed from you.

## Screens affected
- **History** — false SL rows flip to their true outcome (TP3 / protected partial win) after the automatic audit pass. The manual audit button in the top-right keeps working and now does a deeper clean.
- **Telemetry / Performance** — numbers refresh from the corrected history.
- **Dashboard** — live trade monitoring is unchanged visually, but it will no longer close trades on a single glitch tick, and the breakeven badge after TP1 now reflects a real 15‑pip profit lock rather than a cosmetic indicator.