#!/usr/bin/env node
/**
 * pearclaw-session-start.js — SessionStart hook for Claude Code or Codex CLI.
 *
 * Fires at the beginning of every session. Reads Hedy's live context and
 * injects it so the coding agent doesn't start cold. Same script installs
 * into either harness's hooks directory.
 *
 * Install for Claude Code: copy to ~/.claude/hooks/ and add to ~/.claude/hooks.json:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ~/.claude/hooks/pearclaw-session-start.js",
 *           "timeout": 8000
 *         }]
 *       }]
 *     }
 *   }
 *
 * Install for Codex CLI: copy to ~/.codex/hooks/ and add to ~/.codex/hooks.json:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "matcher": "startup|resume",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ~/.codex/hooks/pearclaw-session-start.js",
 *           "timeout": 8
 *         }]
 *       }]
 *     }
 *   }
 *
 * Output format: { "additionalContext": "...", "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
 * (the flat key is Claude Code's contract, the nested key is Codex's — one payload satisfies both)
 * Context is also written to ~/.pearclaw/session-context.md for inspection.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PEARCLAW_DIR = join(homedir(), ".pearclaw");
const CONTEXT_FILE = join(PEARCLAW_DIR, "session-context.md");
const TIMEOUT_MS = 5000;

/**
 * Dynamically import the context injector from the pearclaw package.
 * We resolve relative to this file's location so it works whether the hook
 * is symlinked or copied, as long as the pearclaw package is on the path.
 *
 * Resolution order:
 *   1. Sibling path (hook lives inside repo: hooks/ → ../src/)
 *   2. Global npm install (npx pearclaw resolves via PATH)
 */
async function loadContextInjector() {
  // Try relative path first (development / repo install)
  const candidates = [
    new URL("../src/context-injector.js", import.meta.url).pathname,
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.getContext === "function") return mod.getContext;
    } catch {
      // try next
    }
  }

  // Fallback: try resolving from node_modules
  try {
    const mod = await import("pearclaw/context-injector");
    if (typeof mod.getContext === "function") return mod.getContext;
  } catch {
    // not installed globally
  }

  return null;
}

function writeContext(contextStr) {
  try {
    mkdirSync(PEARCLAW_DIR, { recursive: true });
    writeFileSync(CONTEXT_FILE, contextStr, "utf8");
  } catch {
    // Non-fatal — context injection still works via stdout
  }
}

async function main() {
  let context = "";

  // Race the context read against a hard timeout
  const contextPromise = loadContextInjector().then((getContext) => {
    if (!getContext) return "";
    return getContext(""); // no project hint at session start
  });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(""), TIMEOUT_MS)
  );

  try {
    context = await Promise.race([contextPromise, timeoutPromise]);
  } catch {
    context = "";
  }

  writeContext(context || "(PearClaw: no context available for this session.)");

  // Emit the hook output. Flat additionalContext is Claude Code's contract;
  // hookSpecificOutput.additionalContext is Codex's. One payload, either harness.
  if (context) {
    process.stdout.write(
      JSON.stringify({
        additionalContext: context,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      })
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
