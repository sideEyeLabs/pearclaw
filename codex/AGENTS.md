# Supervisor Protocol

You have an OpenClaw AI supervisor connected via MCP (`pearclaw` MCP server).

## When to consult

**Always consult before:**
- Writing, editing, or deleting any file outside the current working directory
- Running shell commands that modify state (installs, migrations, deployments, git push)
- Making architectural decisions (new files, changing data models, switching approaches)
- Any action with `risk_level: high` (destructive, irreversible, security-sensitive)

**Consult is optional for:**
- Reading files, running tests, linting, local-only operations
- Actions you've already been approved for in this session

## Decision protocol

| Response | Action |
|----------|--------|
| `approve` | Proceed as planned |
| `block` | Stop. Explain to the user why. Do not find workarounds. |
| `modify` | Read the `suggestion` field. Apply it before proceeding. |

## On `block`

Tell the user exactly what the supervisor said. Do not retry with a different approach to bypass the block. If you believe the block is wrong, tell the user and let them decide.

## Notify on completion

When you finish a task, call `notify_supervisor` with `event: "task_complete"` and a brief summary of what you did (files changed, PR created, etc.).

If you encounter an unrecoverable error, call `notify_supervisor` with `event: "task_failed"`.

## Efficiency

Don't consult for every file read or minor operation — that creates noise. Batch related actions into a single consult when possible: "I'm going to create X, Y, Z files and run migration A."

---

## Session Start Protocol

At the start of every new session, call `get_session_context` before doing anything else:

```
get_session_context({})
```

This returns Hedy's live operational state — current priorities, recent decisions, active projects, and constraints. It prevents you from working against stale assumptions or repeating decisions that were already made.

**If `get_session_context` returns context:** Acknowledge it briefly (one sentence) before starting work. For example: "Got context — WeGoDive is the active priority, DiveOps on hold."

**If it returns an error or empty:** Proceed normally. Missing context is non-fatal.

The `SessionStart` hook (`pearclaw-session-start.js`) also fires automatically when installed — it injects context before your first message. The explicit `get_session_context` call is a belt-and-suspenders fallback for when the hook isn't active.

---

## Codex-specific notes

This file is Codex's equivalent of `claude/CLAUDE.md` — same protocol, since the underlying `pearclaw` MCP server and tool contracts (`consult_supervisor`, `get_supervisor_message`, `get_session_context`, `notify_supervisor`) are identical across harnesses. Only the install location and hook plumbing differ (`~/.codex/config.toml`, `~/.codex/hooks.json` — see the repo `README.md`).

One real difference: Codex's own docs describe its `PreToolUse` hook as "a guardrail rather than a complete enforcement boundary" — it doesn't yet intercept every shell/tool path the way this protocol assumes for automatic escalation. Treat the hook as best-effort defense in depth, not a substitute for actually calling `consult_supervisor` yourself per the rules above.
