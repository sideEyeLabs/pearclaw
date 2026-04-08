# IMPLEMENTATION — PearClaw

## Core components
- MCP server (`src/server.js`) — 4 tools: consult_supervisor, get_supervisor_message, notify_supervisor, get_session_context
- gateway bridge (`src/gateway-bridge.js`) — delivers requests to Hedy via openclaw cron.add
- context injector (`src/context-injector.js`) — reads KERNEL.md, BRAIN.md, today's memory and returns a compact injection string
- Claude protocol docs (`claude/CLAUDE.md`) — when/how to use supervisor tools; session start protocol
- pre-tool hook (`claude/hooks/openclaw-supervisor-hook.js`) — PreToolUse hook for risky action escalation
- session-start hook (`claude/hooks/pearclaw-session-start.js`) — SessionStart hook that injects Hedy context at session open
- OpenClaw skill (`skill/SKILL.md`) — supervisor response protocol for Hedy

## Immediate implementation work
- align naming across repo/package/docs
- harden failure-mode handling
- patch security issues flagged in review
- improve reproducibility of install/setup
