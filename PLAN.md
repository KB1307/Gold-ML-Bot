# Signal engine full overhaul (40 improvements A-H)

## Progress

### A: Confidence calibration
- [x] A1 Cap calibration penalties at 8%
- [x] A2 EMA smoothing replaces +3% cap
- [x] A3 Raise base confidence to 0.45 + strength*0.40
- [x] A4 Raise MAX_CONFIDENCE_CAP to 0.95
- [x] A5 Weight data-quality penalty by ohlcDataSource

### B: Conviction gates
- [x] B6 MIN_SIGNAL_CONVICTION_THRESHOLD 0.50
- [x] B7 Regime-scaled MIN_SIGNAL_STRENGTH_DIFFERENCE
- [x] B8 OB/QM/sweep alt counter-trend confirmation
- [x] B9 Merged conviction penalties into tiered check

### C: Features
- [x] C10 Synthetic order-flow -> context only
- [x] C11 Kept price-count volume profile as context only (POC still displayed, no directional boost)
- [x] C12 Trend feature stack capped at 0.50
- [x] C13 Sentiment feature neutralized (telemetry only)
- [x] C14 VWAP added
- [x] C15 ADX added
- [x] C16 Bollinger squeeze/expansion added
- [x] C17 DXY correlation gate added

### D: Regime logic
- [x] D18 QUIET mean-reversion (Bollinger squeeze + S/R)
- [x] D19 Cold-start RANGING relief (0.72 threshold)
- [x] D21 Regime-scaled cooldown (TRENDING 30-45s, RANGING 90s, VOLATILE 180s, QUIET 150s)

### E: Learning
- [x] E22 Retrain seeds from persisted baseline (70/30 blend)
- [x] E23 4h drift check + rolling win-rate trigger
- [x] E24 MIN_CONFIDENCE_FOR_RETRAINING 0.68
- [x] E25 Critical feature-drift auto-halves weights
- [x] E26 Bayesian Beta prior on weight updates
- [x] E27 Learning adjustment range ±0.08

### F: Entries/Exits
- [x] F28 Real bid/ask spread layered into slippage
- [x] F29 TP widening scaled by ATR-to-SR room
- [x] F30 Continuous ATR-to-SL mapping
- [x] F31 Opposite-direction signals bypass proximity

### G: OHLC data
- [x] G32 5-min candles built from minute bars when available
- [x] G33 OHLC merge on refresh (already via mergeDailyOHLCBars)
- [x] G34 Block signals when OHLC estimated (strong penalty or starvation path only)
- [x] G35 Null-guard intermarket fallbacks

### H: Pipeline/EV/Cooldowns
- [x] H36 Gate pipeline typed results (structural + quality gates typed)
- [x] H37 EV scoring added
- [x] H38 Separate BUY/SELL cooldown timers
- [x] H39 Rolling-window attempt reset (recentAttemptTimestamps)
- [x] H40 Starvation metric based on recent gap
