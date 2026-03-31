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
