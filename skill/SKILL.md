# PearClaw Supervisor Skill

This skill enables your OpenClaw agent to act as a real-time supervisor for coding-agent sessions — Claude Code or Codex CLI. Both connect through the same `pearclaw` MCP server and tool contract, so requests look identical regardless of which one is running.

When the coding agent calls `consult_supervisor`, a review request arrives in your session. You review the action, decide approve/block/modify, and write your decision to the response file.

---

## How review requests arrive

You'll receive a message like:

```
🟡 Coding agent review request (medium risk)

Action: Write (new): src/api/stripe-webhook.js
Files: src/api/stripe-webhook.js
Context: Adding Stripe webhook handler for subscription events

Respond with JSON to `/tmp/pearclaw-res-<uuid>.json`:
{"decision":"approve","reason":"..."} or {"decision":"block","reason":"...","suggestion":"..."}
```

## Your response format

Write a JSON file to the `responseFile` path in the request:

```json
{
  "decision": "approve",
  "reason": "Looks good — webhook handler follows existing patterns."
}
```

```json
{
  "decision": "block",
  "reason": "Don't add Stripe logic here — we already have this in lib/stripe.js.",
  "suggestion": "Edit lib/stripe.js instead and import from there."
}
```

```json
{
  "decision": "modify",
  "reason": "Approved with changes.",
  "suggestion": "Add idempotency key check at the top of the handler."
}
```

## Decision guide

| Decision | Use when |
|----------|----------|
| `approve` | Action looks correct and consistent with project patterns |
| `block` | Action is wrong, duplicates existing code, violates conventions, or is risky |
| `modify` | Action is right direction but needs a specific change before proceeding |

## Handling the response

To write your decision, use the `exec` tool:

```bash
cat > /tmp/pearclaw-res-<uuid>.json << 'EOF'
{"decision":"approve","reason":"Good to go."}
EOF
```

Or via the Write tool targeting the exact `responseFile` path from the request.

**Critical:** Write to the exact `responseFile` path from the request. The coding agent is polling that file and will time out in ~25 seconds if it doesn't appear.

## Notify events

You'll also receive one-way notifications:

```
🤖 Coding agent update [task_complete]: Added Stripe webhook handler. Files changed: src/api/stripe-webhook.js. PR: #142.
```

These don't need a response — just log them to today's memory.

## Proactive context injection

You can push context to the next session without waiting for a request. Any changes you make to `BRAIN.md` or `KERNEL.md` in `~/.openclaw/workspace/` are automatically picked up the next time a session starts (via the `get_session_context` MCP tool or the `pearclaw-session-start.js` hook — installed for either Claude Code or Codex CLI).

Use this to:
- Update `BRAIN.md` with the current sprint focus so the coding agent starts aligned
- Add a constraint to `KERNEL.md` that should apply to all future sessions
- Record a recent architectural decision that the coding agent should know about

No reload or restart needed — context injection is stateless and reads live files each session.

## Setup

See `README.md` for full installation instructions.
