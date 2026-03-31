# PearClaw 🍐

**Give your OpenClaw agent real-time oversight of Claude Code.**

Your AI stays in the loop on every significant action, reviews decisions in context, and can block or redirect before code is written. Pair programming where one of the pair actually knows your codebase.

```
You type a task into Claude Code
         ↓
Claude Code plans an action (write file, run command, etc.)
         ↓
consult_supervisor() — asks your OpenClaw agent
         ↓
OpenClaw reviews in context, responds: approve / block / modify
         ↓
Claude Code proceeds (or stops)
         ↓
notify_supervisor() — agent gets a completion summary
```

---

## Why

Claude Code is powerful but operates in isolation. It doesn't know:
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

### 2. Add to Claude Code

Add to `~/.claude/settings.json`:

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

Replace the gateway URL with your OpenClaw gateway address. Find it with:
```bash
openclaw gateway status
```

If your gateway uses token auth:
```json
"env": {
  "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18788",
  "OPENCLAW_GATEWAY_TOKEN": "your-token-here"
}
```

### 3. Add the CLAUDE.md protocol

Copy `claude/CLAUDE.md` to your project root. This tells Claude Code when and how to use the supervisor tools.

```bash
cp node_modules/pearclaw/claude/CLAUDE.md ./CLAUDE.md
```

Or append it to an existing `CLAUDE.md`.

### 4. Install the OpenClaw skill

Copy the supervisor skill to your OpenClaw workspace:

```bash
cp -r node_modules/pearclaw/skill ~/.openclaw/workspace/skills/mcp-supervisor
```

This tells your OpenClaw agent how to handle incoming review requests and write responses.

### 5. (Optional) Install the PreToolUse hook

For automatic escalation of high-risk actions without relying on Claude Code calling `consult_supervisor` itself:

```bash
cp node_modules/pearclaw/claude/hooks/openclaw-supervisor-hook.js ~/.claude/hooks/
```

Add to `~/.claude/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": { "tool_name": "Write|Edit|MultiEdit|Bash" },
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/openclaw-supervisor-hook.js",
        "timeout": 28000
      }]
    }]
  }
}
```

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

When Claude Code calls `consult_supervisor`, your OpenClaw agent receives a structured message and writes a JSON response to a temp file.

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

---

## Tools exposed to Claude Code

### `consult_supervisor`

Synchronous review. Claude Code blocks until your agent responds (or timeout).

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

---

## Built by

[SideEye Labs](https://sideeyelabs.io) — building vertical AI for the real world.

Part of the [OpenClaw](https://openclaw.ai) ecosystem.
