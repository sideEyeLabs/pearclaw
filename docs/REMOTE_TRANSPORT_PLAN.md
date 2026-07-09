# PLAN — Cross-machine transport for PearClaw (webhooks plugin)

Agreed with Dan in Slack `#pearclaw` (C0AQYQG20RY), 2026-07-09, thread starting ~11:00 ICT.
Builds on `fix/transport-architecture` (commits through `c1f190d`) — do not redo that work.
Read `docs/CHALLENGES.md`, `docs/IMPLEMENTATION.md`, `skill/SKILL.md` first.

> **Corrected 2026-07-09 (later same day), after implementation.** The design below assumed a
> webhooks-plugin API (`create_flow`/`run_task`/`get_task_summary`/`resolve_flow`/`set_waiting`/
> `resume_flow`/`finish_flow`/`fail_flow`) that does not exist anywhere in OpenClaw — verified
> against the installed package's own docs and a live `config.schema.lookup` call, not assumed.
> The real inbound HTTP surface is `hooks.enabled`/`hooks.token`/`hooks.path` with exactly two
> routes, `POST <path>/wake` and `POST <path>/agent` (see `docs/automation/cron-jobs.md#webhooks`
> in the installed OpenClaw package). There is no built-in mechanism for OpenClaw to POST a
> hook-triggered agent turn's result to an arbitrary external URL (that exists only for **cron**
> jobs via `--webhook <url>`, a different subsystem) — so the response side below is **not**
> "poll `get_task_summary`" as originally planned; see "What actually got built" below for the
> real design, which keeps this plan's actual goals (authenticated HTTP, no shared filesystem,
> narrow scoping, SecretRef-backed tokens) while using primitives that exist.

## What actually got built (implemented, tested against a mocked hooks endpoint — not yet a live cross-host round trip; see Verification status)

- **Request side:** `src/gateway-bridge.js`'s `"webhook"` transport POSTs to `<hooks.path>/agent`
  with `Authorization: Bearer <hooks.token>`, targeting an **isolated agent turn** under a
  configured `agentId` (not `wake` on the shared main session — see the async job's decisions log
  for why: an isolated turn gets Hedy's real SOUL/AGENTS/skill bootstrap without hijacking Dan's
  live foreground chat, and is the only way to test "a live agent turn responds" without doing
  that).
- **Response side:** since there's no outbound-webhook mechanism for hook-triggered turns, the
  message tells the responding agent turn to `curl` its JSON decision back to a `responseUrl`
  embedded in the request, authenticated with a one-shot per-request bearer secret, received by
  `src/response-server.js`'s local HTTP listener (one process-lifetime server, requests
  multiplexed by requestId, single-use token per request).
- **Context side:** `get_session_context` over webhook reuses the identical request/response
  mechanism with `type: "context"` — the isolated turn is asked to read KERNEL.md/BRAIN.md/memory
  itself (real files on the gateway host, which the turn has ordinary Read/Bash access to as
  Hedy's agent) and curl the formatted text back, instead of `context-injector.js`'s local
  `readFileSync`.
- **Security:** `hooks.allowedAgentIds` scopes which agent a hook request can target;
  `hooks.allowRequestSessionKey: false` (default) means no caller-controlled session key.
  `hooks.token` supports SecretRef (`{source:"env"|"file", ...}`) per OpenClaw's secrets model —
  use that for any real deployment; the verification run below used a plaintext test token
  (explicitly supported: "Plaintext still works. SecretRefs are opt-in per credential") scoped to
  a throwaway config, never the production `openclaw.json`.

## Problem

Dan runs Claude Code / Codex CLI on a **different machine** than Hedy/OpenClaw, connected via
**Tailscale** (always-on, both machines). Every current transport in this repo assumes the MCP
server and the OpenClaw gateway/agent share a filesystem:

- `consult_supervisor` / `notify_supervisor`: request goes out fine via the gateway `wake` RPC
  (`config.gatewayUrl` already supports a remote `--url`), but the **response** is written to a
  local tmp file (`gateway-bridge.js:pollForResponse`) that only exists on the gateway host.
- `get_supervisor_message`: push inbox is a local tmp file (`PUSH_INBOX`), same problem in reverse.
- `get_session_context`: `context-injector.js` reads `KERNEL.md` / `BRAIN.md` / today's memory
  straight off local disk — unreachable from the remote machine at all.

This is the exact gap already named in `docs/CHALLENGES.md` ("remote-gateway support... not
built yet") — this plan builds it, using OpenClaw's real webhooks plugin rather than a bespoke
server. Confirmed live: `openclaw webhooks` is a real CLI surface, `@openclaw/webhooks` ships
with OpenClaw, docs at `docs/plugins/webhooks.md` in the OpenClaw package.

## What the webhooks plugin actually gives us

Authenticated HTTP routes bound to a `sessionKey`, running inside the Gateway process:

- `POST <path>` with `Authorization: Bearer <secret>`, JSON body `{"action": ..., ...}`
- Relevant actions: `create_flow`, `run_task`, `get_task_summary`, `resolve_flow`,
  `set_waiting`, `resume_flow`, `finish_flow`, `fail_flow`
- Shared-secret auth, body-size/timeout guards, rate limiting — all built in, don't reimplement.
- Config lives under `plugins.entries.webhooks.config.routes.<routeId>` (route path, sessionKey,
  secret SecretRef, controllerId).

## Design

Add a third `gateway-bridge.js` transport, `"webhook"`, alongside the existing `gateway-call`
and `file` transports (keep both of those — same-host installs still work without any of this).

**Request side (remote pearclaw → Hedy):**
- `consult` / `notify` POST to the configured webhook route with `action: "run_task"` (or
  `create_flow` if no flow exists yet for this coding session — decide flow lifecycle: one flow
  per coding-agent session, reused across consults, closed on `notify_supervisor session_end`).
- Task body = the same formatted message `formatAgentMessage()` already builds today — no need
  to redesign the message shape, only the transport underneath it.

**Response side (Hedy → remote pearclaw):**
- Replace local-file polling with polling `get_task_summary` / `resolve_flow` on the created
  task/flow until it reports done, then parse the decision out of the task result.
- Hedy still writes the actual JSON decision the same way she does today (per `skill/SKILL.md`)
  — only the delivery mechanism changes, not the response contract or the "explain the gap"
  requirement, which stays as-is.

**Context side (`get_session_context` for the remote host):**
- Add a `get_context` webhook action (or reuse `create_flow`+immediate resolve) so
  `context-injector.js` can fetch `KERNEL.md`/`BRAIN.md`/today's memory over the same
  authenticated route instead of local `readFileSync`. Same content, same 2500-char cap —
  only the transport changes.

**Security:**
- Bind the route to the narrowest session (my actual working session, not a shared/general one).
- Secret via `SecretRef` (env var), never inline plaintext, per the plugin's own guidance.
- Gateway must listen on the Tailscale interface/hostname for this route — confirm OpenClaw's
  bind config supports scoping to a specific interface; do not bind `0.0.0.0` if avoidable.

## Remote-machine setup

- Install `pearclaw` (this repo, or a published package once it's published) on the machine
  running Claude Code / Codex.
- Point its config at the Tailscale hostname/IP for the gateway + the webhook secret, instead
  of `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:...` (that's loopback-only, won't reach across hosts —
  need to confirm the gateway's `wake` RPC / webhook port is actually reachable over Tailscale,
  not just bound to loopback, before wiring the remote side up).
- `claude/CLAUDE.md` and `codex/AGENTS.md` protocol docs don't need content changes — same
  tool contract from the coding agent's point of view either transport.

## Also fix while touching this (found during investigation, not yet done anywhere)

- `pearclaw` MCP server is defined under `mcpServers` in `~/.claude/settings.json`, which is
  **not** where Claude Code reads user-scope MCP registrations from — that's the top-level
  `mcpServers` key in `~/.claude.json` (what `claude mcp add --scope user` writes). Confirmed
  2026-07-09: `~/.claude.json` only lists `claude-code-config-sync` and `memory`; pearclaw isn't
  registered there or in any of the 22 per-project `mcpServers` entries. This means pearclaw has
  never actually been reachable from a real Claude Code session on **any** host, ever — separate
  bug from the remote-transport gap above, fix both. Use
  `claude mcp add pearclaw node /path/to/hedy-mcp/src/server.js --scope user` (with the env vars
  currently in settings.json) once the webhook transport exists, so the registration points at
  the right config for whichever machine it's installed on.

## Out of scope for this plan

- The `consult_supervisor` "MANDATORY... do NOT find workarounds" binding-authority framing in
  the protocol docs — Dan's direction (2026-07-09 #pearclaw) is to move toward "ask Hedy for a
  second opinion" rather than "obey Hedy's block unconditionally." Re-scope `claude/CLAUDE.md` /
  `codex/AGENTS.md` protocol language as a separate follow-up once the transport itself works —
  don't conflate a wording/framing change with the transport rebuild in the same PR.
- Publishing `pearclaw` as an installable package for the remote machine — for now, install by
  pointing the remote Claude Code config at a copy/clone of this repo; packaging is future work.

## Verification gate

Do not report this done without a real end-to-end round trip: remote machine's Claude Code
calls `consult_supervisor`, request arrives in Hedy's session over the webhook route (not a
local file), Hedy responds, remote pearclaw receives the decision within its timeout. Same bar
IMPLEMENTATION.md already sets for the local case ("no evidence one has ever completed" was true
as of this morning) — don't repeat that gap for the remote path.

### Verification status (2026-07-09, honest accounting)

**Verified:** the full request→response protocol (HTTP auth on the request, message shape, the
curl-back response contract, response auth, one-shot delivery, timeout handling, malformed-input
handling for both `consult_supervisor` and `get_session_context`) via `test/integration.js`'s
`testWebhookRoundTrip`/`testWebhookContext`, which stand in for the real gateway's
`<hooks.path>/agent` route with a plain HTTP server and play "Hedy" by running the exact `curl`
command the real message text specifies. `npm test` passes (7/7).

**Not verified — the literal bar above:** a genuinely live agent turn, on a real running OpenClaw
gateway's actual `hooks.enabled` route, receiving and responding to this. Two ways to get there
were tried and both were correctly declined/blocked rather than forced:

1. Enabling `hooks` on Dan's real production gateway (`~/.openclaw/openclaw.json`) and pointing a
   test consult at it — the config is now **staged but not activated**. `openclaw config set` was
   used (not `config.patch`, which hit an unrelated pre-existing validation error,
   `models.providers.openai.baseUrl: Too small` — real, worth Dan's attention on its own, out of
   scope here) for `hooks.enabled=true`, `hooks.path=/pearclaw-hooks-test` (dedicated path, not a
   guessable default), `hooks.token='${PEARCLAW_HOOKS_TOKEN}'` (env-template string — `hooks.token`
   rejects SecretRef *objects* specifically: "This credential is runtime-mutable... Use a plain
   string (env template strings like `${MY_VAR}` are allowed)"; the token itself lives in
   `~/.zshenv`, never inline), `hooks.allowedAgentIds=["main"]`. `openclaw config validate` passes.
   **Correction to an earlier assumption in this doc:** `hooks.enabled` is *not* hot-reloadable —
   all four `config set` calls returned "Restart the gateway to apply." A restart doesn't change
   network exposure by itself (bind stays `"loopback"`; reaching this from a genuinely different
   host still separately requires `gateway.bind: "tailnet"` + `gateway.tailscale.mode: "serve"`,
   confirmed live as `"loopback"`/`"off"` today) but it does interrupt Dan's actual running
   assistant process, and `AGENTS.md`'s Runtime section is explicit that gateway lifecycle
   commands are "CLI lifecycle only on explicit user request." Declined to run it unilaterally —
   same "ask first, shared live system" category as the tailnet-exposure decision, just a smaller
   version of it, and now reduced to exactly one blocking step instead of an open design question.
2. Standing up a fully isolated throwaway gateway (`openclaw --profile pearclaw-test gateway run
   ...`, its own config dir, port 19011, zero shared state with production) to avoid touching
   anything real — got a valid config running, but OpenClaw's own singleton guard detected the
   already-running launchd-managed production gateway and refused to start a second instance
   ("already running under launchd; existing gateway is healthy, leaving it in control"). That's
   a real safety feature, not a bug to route around.

**Net effect:** the transport code and protocol are real and tested; the MCP registration bug is
fixed (`pearclaw` is now reachable from a real Claude Code session on this host for the first
time ever — `claude mcp list` shows `pearclaw: ... - ✔ Connected`, registered via
`claude mcp add --scope user` into the correct `~/.claude.json` top-level `mcpServers`, with the
stale non-functional entry removed from `~/.claude/settings.json`); the literal "live gateway,
live model, live curl-back" round trip is staged and one restart away, not yet demonstrated,
because both safe paths to demonstrate it terminate in something only Dan should decide (restart
the live gateway to activate already-staged hooks config; separately, later, decide whether to
expose it to the tailnet) or something OpenClaw itself correctly refuses (a second gateway
instance). **Next step for Dan:** say "restart the gateway" (or run it himself) — `hooks.enabled`,
`hooks.path`, `hooks.token`, and `hooks.allowedAgentIds` are already staged and `config validate`
clean, so a restart alone unlocks the loopback round trip (`curl 127.0.0.1:18789/pearclaw-hooks-test/agent`
with the `PEARCLAW_HOOKS_TOKEN` from `~/.zshenv`, targeting `agentId: "main"`, and watching a real
isolated agent turn respond). The tailnet-exposure step (`gateway.bind`/`gateway.tailscale.mode`)
is a separate, later decision only needed once Dan wants to test from his actual second machine
rather than loopback on the gateway host.
