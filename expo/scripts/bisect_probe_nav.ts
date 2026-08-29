/**
 * PROBE (bisect support) — loads the web preview, waits for boot, screenshots,
 * and dumps clickable texts so the bisect driver can target real nav elements.
 */
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:8081/", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: "/tmp/probe_home.png" });
const texts = await page.evaluate((): string[] => {
  const out: string[] = [];
  document.querySelectorAll("div[role], a, button").forEach((el) => {
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const r = el.getAttribute("role") || el.tagName.toLowerCase();
    if (t) out.push(`${r}:${t}`);
  });
  return Array.from(new Set(out)).slice(0, 60);
});
console.log(JSON.stringify({ url: page.url(), texts }, null, 1));
await browser.close();
