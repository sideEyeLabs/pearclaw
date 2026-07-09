# IMPLEMENTATION — PearClaw

## Core components
- MCP server (`src/server.js`) — 4 tools: consult_supervisor, get_supervisor_message, notify_supervisor, get_session_context
- gateway bridge (`src/gateway-bridge.js`) — single shared transport: delivers requests via the gateway `wake` RPC (`mode: "now"` for consults, `"next-heartbeat"` for notifies), drop-file fallback, response-schema validation, append-only audit log at `~/.pearclaw/audit.jsonl`. The PreToolUse hook imports this module instead of reimplementing delivery (was: `cron.add` one-shot in the bridge + a divergent `system-presence` call in the hook — both replaced 2026-07-09)
- context injector (`src/context-injector.js`) — reads KERNEL.md, BRAIN.md, today's memory and returns a compact injection string
- Claude protocol doc (`claude/CLAUDE.md`) — when/how to use supervisor tools; session start protocol
- Codex protocol doc (`codex/AGENTS.md`) — same protocol, Codex's AGENTS.md convention
- pre-tool hook (`hooks/pearclaw-supervisor-hook.js`) — PreToolUse hook for risky action escalation; shared script, installs into either Claude Code or Codex CLI
- session-start hook (`hooks/pearclaw-session-start.js`) — SessionStart hook that injects Hedy context at session open; shared script, dual-format output for both harnesses
- OpenClaw skill (`skill/SKILL.md`) — supervisor response protocol for Hedy

## Immediate implementation work
- align naming across repo/package/docs
- harden failure-mode handling
- improve reproducibility of install/setup
- get real-world Codex CLI test coverage (hooks were implemented from OpenAI docs, not yet run against a live Codex session)
- run a real end-to-end consult round-trip on this machine (no evidence one has ever completed: `~/.pearclaw/` and `~/.openclaw/mcp-inbox/` did not exist as of 2026-07-09)

## Done (2026-07-09, fix/transport-architecture)
- replaced `cron.add`-with-3s-delay delivery with the gateway `wake` RPC (verified against openclaw protocol docs + gateway source)
- removed the hook's broken `system-presence` fast path (read-only RPC, params ignored — every hook escalation silently burned the full timeout and failed open)
- collapsed hook + bridge into one transport implementation; hook imports the bridge
- fixed install docs: Claude Code hooks live in settings files (`~/.claude/settings.json`), not `~/.claude/hooks.json`; matchers are strings; timeout is in seconds
- added response-schema validation + `~/.pearclaw/audit.jsonl` audit trail
- added package export map so hooks copied outside the repo can resolve `pearclaw/*` modules
