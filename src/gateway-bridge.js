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

// Push inbox — Hedy writes here, CC polls it
const PUSH_INBOX = join(tmpdir(), "pearclaw-push.json");

export function createGatewayBridge(config) {
  return {
    consult: (payload) => sendAndWait("consult", payload, config),
    notify: (payload) => sendAndWait("notify", payload, config),
    poll: (_payload) => readPushInbox(),
  };
}

// ─── Push inbox: Hedy writes, CC reads ───────────────────────────────────────
function readPushInbox() {
  if (!existsSync(PUSH_INBOX)) {
    return { message: null };
  }
  try {
    const raw = readFileSync(PUSH_INBOX, "utf8").trim();
    if (!raw) return { message: null };
    const data = JSON.parse(raw);
    // Consume it — one-shot delivery
    unlinkSync(PUSH_INBOX);
    return { message: data.message || null };
  } catch {
    return { message: null };
  }
}

async function sendAndWait(type, payload, config) {
  const requestId = randomUUID();
  const requestFile = join(tmpdir(), `pearclaw-req-${requestId}.json`);
  const responseFile = join(tmpdir(), `pearclaw-res-${requestId}.json`);

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

// ─── Transport: openclaw gateway call (cron.add one-shot) ─────────────────────
async function deliverViaGatewayCall(envelope, config) {
  const message = formatAgentMessage(envelope);

  // Inject via cron.add with deleteAfterRun — fires in ~3s, self-cleans
  const runAt = new Date(Date.now() + 3000).toISOString();
  const params = JSON.stringify({
    name: `pearclaw-req-${envelope.requestId.slice(0, 8)}`,
    sessionTarget: config.sessionTarget || "main",
    payload: {
      kind: "systemEvent",
      text: message,
    },
    schedule: { kind: "at", at: runAt },
    deleteAfterRun: true,
  });

  const args = ["gateway", "call", "cron.add", "--json", "--params", params];
  if (config.gatewayToken) {
    args.push("--token", config.gatewayToken);
  }
  if (config.gatewayUrl) {
    args.push("--url", config.gatewayUrl);
  }

  const result = spawnSync("openclaw", args, {
    stdio: "pipe",
    timeout: 8000,
  });

  if (result.status !== 0) {
    throw new Error(`Gateway delivery failed: ${result.stderr?.toString()}`);
  }
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
