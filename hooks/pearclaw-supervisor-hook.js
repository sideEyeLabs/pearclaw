#!/usr/bin/env node
/**
 * pearclaw-supervisor PreToolUse hook
 *
 * Fires before Write/Edit/Bash (Claude Code) or apply_patch/Bash (Codex CLI)
 * tool calls and consults your OpenClaw agent for any high-risk action.
 * Lower-risk actions pass through. Same script installs into either harness —
 * the hook I/O contract for PreToolUse is compatible enough (JSON on stdin,
 * exit code 2 + `{"decision":"block","reason":...}` to block) that no fork
 * is needed.
 *
 * Install for Claude Code: copy to ~/.claude/hooks/ and add to ~/.claude/hooks.json:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": { "tool_name": "Write|Edit|MultiEdit|Bash" },
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ~/.claude/hooks/pearclaw-supervisor-hook.js",
 *           "timeout": 28000
 *         }]
 *       }]
 *     }
 *   }
 *
 * Install for Codex CLI: copy to ~/.codex/hooks/ and add to ~/.codex/hooks.json:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Bash|apply_patch",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ~/.codex/hooks/pearclaw-supervisor-hook.js",
 *           "timeout": 28
 *         }]
 *       }]
 *     }
 *   }
 *
 * Note: Codex's docs describe PreToolUse as "a guardrail rather than a
 * complete enforcement boundary" — it doesn't yet intercept every shell path
 * (e.g. unified_exec) the way Claude Code's hook does. Treat it as
 * best-effort on Codex, not a hard boundary.
 *
 * The hook uses the MCP server's temp-file protocol directly (no separate process needed).
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const TIMEOUT_MS = 25000;
const POLL_MS = 200;

// High-risk patterns that always trigger supervisor review
const HIGH_RISK_PATTERNS = [
  /rm\s+-rf/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /git\s+push.*--force/i,
  /vercel\s+(deploy|env)/i,
  /supabase\s+db\s+push/i,
  /npx\s+prisma\s+migrate/i,
  /stripe/i,
  /\.env/i,
  /secrets?\//i,
];

// Paths that always trigger supervisor review
const HIGH_RISK_PATHS = [
  /\.env/,
  /secrets?\//i,
  /migrations?\//i,
  /AGENTS\.md/,
  /openclaw\.json/,
];

function assessRisk(toolName, toolInput) {
  if (toolName === "Bash") {
    const cmd = toolInput?.command || "";
    if (HIGH_RISK_PATTERNS.some((p) => p.test(cmd))) return "high";
    if (cmd.includes("npm install") || cmd.includes("brew install")) return "medium";
    return "low";
  }

  if (toolName === "apply_patch") {
    // Codex represents file writes/edits as a unified-diff-style patch in
    // tool_input.command — file paths appear in the patch headers, so the
    // same pattern scan catches both command injection and sensitive paths.
    const patch = toolInput?.command || "";
    if (HIGH_RISK_PATTERNS.some((p) => p.test(patch))) return "high";
    if (HIGH_RISK_PATHS.some((p) => p.test(patch))) return "high";
    return "low";
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const path = toolInput?.file_path || toolInput?.path || "";
    if (HIGH_RISK_PATHS.some((p) => p.test(path))) return "high";
    return "low";
  }

  return "low";
}

function buildPayload(toolName, toolInput, riskLevel) {
  if (toolName === "Bash") {
    return {
      action: `Run: \`${(toolInput?.command || "").slice(0, 300)}\``,
      context: toolInput?.description || "Shell command from coding agent",
      files_affected: [],
      risk_level: riskLevel,
    };
  }

  if (toolName === "apply_patch") {
    const patch = toolInput?.command || "";
    const fileMatch = patch.match(/\*\*\* (Update|Add|Delete) File: (.+)/);
    const path = fileMatch ? fileMatch[2].trim() : "unknown";
    return {
      action: `apply_patch (${fileMatch ? fileMatch[1].toLowerCase() : "modify"}): ${path}`,
      context: "File operation from coding agent",
      files_affected: path !== "unknown" ? [path] : [],
      risk_level: riskLevel,
    };
  }

  const path = toolInput?.file_path || toolInput?.path || "unknown";
  const isNew = !existsSync(path);
  return {
    action: `${toolName} ${isNew ? "(new)" : "(modify)"}: ${path}`,
    context: `File operation from coding agent`,
    files_affected: [path],
    risk_level: riskLevel,
  };
}

async function consultSupervisor(payload) {
  const requestId = randomUUID();
  const responseFile = join(tmpdir(), `pearclaw-res-${requestId}.json`);

  // Write a direct response-request file that the agent's heartbeat picks up
  const inboxDir =
    process.env.OPENCLAW_MCP_INBOX_DIR ||
    join(process.env.HOME || "~", ".openclaw", "mcp-inbox");

  const envelope = {
    requestId,
    type: "consult",
    payload,
    responseFile,
    ts: Date.now(),
  };

  // Try gateway-call first (fast path)
  try {
    const params = JSON.stringify({
      kind: "systemEvent",
      sessionTarget: "main",
      payload: {
        kind: "mcpSupervisorRequest",
        ...payload,
        requestId,
        responseFile,
      },
    });

    execSync(`openclaw gateway call system-presence --params '${params.replace(/'/g, "'\\''")}'`, {
      timeout: 3000,
      stdio: "pipe",
    });
  } catch {
    // Gateway call failed — write to inbox dir as fallback
    try {
      execSync(`mkdir -p "${inboxDir}"`);
      writeFileSync(
        join(inboxDir, `req-${requestId}.json`),
        JSON.stringify(envelope, null, 2)
      );
    } catch {
      // Both transports failed — fail open
      return { decision: "approve", reason: "Supervisor unreachable — failing open." };
    }
  }

  // Poll for response
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(responseFile)) {
      try {
        const data = JSON.parse(readFileSync(responseFile, "utf8"));
        try { unlinkSync(responseFile); } catch {}
        return data;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Timed out — fail open
  return { decision: "approve", reason: "Supervisor timed out — failing open." };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
let input = "";
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  clearTimeout(stdinTimeout);

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;
    const toolInput = data.tool_input;

    // Only intercept write/exec tools (Write/Edit/MultiEdit: Claude Code, apply_patch: Codex)
    if (!["Write", "Edit", "MultiEdit", "Bash", "apply_patch"].includes(toolName)) {
      process.exit(0);
      return;
    }

    const riskLevel = assessRisk(toolName, toolInput);

    // Only escalate medium/high risk to supervisor
    if (riskLevel === "low") {
      process.exit(0);
      return;
    }

    const payload = buildPayload(toolName, toolInput, riskLevel);
    const result = await consultSupervisor(payload);

    if (result.decision === "block") {
      // Exit code 2 = block with message
      const msg = `🚫 Supervisor blocked this action.\nReason: ${result.reason}${
        result.suggestion ? `\nSuggestion: ${result.suggestion}` : ""
      }`;
      process.stdout.write(JSON.stringify({ decision: "block", reason: msg }));
      process.exit(2);
      return;
    }

    if (result.decision === "modify" && result.suggestion) {
      // Exit 0 with additionalContext. Emit both the flat shape (Claude Code)
      // and the hookSpecificOutput-nested shape (Codex) so one payload works
      // on either harness — each ignores the key it doesn't recognize.
      const guidance = `🟡 Supervisor guidance: ${result.suggestion}`;
      process.stdout.write(
        JSON.stringify({
          additionalContext: guidance,
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: guidance },
        })
      );
    }

    process.exit(0);
  } catch {
    process.exit(0); // Silent fail — never block on hook errors
  }
});
