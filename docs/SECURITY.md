# SECURITY — PearClaw

## Threat model
- leaking internal infra details to Claude Code
- unsafe fail-open behavior on risky actions
- malformed supervisor responses — **mitigated 2026-07-09**: bridge validates the response schema (decision enum + string fields) and treats anything else as unreachable
- hook-triggered escalation bypass / inconsistency — **partially mitigated 2026-07-09**: hook now shares the bridge transport (no divergent RPC path); still open: supervision is voluntary for tool calls the hook's regex risk classifier rates "low", and everything fails open
- response-file spoofing/race: any local process that can guess the `/tmp/pearclaw-res-<uuid>.json` path can forge a decision — uuid makes this hard but tmp is world-readable; still open

## Baseline controls
- sanitize errors
- document timeout behavior explicitly
- test failure paths (integration test covers timeout fail-open and malformed-response fail-open)
- keep supervision protocol narrow and auditable — consult round-trips now append to `~/.pearclaw/audit.jsonl` (responses were previously deleted with no record)

## Status
Transport bugs closed on `fix/transport-architecture` (2026-07-09). Fail-open defaults, the regex-based risk classifier, and the tmp-file response channel remain the main open risks.
