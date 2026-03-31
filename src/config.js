/**
 * Config loader — reads from env vars and ~/.pearclaw.json (if present).
 *
 * Environment variables:
 *   OPENCLAW_GATEWAY_URL      WebSocket URL of your OpenClaw gateway (e.g. ws://localhost:18788)
 *   OPENCLAW_GATEWAY_TOKEN    Auth token (if gateway.auth = "token")
 *   OPENCLAW_MCP_SESSION      Agent session to target (default: "main")
 *   OPENCLAW_MCP_INBOX_DIR    Drop-file inbox dir (fallback if no gateway URL)
 *   OPENCLAW_MCP_TIMEOUT      Response timeout in ms (default: 25000)
 *   OPENCLAW_MCP_FAIL_OPEN    If "true", approve when supervisor unreachable (default: true)
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
  };
}
