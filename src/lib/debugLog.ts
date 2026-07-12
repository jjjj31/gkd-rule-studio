/**
 * Structured debug log for GKD Rule Studio.
 *
 * Two export paths:
 * 1. "Copy report" button → clipboard (always works, no setup)
 * 2. ADB helper endpoint via `adb reverse tcp:18741 tcp:18741` → Claude
 *    can `curl http://127.0.0.1:18741/api/adb/debug-report` to retrieve.
 */

export type DebugLogCategory =
  | "snapshot"
  | "pick"
  | "candidate"
  | "ai"
  | "sync"
  | "error"
  | "lifecycle"
  | "network";

export interface DebugLogEntry {
  ts: string; // ISO timestamp
  category: DebugLogCategory;
  action: string;
  detail?: string;
  payload?: unknown;
}

const MAX_ENTRIES = 500;
const STORAGE_KEY = "gkd-rule-studio-debug-log";
const ADB_HELPER_DEBUG_URL = "http://127.0.0.1:18741/api/adb/debug-log";

let entries: DebugLogEntry[] = [];
let flushSeq = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Append a debug log entry. Also writes to console for DevTools/logcat. */
export function debugLog(
  category: DebugLogCategory,
  action: string,
  detail?: string,
  payload?: unknown,
): void {
  const entry: DebugLogEntry = {
    ts: new Date().toISOString(),
    category,
    action,
    detail,
    payload: payload !== undefined ? safePayload(payload) : undefined,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }

  // Also emit to console so adb logcat / DevTools can see it live
  const tag = `[GKD-DEBUG][${category}]`;
  console.log(tag, action, detail ?? "", payload ?? "");

  persistEntries();
  scheduleFlush();
}

function safePayload(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json.length > 2000) {
      return {
        __truncated: true,
        preview: json.slice(0, 2000),
        originalLength: json.length,
      };
    }
    return JSON.parse(json); // deep-clone
  } catch {
    return String(value);
  }
}

function persistEntries(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(-200)),
    );
  } catch {
    /* localStorage full or unavailable */
  }
}

/** Load entries persisted in localStorage from previous sessions. */
export function loadPersistedEntries(): DebugLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as DebugLogEntry[];
  } catch {
    /* ignore */
  }
  return [];
}

/** Merge persisted entries with in-memory entries, dedupe by ts+action. */
export function getDebugEntries(): DebugLogEntry[] {
  const persisted = loadPersistedEntries();
  const seen = new Set<string>();
  for (const e of entries) {
    seen.add(`${e.ts}|${e.category}|${e.action}`);
  }
  const merged = [...persisted.filter((e) => !seen.has(`${e.ts}|${e.category}|${e.action}`)), ...entries];
  return merged.slice(-MAX_ENTRIES);
}

/** Export a human-readable markdown debug report. */
export function exportDebugReport(): string {
  const all = getDebugEntries();
  const byCategory: Record<string, DebugLogEntry[]> = {};
  for (const e of all) {
    (byCategory[e.category] ??= []).push(e);
  }

  let md = "# GKD Rule Studio Debug Report\n\n";
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Total entries: ${all.length}\n\n`;

  const CATEGORY_LABELS: Record<string, string> = {
    snapshot: "快照加载",
    pick: "节点选择",
    candidate: "候选生成",
    ai: "AI 请求",
    sync: "GKD 同步",
    error: "错误",
    lifecycle: "生命周期",
    network: "网络",
  };

  for (const [cat, catEntries] of Object.entries(byCategory)) {
    const label = CATEGORY_LABELS[cat] ?? cat;
    md += `## ${label} — ${catEntries.length} 条\n\n`;
    const recent = catEntries.slice(-80);
    for (const e of recent) {
      const time = e.ts.replace("T", " ").slice(0, 19);
      md += `- **${time}** | ${e.action}`;
      if (e.detail) md += ` — ${e.detail}`;
      if (e.payload !== undefined) {
        const payloadJson = JSON.stringify(e.payload, null, 2);
        if (payloadJson.length < 600) {
          md += `\n  \`\`\`json\n${payloadJson}\n  \`\`\``;
        } else {
          md += `\n  \`\`\`json\n${payloadJson.slice(0, 500)}\n  ... (${payloadJson.length} chars total)\n  \`\`\``;
        }
      }
      md += "\n";
    }
    md += "\n";
  }

  return md;
}

/** Clear all in-memory and persisted log entries. */
export function clearDebugLog(): void {
  entries = [];
  flushSeq = 0;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── ADB helper flush ────────────────────────────────────────────────

/** Schedule a debounced flush to the ADB helper. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushToAdbHelper();
  }, 3000);
}

/** POST new entries to the ADB helper (phone→PC via adb reverse).
 *  Fails silently if the helper is not reachable. */
export async function flushToAdbHelper(): Promise<boolean> {
  if (entries.length <= flushSeq) return true;

  const newEntries = entries.slice(flushSeq);
  const body = JSON.stringify({ entries: newEntries });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(ADB_HELPER_DEBUG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      flushSeq = entries.length;
      return true;
    }
  } catch {
    /* ADB helper not reachable — logs stay in memory + localStorage */
  }
  return false;
}
