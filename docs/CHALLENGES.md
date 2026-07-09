# CHALLENGES — PearClaw

## Hard parts
- low-friction install
- trustworthy safety behavior
- balancing supervision value vs interruption cost
- making the setup legible to non-insiders
- remote-gateway support: request delivery works over `OPENCLAW_GATEWAY_URL`, but the response channel is a shared temp file, so supervisor and coding agent must share a filesystem today. The likely fix is the OpenClaw Webhooks plugin (authenticated HTTP routes bound to a sessionKey) as a network response channel — not built yet
- structured response tooling: Hedy answers by hand-writing a JSON file from a chat message; a dedicated respond tool/skill with schema enforcement would be more reliable (bridge-side validation added 2026-07-09 catches malformed output but can't prevent it)
