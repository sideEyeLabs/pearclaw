# PearClaw 🍐

**Give your OpenClaw agent real-time oversight of Claude Code or Codex CLI.**

Your AI stays in the loop on every significant action, reviews decisions in context, and can block or redirect before code is written. Pair programming where one of the pair actually knows your codebase. Works the same way whether the pair-programmer is Claude Code or Codex CLI — both speak MCP and get the same supervisor.

```
You type a task into Claude Code or Codex CLI
         ↓
The coding agent plans an action (write file, run command, etc.)
         ↓
consult_supervisor() — asks your OpenClaw agent
         ↓
OpenClaw reviews in context, responds: approve / block / modify
         ↓
The coding agent proceeds (or stops)
         ↓
notify_supervisor() — agent gets a completion summary
```

---

## Why

Claude Code and Codex CLI are powerful but operate in isolation. They don't know:
- Your codebase conventions that aren't written down
- That you already have a utility for that in `lib/`
- That this migration will break production
- What you decided two sessions ago

Your OpenClaw agent does. This bridge connects them.

---

## Install

### 1. Install the MCP server

```bash
npm install -g pearclaw
```

Or run without installing:
```bash
npx pearclaw
```

### 2. Add the MCP server to your coding agent

**Claude Code** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["pearclaw"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18788"
      }
    }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.pearclaw]
command = "npx"
args = ["pearclaw"]
env = { OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18788" }
```

Replace the gateway URL with your OpenClaw gateway address. Find it with:
```bash
openclaw gateway status
```

If your gateway uses token auth, add `OPENCLAW_GATEWAY_TOKEN` to the same `env` block.

### 3. Add the supervisor protocol doc

**Claude Code** — copy `claude/CLAUDE.md` to your project root. This tells Claude Code when and how to use the supervisor tools.

```bash
cp node_modules/pearclaw/claude/CLAUDE.md ./CLAUDE.md
```

Or append it to an existing `CLAUDE.md`.

**Codex CLI** — copy `codex/AGENTS.md` to your project root (Codex reads `AGENTS.md` the way Claude Code reads `CLAUDE.md`):

```bash
cp node_modules/pearclaw/codex/AGENTS.md ./AGENTS.md
```

Or append it to an existing `AGENTS.md`. The protocol text is identical between the two files — only the filename convention differs.

### 4. Install the OpenClaw skill

Copy the supervisor skill to your OpenClaw workspace:

```bash
cp -r node_modules/pearclaw/skill ~/.openclaw/workspace/skills/mcp-supervisor
```

This tells your OpenClaw agent how to handle incoming review requests and write responses. Same skill regardless of which coding agent is asking.

### 5. (Optional) Install the PreToolUse hook

For automatic escalation of high-risk actions without relying on the coding agent calling `consult_supervisor` itself. The same script (`hooks/pearclaw-supervisor-hook.js`) installs into either harness — its I/O contract (JSON on stdin, exit code 2 + `{"decision":"block","reason":...}` to block) is compatible across both.

**Claude Code** — copy to `~/.claude/hooks/` and add to `~/.claude/hooks.json`:

```bash
cp node_modules/pearclaw/hooks/pearclaw-supervisor-hook.js ~/.claude/hooks/
```

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": { "tool_name": "Write|Edit|MultiEdit|Bash" },
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/pearclaw-supervisor-hook.js",
        "timeout": 28000
      }]
    }]
  }
}
```

**Codex CLI** — copy to `~/.codex/hooks/` and add to `~/.codex/hooks.json`:

```bash
cp node_modules/pearclaw/hooks/pearclaw-supervisor-hook.js ~/.codex/hooks/
```

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|apply_patch",
      "hooks": [{
        "type": "command",
        "command": "node ~/.codex/hooks/pearclaw-supervisor-hook.js",
        "timeout": 28
      }]
    }]
  }
}
```

(Codex hook `timeout` is in seconds, not ms.) Codex will prompt you to trust the hook the first time it fires — see `codex hooks` docs / `/hooks` in the Codex CLI.

Note: Codex's own docs describe `PreToolUse` as "a guardrail rather than a complete enforcement boundary" — it doesn't intercept every shell path yet (e.g. `unified_exec`). Treat it as defense in depth, not a hard boundary, on either platform.

---

## Configuration

All config via environment variables or `~/.pearclaw.json`.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18788` | OpenClaw gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | — | Auth token (if required) |
| `OPENCLAW_MCP_SESSION` | `main` | Agent session to target |
| `OPENCLAW_MCP_INBOX_DIR` | `~/.openclaw/mcp-inbox` | Drop-file inbox (fallback) |
| `OPENCLAW_MCP_TIMEOUT` | `25000` | Response timeout (ms) |
| `OPENCLAW_MCP_FAIL_OPEN` | `true` | Approve when supervisor unreachable |

### `~/.pearclaw.json` (optional)

```json
{
  "gatewayUrl": "ws://127.0.0.1:18788",
  "sessionTarget": "main",
  "failOpen": true
}
```

---

## How the supervisor responds

When the coding agent calls `consult_supervisor`, your OpenClaw agent receives a structured message and writes a JSON response to a temp file.

**Approve:**
```json
{ "decision": "approve", "reason": "Looks good." }
```

**Block:**
```json
{ "decision": "block", "reason": "We already have this in lib/stripe.js.", "suggestion": "Import from there instead." }
```

**Modify:**
```json
{ "decision": "modify", "reason": "Right idea, small change needed.", "suggestion": "Add idempotency check at top." }
```

See `skill/SKILL.md` for the full supervisor protocol.

### Session context injection

At the start of every session, the coding agent calls `get_session_context` to load Hedy's live operational state:

```
get_session_context({ project?: "wegodive" })
```

This reads three files from `~/.openclaw/workspace/` and returns a compact summary (capped at ~2500 chars):

| File | Lines read | Purpose |
|------|-----------|--------|
| `KERNEL.md` | First 60 | Identity, rules, red lines |
| `BRAIN.md` | First 50 | Current sprint, active blockers |
| `memory/YYYY-MM-DD.md` | Last 30 | What happened today |

Context is also written to `~/.pearclaw/session-context.md` for debugging.

**SessionStart hook** (`hooks/pearclaw-session-start.js`) fires automatically before the first message when installed, injecting context without needing an explicit tool call. Same script for both harnesses:

**Claude Code** (`~/.claude/hooks.json`):
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/pearclaw-session-start.js",
        "timeout": 8000
      }]
    }]
  }
}
```

**Codex CLI** (`~/.codex/hooks.json`):
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{
        "type": "command",
        "command": "node ~/.codex/hooks/pearclaw-session-start.js",
        "timeout": 8
      }]
    }]
  }
}
```

Hedy can push context proactively by updating `BRAIN.md` or `KERNEL.md` — changes are picked up on the next session start automatically.

---

## Tools exposed to the coding agent

### `consult_supervisor`

Synchronous review. The coding agent blocks until your agent responds (or timeout).

```
action:         What you're about to do
context:        Why
files_affected: File paths involved
risk_level:     low | medium | high
```

### `notify_supervisor`

Fire-and-forget update. No response needed.

```
event:    task_complete | task_failed | session_end | info
summary:  What happened
details:  Optional structured data
```

---

## Limitations

- Response timeout: 25 seconds. If your agent doesn't respond in time, the action is approved (fail-open by default).
- Requires OpenClaw gateway running locally (or accessible via network).
- The supervisor can only block/modify — it can't rewrite code directly (yet).
- Codex's `PreToolUse` hook is best-effort (see install step 5) — it doesn't cover every tool path yet.

---

## Built by

[SideEye Labs](https://sideeyelabs.io) — building vertical AI for the real world.

Part of the [OpenClaw](https://openclaw.ai) ecosystem.
