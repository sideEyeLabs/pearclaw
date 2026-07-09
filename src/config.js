/**
 * Config loader — reads from env vars and ~/.pearclaw.json (if present).
 *
 * Environment variables:
 *   OPENCLAW_GATEWAY_URL      WebSocket URL of your OpenClaw gateway (e.g. ws://localhost:18788)
 *   OPENCLAW_GATEWAY_TOKEN    Auth token (if gateway.auth = "token")
 *   OPENCLAW_MCP_SESSION      Agent session to target (default: "main"; any
 *                             other value is passed to the gateway as an
 *                             explicit wake sessionKey)
 *   OPENCLAW_MCP_TRANSPORT    "gateway-call" (openclaw gateway call wake),
 *                             "file" (drop-file inbox), or "webhook" (HTTP,
 *                             for a gateway on a different host — see
 *                             docs/REMOTE_TRANSPORT_PLAN.md). Default: gateway-call
 *   OPENCLAW_MCP_INBOX_DIR    Drop-file inbox dir (fallback if no gateway URL)
 *   OPENCLAW_MCP_TIMEOUT      Response timeout in ms (default: 25000)
 *   OPENCLAW_MCP_FAIL_OPEN    If "true", approve when supervisor unreachable (default: true)
 *
 * "webhook" transport (cross-host, requires no `openclaw` CLI on this
 * machine — only these env vars and network access to the gateway's
 * Tailscale address):
 *   PEARCLAW_WEBHOOK_URL      Full URL of the gateway's hooks agent route,
 *                             e.g. http://100.x.y.z:18789/pearclaw-hooks/agent
 *   PEARCLAW_WEBHOOK_TOKEN    Bearer token for hooks.token (SecretRef-backed
 *                             on the gateway side — never inline in shared config)
 *   PEARCLAW_AGENT_ID         agentId to target for the isolated review turn
 *                             (must be in the gateway's hooks.allowedAgentIds)
 *   PEARCLAW_RESPONSE_BIND    Local bind host for the response listener
 *                             (default: 127.0.0.1)
 *   PEARCLAW_RESPONSE_URL     Externally-reachable base URL the gateway-side
 *                             agent turn should curl back to, e.g.
 *                             http://<this-machine-tailscale-ip>:<port>
 *                             (falls back to the ephemeral loopback URL,
 *                             which only works when gateway and this
 *                             process share a host — set this for real
 *                             cross-host use)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function loadConfig() {
  // File-based config (optional override)
  const configFile = join(homedir(), ".pearclaw.json");
  let fileConfig = {};
  if (existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {}
  }

  const gatewayUrl =
    process.env.OPENCLAW_GATEWAY_URL ||
    fileConfig.gatewayUrl ||
    "ws://127.0.0.1:18788";

  const inboxDir =
    process.env.OPENCLAW_MCP_INBOX_DIR ||
    fileConfig.inboxDir ||
    join(homedir(), ".openclaw", "mcp-inbox");

  // Determine transport: prefer gateway-call if URL looks local
  const transport =
    process.env.OPENCLAW_MCP_TRANSPORT ||
    fileConfig.transport ||
    (gatewayUrl ? "gateway-call" : "file");

  return {
    transport,
    gatewayUrl,
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || fileConfig.gatewayToken,
    sessionTarget: process.env.OPENCLAW_MCP_SESSION || fileConfig.sessionTarget || "main",
    inboxDir,
    timeoutMs: parseInt(process.env.OPENCLAW_MCP_TIMEOUT || fileConfig.timeoutMs || "25000", 10),
    failOpen: (process.env.OPENCLAW_MCP_FAIL_OPEN || fileConfig.failOpen || "true") !== "false",

    // webhook transport
    webhookUrl: process.env.PEARCLAW_WEBHOOK_URL || fileConfig.webhookUrl,
    webhookToken: process.env.PEARCLAW_WEBHOOK_TOKEN || fileConfig.webhookToken,
    agentId: process.env.PEARCLAW_AGENT_ID || fileConfig.agentId,
    responseBindHost:
      process.env.PEARCLAW_RESPONSE_BIND || fileConfig.responseBindHost || "127.0.0.1",
    responsePublicUrl: process.env.PEARCLAW_RESPONSE_URL || fileConfig.responsePublicUrl,
  };
}
