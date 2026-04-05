# SECURITY — PearClaw

## Threat model
- leaking internal infra details to Claude Code
- unsafe fail-open behavior on risky actions
- malformed supervisor responses
- hook-triggered escalation bypass / inconsistency

## Baseline controls
- sanitize errors
- document timeout behavior explicitly
- test failure paths
- keep supervision protocol narrow and auditable

## Status
Initial draft. Existing quality review findings still need to be closed.
