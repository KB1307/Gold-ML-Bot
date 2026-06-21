import { sendTelegramAlert } from "../services/telegramNotifier";
import type { TradingSignal } from "../types/trading";

const testSignal: TradingSignal = {
  id: "TEST-" + Date.now(),
  timestamp: new Date(),
  type: "BUY",
  entryPrice: 2658.4,
  entryPriceWithSlippage: 2658.55,
  tp1: 2661.4,
  tp2: 2664.4,
  tp3: 2667.4,
  sl: 2649.4,
  slMultiplier: 1.5,
  confidence: 0.82,
  status: "ACTIVE",
  targetsHit: 0,
  entryTime: new Date().toLocaleString(),
  topFeatures: [
    { feature: "EMA Crossover", score: 0.88 },
    { feature: "RSI Divergence", score: 0.76 },
    { feature: "Support Bounce", score: 0.72 },
  ],
  riskJustification: "Strong confluence on 1H and 4H timeframes with bullish MACD",
  tp1Distance: 30,
  tp2Distance: 60,
  tp3Distance: 90,
};

async function main() {
  console.log("Sending test Telegram alert with signal:");
  console.log(JSON.stringify(testSignal, null, 2));
  console.log("---");

  await sendTelegramAlert(testSignal);

  console.log("Done. Check your Telegram channel for the alert.");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
