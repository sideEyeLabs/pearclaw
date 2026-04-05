# PearClaw

## Project Overview
OpenClaw supervision bridge for Claude Code. Allows real-time approve/block/modify decisions and proactive context injection.

## Tech Stack
- Node.js
- MCP SDK
- WebSocket gateway bridge

## Before changing anything
Read:
- `README.md`
- `docs/SPEC.md` if present
- `docs/SECURITY.md`
- `tasks/lessons.md` if present
- quality review notes relevant to PearClaw

## Key Rules
- do not leak internal bridge errors
- keep names/docs/package paths aligned
- treat safety and failure behavior as product features, not cleanup work
