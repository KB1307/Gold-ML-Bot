/**
 * BISECT DRIVER v2 (removeChild vs rork-build-marker plugin) — diagnostic only.
 * Loads the web preview, then cycles Dashboard→History→Outlook→Telemetry→Settings
 * three times, forcing chart mount/unmount. Navigation is driven by DOM clicks
 * on elements whose text equals the tab name, with a direct URL fallback
 * (expo-router web routes). Captures every console error and page error and
 * reports whether the react-native-web "Node.removeChild: The node to be
 * removed is not a child of this node" crash reproduces. Observes; asserts
 * nothing. Run: bun scripts/bisect_removechild_driver.ts <runLabel>
 */
import { chromium } from "playwright";

const runLabel: string = process.argv[2] ?? "run";
const BASE = "http://localhost:8081";
const ROUTES: Array<[string, string]> = [
  ["Dashboard", "/dashboard"],
  ["History", "/history"],
  ["Outlook", "/outlook"],
  ["Telemetry", "/telemetry"],
  ["Settings", "/settings"],
];
const CYCLES = 3;

interface Captured {
  kind: string;
  text: string;
}

const captured: Captured[] = [];
const navFails: string[] = [];
const navModes: string[] = [];

function record(kind: string, text: string): void {
  captured.push({ kind, text: text.slice(0, 400) });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

page.on("console", (msg): void => {
  if (msg.type() === "error" || msg.type() === "warning") {
    record(`console.${msg.type()}`, msg.text());
  }
});
page.on("pageerror", (err): void => {
  record("pageerror", String(err));
});
page.on("crash", (): void => {
  record("browser-crash", "page crashed");
});

const t0 = Date.now();
try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 180000 });
  record("lifecycle", `boot loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `/tmp/bisect_${runLabel}_boot.png` }).catch(() => undefined);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (const [tab, route] of ROUTES) {
      let mode = "click";
      try {
        const clicked = await page.evaluate((name: string): boolean => {
          const els = Array.from(document.querySelectorAll("*")) as HTMLElement[];
          const matches = els.filter(
            (el) =>
              (el.textContent || "").trim() === name &&
              el.offsetParent !== null &&
              el.children.length <= 3,
          );
          const target = matches[matches.length - 1];
          if (target) {
            target.click();
            return true;
          }
          return false;
        }, tab);
        if (!clicked) throw new Error("no clickable text node");
        await page.waitForTimeout(2500);
      } catch {
        mode = "url";
        try {
          await page.goto(`${BASE}${route}`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await page.waitForTimeout(2500);
        } catch {
          navFails.push(`cycle${cycle}:${tab}`);
          continue;
        }
      }
      navModes.push(`cycle${cycle}:${tab}:${mode}`);
    }
  }
  await page.screenshot({ path: `/tmp/bisect_${runLabel}_end.png` }).catch(() => undefined);
  record("lifecycle", `drive complete after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  record("driver-error", String(e));
}
await browser.close();

const isCrash = (c: Captured): boolean =>
  /removeChild|not a child of this node/i.test(c.text);
const crashes = captured.filter(isCrash);
const other = captured.filter((c) => !isCrash(c));
const urlNavs = navModes.filter((m) => m.endsWith("url")).length;

console.log(
  JSON.stringify(
    {
      runLabel,
      REMOVECHILD_REPRODUCED: crashes.length > 0,
      crashCount: crashes.length,
      crashSamples: crashes.slice(0, 5),
      navModes,
      navFails,
      urlFallbackCount: urlNavs,
      otherCount: other.length,
      errorsOnly: other.filter((c) => c.kind !== "console.warning").slice(0, 30),
    },
    null,
    1,
  ),
);
