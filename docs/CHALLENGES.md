# CHALLENGES — PearClaw

## Hard parts
- low-friction install
- trustworthy safety behavior
- balancing supervision value vs interruption cost
- making the setup legible to non-insiders
- remote-gateway support: **implemented 2026-07-09** (`fix/transport-architecture`) as a third `"webhook"` transport — POSTs to OpenClaw's real `hooks.enabled` HTTP route (`<hooks.path>/agent`) instead of assuming a nonexistent flow-lifecycle API (an earlier version of this plan invented `create_flow`/`resolve_flow`/etc.; corrected after checking the actual installed OpenClaw docs). Response side has no built-in outbound-webhook mechanism for hook-triggered turns, so the responding agent turn `curl`s its decision back to a one-shot authenticated URL instead of writing a shared file. Protocol is tested end-to-end against a mocked gateway (`test/integration.js`); a live cross-host round trip against a real gateway is not yet demonstrated — see `docs/REMOTE_TRANSPORT_PLAN.md`'s verification-status section for exactly what's blocking that and why it wasn't forced.
- structured response tooling: Hedy answers by hand-writing a JSON file from a chat message; a dedicated respond tool/skill with schema enforcement would be more reliable (bridge-side validation added 2026-07-09 catches malformed output but can't prevent it)
