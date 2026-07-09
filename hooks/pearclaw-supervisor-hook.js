#!/usr/bin/env node
/**
 * pearclaw-supervisor PreToolUse hook
 *
 * Fires before Write/Edit/Bash (Claude Code) or apply_patch/Bash (Codex CLI)
 * tool calls and consults your OpenClaw agent for any high-risk action.
 * Lower-risk actions pass through. Same script installs into either harness.
 *
 * Transport: this hook imports the shared gateway bridge from the pearclaw
 * package (src/gateway-bridge.js) — it does not implement its own delivery.
 * If the package can't be resolved, the hook fails open (exit 0).
 *
 * Install for Claude Code: copy to ~/.claude/hooks/ and add to the "hooks"
 * key of ~/.claude/settings.json (or .claude/settings.json per project).
 * Claude Code reads hooks from settings files only — there is no separate
 * ~/.claude/hooks.json. Matchers are strings and timeout is in SECONDS:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Write|Edit|MultiEdit|Bash",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ~/.claude/hooks/pearclaw-supervisor-hook.js",
 *           "timeout": 30
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
 *           "timeout": 30
 *         }]
 *       }]
 *     }
 *   }
 *
 * Block contract: on a supervisor "block" the hook exits 2 with the reason on
 * stderr (Claude Code ignores stdout on exit 2 and feeds stderr to the model)
 * and also prints `{"decision":"block",...}` JSON to stdout for Codex.
 *
 * Note: Codex's docs describe PreToolUse as "a guardrail rather than a
 * complete enforcement boundary" — it doesn't yet intercept every shell path
 * (e.g. unified_exec) the way Claude Code's hook does. Treat it as
 * best-effort on Codex, not a hard boundary.
 */

import { existsSync } from "fs";

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

/**
 * Resolve the shared bridge + config from the pearclaw package.
 * Resolution order:
 *   1. Sibling path (hook lives inside the repo: hooks/ → ../src/)
 *   2. Package resolution (hook copied to ~/.claude/hooks/ with pearclaw
 *      installed — uses the package export map)
 */
async function loadBridge() {
  const candidatePairs = [
    [
      new URL("../src/gateway-bridge.js", import.meta.url).href,
      new URL("../src/config.js", import.meta.url).href,
    ],
    ["pearclaw/gateway-bridge", "pearclaw/config"],
  ];

  for (const [bridgePath, configPath] of candidatePairs) {
    try {
      const [bridgeMod, configMod] = await Promise.all([
        import(bridgePath),
        import(configPath),
      ]);
      if (
        typeof bridgeMod.createGatewayBridge === "function" &&
        typeof configMod.loadConfig === "function"
      ) {
        return bridgeMod.createGatewayBridge(configMod.loadConfig());
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function consultSupervisor(payload) {
  const bridge = await loadBridge();
  if (!bridge) {
    // Package unavailable — no transport exists, fail open
    return { decision: "approve", reason: "PearClaw bridge unavailable — failing open." };
  }
  try {
    return await bridge.consult(payload);
  } catch (err) {
    // Timeout / delivery failure / malformed response — fail open
    return { decision: "approve", reason: `Supervisor unreachable (${err.message}) — failing open.` };
  }
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
      const msg = `🚫 Supervisor blocked this action.\nReason: ${result.reason}${
        result.suggestion ? `\nSuggestion: ${result.suggestion}` : ""
      }`;
      // Claude Code: exit 2 blocks; stderr (not stdout) is fed to the model.
      // Codex: exit 2 + `{"decision":"block",...}` JSON on stdout blocks.
      process.stderr.write(msg);
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
