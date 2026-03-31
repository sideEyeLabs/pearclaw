/**
 * Gateway Bridge — sends requests to OpenClaw gateway and waits for agent response.
 *
 * OpenClaw gateway uses WebSocket RPC. We POST a systemEvent which triggers
 * the agent's session, then poll the response file.
 *
 * Two transport modes:
 *   "webhook"  — HTTP POST to gateway /hooks endpoint (recommended, fast)
 *   "file"     — write to a temp file, agent polls it (fallback, no gateway needed)
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const POLL_INTERVAL_MS = 250;

export function createGatewayBridge(config) {
  return {
    consult: (payload) => sendAndWait("consult", payload, config),
    notify: (payload) => sendAndWait("notify", payload, config),
  };
}

async function sendAndWait(type, payload, config) {
  const requestId = randomUUID();
  const requestFile = join(tmpdir(), `openclaw-mcp-req-${requestId}.json`);
  const responseFile = join(tmpdir(), `openclaw-mcp-res-${requestId}.json`);

  const envelope = {
    requestId,
    type,
    payload,
    responseFile,
    ts: Date.now(),
  };

  // Write request to temp file
  writeFileSync(requestFile, JSON.stringify(envelope, null, 2));

  // Deliver via configured transport
  if (config.transport === "gateway-call") {
    await deliverViaGatewayCall(envelope, config);
  } else {
    await deliverViaDropFile(envelope, requestFile, config);
  }

  if (type === "notify") {
    // Fire-and-forget — don't wait
    return { ok: true };
  }

  // Poll for response
  const result = await pollForResponse(responseFile, config.timeoutMs || 25000);

  // Cleanup
  try { unlinkSync(requestFile); } catch {}

  return result;
}

// ─── Transport: openclaw gateway call ────────────────────────────────────────
async function deliverViaGatewayCall(envelope, config) {
  const message = formatAgentMessage(envelope);
  const params = JSON.stringify({
    kind: "systemEvent",
    sessionTarget: config.sessionTarget || "main",
    payload: {
      kind: "mcpSupervisorRequest",
      message,
      requestId: envelope.requestId,
      responseFile: envelope.responseFile,
    },
  });

  const args = ["gateway", "call", "system-presence", "--params", params];
  if (config.gatewayToken) {
    args.push("--token", config.gatewayToken);
  }
  if (config.gatewayUrl) {
    args.push("--url", config.gatewayUrl);
  }

  spawnSync("openclaw", args, {
    stdio: "pipe",
    timeout: 5000,
  });
}

// ─── Transport: drop file (agent polls OPENCLAW_MCP_INBOX_DIR) ───────────────
async function deliverViaDropFile(envelope, requestFile, config) {
  const inboxDir = config.inboxDir;
  if (!inboxDir) {
    throw new Error(
      "No transport configured. Set OPENCLAW_GATEWAY_URL or OPENCLAW_MCP_INBOX_DIR."
    );
  }

  mkdirSync(inboxDir, { recursive: true });
  const dest = join(inboxDir, `req-${envelope.requestId}.json`);
  writeFileSync(dest, JSON.stringify(envelope, null, 2));
}

// ─── Poll for response ────────────────────────────────────────────────────────
function pollForResponse(responseFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      if (existsSync(responseFile)) {
        try {
          const raw = readFileSync(responseFile, "utf8");
          const data = JSON.parse(raw);
          try { unlinkSync(responseFile); } catch {}
          resolve(data);
        } catch (e) {
          reject(new Error(`Invalid response JSON: ${e.message}`));
        }
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error(`Supervisor timed out after ${timeoutMs}ms`));
        return;
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

// ─── Format the message that lands in the agent's session ────────────────────
function formatAgentMessage(envelope) {
  const { type, payload } = envelope;

  if (type === "notify") {
    return (
      `🤖 Claude Code update [${payload.event}]: ${payload.summary}` +
      (payload.details && Object.keys(payload.details).length
        ? `\n\`\`\`json\n${JSON.stringify(payload.details, null, 2)}\n\`\`\``
        : "")
    );
  }

  // consult
  const riskEmoji = { low: "🟢", medium: "🟡", high: "🔴" }[payload.risk_level] || "🟡";
  const filesLine =
    payload.files_affected?.length
      ? `\nFiles: ${payload.files_affected.join(", ")}`
      : "";

  return (
    `${riskEmoji} **Claude Code review request** (${payload.risk_level} risk)\n\n` +
    `**Action:** ${payload.action}${filesLine}\n` +
    `**Context:** ${payload.context}\n\n` +
    `Respond with JSON to \`${envelope.responseFile}\`:\n` +
    `\`{"decision":"approve","reason":"..."}\` or \`{"decision":"block","reason":"...","suggestion":"..."}\``
  );
}
