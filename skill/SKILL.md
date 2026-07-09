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
  "reason": "This duplicates lib/stripe.js — the coding agent likely didn't see it because it's outside its working directory. lib/stripe.js already wraps webhook signature verification and idempotency handling; writing a second handler here means two divergent Stripe integrations to maintain.",
  "suggestion": "Edit lib/stripe.js instead and import from there."
}
```

```json
{
  "decision": "modify",
  "reason": "Direction is right, but the handler is missing an idempotency key check — Stripe retries webhook delivery on timeout, and without this the subscription-created event could be processed twice. This isn't visible from the diff alone; it's a constraint from Stripe's delivery guarantees, not a style preference.",
  "suggestion": "Add idempotency key check at the top of the handler."
}
```

## Decision guide

| Decision | Use when |
|----------|----------|
| `approve` | Action looks correct and consistent with project patterns |
| `block` | Action is wrong, duplicates existing code, violates conventions, or is risky |
| `modify` | Action is right direction but needs a specific change before proceeding |

## Every block/modify must teach, not just verdict

Claude Code and Codex CLI run on a different machine than this one — they have no access to
this workspace's memory, docs, or file tree, and no way to ask a follow-up question before
their 25s timeout. A bare "no, do X instead" gives them a correction with no way to generalize
it. The `reason` field is the only channel available to fix the coding agent's actual
understanding, so for every `block` or `modify` it must answer two things, not one:

1. **What's wrong with the current path** — the specific mistaken assumption, missing
   context, or overlooked constraint that led to this action. Not "this is wrong" but *why*
   it's wrong (existing code it didn't know about, a constraint from an external system, a
   decision already made elsewhere, a pattern it deviated from).
2. **What it should understand differently going forward** — the fact or rule that, if the
   coding agent had known it, would have produced the right action without being told.

A `reason` that only restates the verdict ("don't do that," "wrong approach," "needs changes")
is not acceptable — if you can't name the specific gap in the coding agent's understanding,
you don't have enough information to block/modify yet; ask a clarifying follow-up or default
toward `approve` with a note instead of blocking on a hunch.

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

You can push context to the next session without waiting for a request. Any changes you make to `BRAIN.md` or `KERNEL.md` in your workspace (`OPENCLAW_MCP_WORKSPACE_DIR`, default `~/.openclaw/workspace/hedy`) are automatically picked up the next time a session starts (via the `get_session_context` MCP tool or the `pearclaw-session-start.js` hook — installed for either Claude Code or Codex CLI).

Use this to:
- Update `BRAIN.md` with the current sprint focus so the coding agent starts aligned
- Add a constraint to `KERNEL.md` that should apply to all future sessions
- Record a recent architectural decision that the coding agent should know about

No reload or restart needed — context injection is stateless and reads live files each session.

## Setup

See `README.md` for full installation instructions.
