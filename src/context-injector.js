/**
 * context-injector.js — reads Hedy's live context files and returns a
 * compact string suitable for injection into a Claude Code session.
 *
 * Workspace: $OPENCLAW_MCP_WORKSPACE_DIR, defaulting to
 * ~/.openclaw/workspace/hedy (the live Hedy foreground workspace — see
 * AGENTS.md there for why memory/state lives in the `hedy` subdir, not
 * the workspace root).
 * Files read:
 *   - KERNEL.md      (first 60 lines)
 *   - BRAIN.md       (first 50 lines)
 *   - memory/YYYY-MM-DD.md  (last 30 lines, today's date)
 *
 * Output is capped at ~2500 chars. Missing files are skipped gracefully.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const WORKSPACE =
  process.env.OPENCLAW_MCP_WORKSPACE_DIR ||
  join(homedir(), ".openclaw", "workspace", "hedy");
const MAX_CHARS = 2500;

/**
 * Read a file synchronously, returning at most `maxLines` lines.
 * If `fromEnd` is true, returns the last `maxLines` lines instead.
 * Returns empty string if the file doesn't exist or can't be read.
 */
function readLines(filePath, maxLines, fromEnd = false) {
  if (!existsSync(filePath)) return "";
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const slice = fromEnd
      ? lines.slice(-maxLines)
      : lines.slice(0, maxLines);
    return slice.join("\n");
  } catch {
    return "";
  }
}

/**
 * Return today's date as YYYY-MM-DD in local time.
 */
function todayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Truncate a string to `maxChars`, appending a marker if truncated.
 */
function truncate(str, maxChars) {
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "\n...[truncated]";
}

/**
 * Build one labelled section. Returns empty string if content is blank.
 */
function section(label, content) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `### ${label}\n${trimmed}\n`;
}

/**
 * getContext — main export.
 *
 * @param {string} projectHint  Optional hint from the caller (unused for now,
 *                              reserved for future project-scoped context).
 * @param {object} [bridge]     The gateway bridge (see gateway-bridge.js). When
 *                              its transport is "webhook" (gateway on a
 *                              different host — see docs/REMOTE_TRANSPORT_PLAN.md),
 *                              KERNEL.md/BRAIN.md/memory live on the *gateway*
 *                              host, unreachable via local readFileSync, so
 *                              this delegates to bridge.getRemoteContext()
 *                              instead of reading files directly.
 * @returns {string|Promise<string>}  Formatted context string ready for injection.
 */
export function getContext(projectHint = "", bridge = null) {
  if (bridge?.getRemoteContext) {
    return bridge.getRemoteContext(projectHint);
  }

  const kernelPath = join(WORKSPACE, "KERNEL.md");
  const brainPath  = join(WORKSPACE, "BRAIN.md");
  const memPath    = join(WORKSPACE, "memory", `${todayDate()}.md`);

  const kernelText = readLines(kernelPath, 60);
  const brainText  = readLines(brainPath, 50);
  const memText    = readLines(memPath, 30, true);

  const body = [
    section("KERNEL (identity + rules, first 60 lines)", kernelText),
    section("BRAIN (operational state, first 50 lines)", brainText),
    section(`Today's memory (${todayDate()}, last 30 lines)`, memText),
  ]
    .filter(Boolean)
    .join("\n");

  if (!body.trim()) {
    return [
      "--- Hedy Context (injected at session start) ---",
      "(No context files found — workspace may not be initialised.)",
      "------------------------------------------------",
    ].join("\n");
  }

  const header = "--- Hedy Context (injected at session start) ---\n";
  const footer = "\n------------------------------------------------";
  const maxBody = MAX_CHARS - header.length - footer.length;

  return header + truncate(body, maxBody) + footer;
}
