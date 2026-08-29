/**
 * Boot-cycle forensics — survives page reloads via sessionStorage (web only).
 *
 * Built to diagnose the web-preview reload loop: the app re-boots in a full
 * cycle (boot screen -> "Loading Trading Data..." -> ~1s dashboard -> teardown)
 * and the killer dies before the error boundary can paint anything. This module
 * makes every boot leave a trace:
 *
 *  - `recordBoot()` stamps each boot; a re-boot within BOOT_LOOP_WINDOW_MS
 *    bumps a cycle counter and logs `[BootLoop] cycle #N`.
 *  - `recordFatalError()` saves a short digest (type, message, first stack
 *    line) the moment an uncaught error fires — before the page tears down.
 *  - the NEXT boot prints `previous session ended with: ...`, so the culprit
 *    names itself on the following run even if the loop continues.
 *
 * Native is unaffected: sessionStorage does not exist there and every call
 * degrades to a no-op. All access is wrapped — forensics must never throw.
 */

const STORAGE_KEY = "__boot_forensics_v1";
const BOOT_LOOP_WINDOW_MS = 15_000;

export interface FatalErrorDigest {
  type: string;
  message: string;
  firstStackLine: string | null;
  at: number;
}

interface StoredForensics {
  lastBootAt: number | null;
  cycleCount: number;
  lastFatalError: FatalErrorDigest | null;
}

const EMPTY: StoredForensics = { lastBootAt: null, cycleCount: 0, lastFatalError: null };

function readState(): StoredForensics {
  try {
    if (typeof sessionStorage === "undefined") return EMPTY;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredForensics>;
    return {
      lastBootAt: typeof parsed.lastBootAt === "number" ? parsed.lastBootAt : null,
      cycleCount: typeof parsed.cycleCount === "number" ? parsed.cycleCount : 0,
      lastFatalError: parsed.lastFatalError ?? null,
    };
  } catch {
    return EMPTY;
  }
}

function writeState(state: StoredForensics): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable or full — forensics must never throw.
  }
}

/** Build a short, storage-safe digest from an unknown thrown value. */
function toDigest(error: unknown): FatalErrorDigest {
  let type: string = typeof error;
  let message = "";
  let firstStackLine: string | null = null;
  if (error instanceof Error) {
    type = error.name || "Error";
    message = error.message ?? "";
    firstStackLine = error.stack?.split("\n")[1]?.trim() ?? null;
  } else if (error !== null && typeof error === "object") {
    try {
      message = JSON.stringify(error).slice(0, 300);
    } catch {
      message = "(unserializable object)";
    }
  } else {
    message = String(error).slice(0, 300);
  }
  return { type, message: message.slice(0, 300), firstStackLine, at: Date.now() };
}

/**
 * Record a boot. Called once per page load, before React renders (web only).
 * Returns the stored state AFTER this boot is accounted for, including the
 * previous session's fatal digest if one was saved.
 */
export function recordBoot(): StoredForensics {
  const prev = readState();
  const now = Date.now();
  const state: StoredForensics = { lastBootAt: now, cycleCount: 1, lastFatalError: prev.lastFatalError };

  if (prev.lastBootAt !== null) {
    const delta = now - prev.lastBootAt;
    if (delta <= BOOT_LOOP_WINDOW_MS) {
      state.cycleCount = prev.cycleCount + 1;
      console.warn(
        `[BootLoop] cycle #${state.cycleCount} — remounted ${delta}ms after previous`,
      );
    }
  }

  if (prev.lastFatalError) {
    const d = prev.lastFatalError;
    console.warn(
      `[BootForensics] previous session ended with: ${d.type}: ${d.message}${d.firstStackLine ? ` @ ${d.firstStackLine}` : ""}`,
    );
  }

  writeState(state);
  return state;
}

/** Save a fatal-error digest so the next boot can report what killed the page. */
export function recordFatalError(error: unknown): void {
  try {
    const state = readState();
    state.lastFatalError = toDigest(error);
    writeState(state);
  } catch {
    // never throw from forensics
  }
}

/** Current rapid-reboot cycle count (0 on native / first clean boot). */
export function getBootLoopCycleCount(): number {
  return readState().cycleCount;
}

/** Digest of the last session's uncaught error, if one was recorded. */
export function getLastFatalDigest(): FatalErrorDigest | null {
  return readState().lastFatalError;
}
