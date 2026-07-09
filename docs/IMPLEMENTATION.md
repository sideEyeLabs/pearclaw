# IMPLEMENTATION — PearClaw

## Core components
- MCP server (`src/server.js`) — 4 tools: consult_supervisor, get_supervisor_message, notify_supervisor, get_session_context
- gateway bridge (`src/gateway-bridge.js`) — three transports: `"gateway-call"` (the gateway `wake` RPC, `mode: "now"` for consults / `"next-heartbeat"` for notifies), `"file"` (drop-file inbox), and `"webhook"` (added 2026-07-09, for a gateway on a different host — POSTs to OpenClaw's real `hooks.enabled` HTTP route targeting an isolated agent turn; response comes back via a one-shot authenticated curl-back to `src/response-server.js` instead of a shared response file, since OpenClaw has no built-in outbound-webhook delivery for hook-triggered turns). Response-schema validation and the append-only audit log (`~/.pearclaw/audit.jsonl`) apply to all three. The PreToolUse hook imports this module instead of reimplementing delivery (was: `cron.add` one-shot in the bridge + a divergent `system-presence` call in the hook — both replaced 2026-07-09)
- context injector (`src/context-injector.js`) — reads KERNEL.md, BRAIN.md, today's memory and returns a compact injection string on same-host transports; delegates to the bridge's webhook-based remote fetch (isolated agent turn reads the files itself and curls the formatted text back) when the gateway is on a different host
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
- run a real end-to-end consult round-trip on this machine (no evidence one has ever completed: `~/.pearclaw/` and `~/.openclaw/mcp-inbox/` did not exist as of 2026-07-09) — **still true, but reduced to one blocking step.** The webhook protocol is verified against a mocked gateway (`npm test`, 7/7); the real `hooks.enabled`/`hooks.path`/`hooks.token`/`hooks.allowedAgentIds` config is staged and `config validate`-clean on the real gateway, but not yet active because `hooks.enabled` requires a gateway restart to take effect (not hot-reloadable, corrects an earlier assumption) and gateway lifecycle commands are explicit-user-request-only per `AGENTS.md`. See `docs/REMOTE_TRANSPORT_PLAN.md`'s verification-status section — next step is literally "restart the gateway," then run the loopback curl test described there.
- **register `pearclaw` for a real Claude Code session** — **fixed 2026-07-09.** Was defined only under `mcpServers` in `~/.claude/settings.json`, which Claude Code does not read for user-scope registration. Registered correctly via `claude mcp add pearclaw --scope user -- node /Users/hedy/code/hedy-mcp/src/server.js` (writes the top-level `mcpServers` key in `~/.claude.json`, matching the previous env vars); the stale, non-functional entry in `~/.claude/settings.json` was removed. Confirmed live: `claude mcp list` shows `pearclaw: ... - ✔ Connected`. This is the first time `pearclaw` has been reachable from a real Claude Code session on this host. Remote machines still need the equivalent `claude mcp add` run locally with `PEARCLAW_WEBHOOK_URL`/`PEARCLAW_WEBHOOK_TOKEN`/`PEARCLAW_AGENT_ID` env vars once the webhook transport is live (see remote-machine setup in `docs/REMOTE_TRANSPORT_PLAN.md`).

## Done (2026-07-09, fix/transport-architecture)
- fixed the `pearclaw` Claude Code MCP registration bug (see above) — first time it's been reachable from a real Claude Code session, on any host, ever.
- added a third `"webhook"` transport (`src/gateway-bridge.js` + new `src/response-server.js`) for a gateway on a different host: request via OpenClaw's real `hooks.enabled` HTTP route (isolated agent turn, not the invented flow-lifecycle API an earlier draft of `docs/REMOTE_TRANSPORT_PLAN.md` assumed), response via a one-shot authenticated curl-back instead of a shared file; `get_session_context` reuses the same mechanism for remote hosts. Covered by two new integration tests against a mocked gateway; `npm test` is 7/7.
- replaced `cron.add`-with-3s-delay delivery with the gateway `wake` RPC (verified against openclaw protocol docs + gateway source)
- removed the hook's broken `system-presence` fast path (read-only RPC, params ignored — every hook escalation silently burned the full timeout and failed open)
- collapsed hook + bridge into one transport implementation; hook imports the bridge
- fixed install docs: Claude Code hooks live in settings files (`~/.claude/settings.json`), not `~/.claude/hooks.json`; matchers are strings; timeout is in seconds
- added response-schema validation + `~/.pearclaw/audit.jsonl` audit trail
- added package export map so hooks copied outside the repo can resolve `pearclaw/*` modules
