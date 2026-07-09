/**
 * Gateway Bridge — the single transport implementation for delivering
 * PearClaw requests into the OpenClaw agent's session and waiting for a
 * structured response. Both the MCP server (src/server.js) and the
 * PreToolUse hook (hooks/pearclaw-supervisor-hook.js) use this module —
 * do not reimplement delivery/polling elsewhere.
 *
 * Delivery transports:
 *   "gateway-call" — `openclaw gateway call wake` (default when a gateway
 *                    URL is configured). The `wake` RPC is OpenClaw's
 *                    immediate wake-text-injection primitive:
 *                    params { mode: "now"|"next-heartbeat", text,
 *                             sessionKey?, agentId? }
 *                    (verified against openclaw docs/gateway/protocol.md
 *                    and the gateway's WakeParamsSchema / cron wake handler).
 *                    Consults use mode "now" (immediate heartbeat);
 *                    notifies use mode "next-heartbeat" (non-interruptive).
 *   "file"         — drop the request envelope into OPENCLAW_MCP_INBOX_DIR
 *                    for the agent to poll (no gateway needed).
 *   "webhook"      — for a gateway on a different host (see
 *                    docs/REMOTE_TRANSPORT_PLAN.md). POSTs to the gateway's
 *                    real `hooks.enabled` HTTP route (`<hooks.path>/agent`),
 *                    targeting an isolated agent turn under a configured
 *                    `agentId` rather than the shared main session. No
 *                    `openclaw` CLI or shared filesystem needed on this host.
 *
 * Response channel:
 *   "gateway-call"/"file" — the agent writes JSON to the `responseFile`
 *     path included in the request; we poll for it. Requires the MCP
 *     server/hook and the agent to share a filesystem — same-host only.
 *   "webhook" — OpenClaw has no built-in mechanism to POST a hook-triggered
 *     agent turn's result to an arbitrary external URL (that only exists
 *     for cron jobs via `--webhook`, a different subsystem — confirmed
 *     against the installed OpenClaw docs, see the async job's decisions
 *     log for the investigation). So the responding agent turn is instructed to
 *     `curl` its decision back to a `responseUrl` embedded in the request,
 *     authenticated with a one-shot per-request bearer secret, received by
 *     response-server.js's local HTTP listener. Works cross-host over
 *     Tailscale when `PEARCLAW_RESPONSE_URL` points at this host's
 *     Tailscale address.
 *
 * Every consult round-trip is appended to ~/.pearclaw/audit.jsonl
 * (request + decision), since response files are deleted after reading.
 */

import { spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  appendFileSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { registerPendingResponse } from "./response-server.js";

const POLL_INTERVAL_MS = 250;
const VALID_DECISIONS = ["approve", "block", "modify"];
const AUDIT_LOG = join(homedir(), ".pearclaw", "audit.jsonl");

// Push inbox — Hedy writes here, the coding agent polls it
const PUSH_INBOX = join(tmpdir(), "pearclaw-push.json");

export function createGatewayBridge(config) {
  return {
    consult: (payload) => sendAndWait("consult", payload, config),
    notify: (payload) => sendAndWait("notify", payload, config),
    poll: (_payload) => readPushInbox(),
    // Only meaningful for the webhook transport — gateway-call/file transports
    // read context.js's local files directly (same-host by construction).
    getRemoteContext:
      config.transport === "webhook"
        ? (projectHint) => sendAndWaitWebhook("context", { projectHint }, config)
        : null,
  };
}

// ─── Push inbox: Hedy writes, coding agent reads ─────────────────────────────
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
  if (config.transport === "webhook") {
    return sendAndWaitWebhook(type, payload, config);
  }

  const requestId = randomUUID();
  const responseFile = join(tmpdir(), `pearclaw-res-${requestId}.json`);

  const envelope = {
    requestId,
    type,
    payload,
    responseFile,
    ts: Date.now(),
  };

  // Deliver via configured transport
  if (config.transport === "gateway-call") {
    deliverViaGatewayCall(envelope, config);
  } else {
    deliverViaDropFile(envelope, config);
  }

  if (type === "notify") {
    // Fire-and-forget — don't wait
    audit({ ...envelope, decision: null });
    return { ok: true };
  }

  // Poll for the agent's structured response
  const result = await pollForResponse(responseFile, config.timeoutMs || 25000);
  audit({ ...envelope, decision: result });
  return result;
}

// ─── Transport: webhook (cross-host, see file header) ────────────────────────
async function sendAndWaitWebhook(type, payload, config) {
  if (!config.webhookUrl) {
    throw new Error(
      "webhook transport selected but PEARCLAW_WEBHOOK_URL is not set."
    );
  }

  const timeoutMs = config.timeoutMs || 25000;
  const requestId = randomUUID();

  // notify is fire-and-forget: no response channel needed.
  if (type === "notify") {
    const envelope = { requestId, type, payload, ts: Date.now() };
    await postToHooksAgent(formatAgentMessage(envelope), config, timeoutMs);
    audit({ ...envelope, decision: null });
    return { ok: true };
  }

  const { secret, responseUrl, awaitResponse } = await registerPendingResponse({
    bindHost: config.responseBindHost,
    publicBase: config.responsePublicUrl,
    timeoutMs,
  });

  const envelope = { requestId, type, payload, responseUrl, responseSecret: secret, ts: Date.now() };

  await postToHooksAgent(formatAgentMessage(envelope), config, timeoutMs);

  const raw = await awaitResponse;
  const result = type === "context" ? validateContextResponse(raw) : validateResponse(raw);
  audit({ ...envelope, responseSecret: undefined, decision: type === "context" ? null : result });
  return result;
}

// Context responses are a plain string blob, not a decision — same schema
// discipline (untrusted input, require the one field we actually use).
function validateContextResponse(data) {
  if (!data || typeof data !== "object" || typeof data.context !== "string") {
    throw new Error("context response must be a JSON object with a string `context` field");
  }
  return data.context;
}

function postToHooksAgent(message, config, timeoutMs) {
  const body = JSON.stringify({
    message,
    ...(config.agentId ? { agentId: config.agentId } : {}),
    deliver: false,
    timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
  });

  return httpPostJson(config.webhookUrl, body, config.webhookToken);
}

async function httpPostJson(url, body, bearerToken) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webhook delivery failed: HTTP ${res.status} ${text}`);
  }
  return text;
}

// ─── Transport: openclaw gateway call wake ───────────────────────────────────
function deliverViaGatewayCall(envelope, config) {
  const message = formatAgentMessage(envelope);

  const wakeParams = {
    // Consults need an immediate heartbeat; notifies can ride the next one.
    mode: envelope.type === "consult" ? "now" : "next-heartbeat",
    text: message,
  };
  // Omitting sessionKey targets the main session (gateway default).
  // A non-"main" sessionTarget is passed through as an explicit session key.
  if (config.sessionTarget && config.sessionTarget !== "main") {
    wakeParams.sessionKey = config.sessionTarget;
  }

  const args = ["gateway", "call", "wake", "--json", "--params", JSON.stringify(wakeParams)];
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

  if (result.error || result.status !== 0) {
    throw new Error(
      `Gateway delivery failed: ${result.error?.message || result.stderr?.toString() || `exit ${result.status}`}`
    );
  }
}

// ─── Transport: drop file (agent polls OPENCLAW_MCP_INBOX_DIR) ───────────────
function deliverViaDropFile(envelope, config) {
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
          resolve(validateResponse(data));
        } catch (e) {
          try { unlinkSync(responseFile); } catch {}
          reject(new Error(`Invalid supervisor response: ${e.message}`));
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

// ─── Response schema validation ───────────────────────────────────────────────
// The supervisor writes the response file by hand (LLM + shell), so treat it
// as untrusted input: require a known decision and string fields.
function validateResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("response is not a JSON object");
  }
  if (!VALID_DECISIONS.includes(data.decision)) {
    throw new Error(
      `decision must be one of ${VALID_DECISIONS.join("/")} (got ${JSON.stringify(data.decision)})`
    );
  }
  return {
    decision: data.decision,
    reason: typeof data.reason === "string" ? data.reason : "",
    ...(typeof data.suggestion === "string" ? { suggestion: data.suggestion } : {}),
  };
}

// ─── Audit trail ──────────────────────────────────────────────────────────────
// Response files are deleted after reading; keep an append-only record so
// consults/decisions are reviewable after the fact. Best-effort — never throws.
function audit(entry) {
  try {
    mkdirSync(join(homedir(), ".pearclaw"), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  } catch {
    // non-fatal
  }
}

// ─── Format the message that lands in the agent's session ────────────────────
function formatAgentMessage(envelope) {
  const { type, payload } = envelope;

  if (type === "context") {
    return (
      `A coding agent session is starting${payload.projectHint ? ` (project hint: ${payload.projectHint})` : ""} ` +
      `and needs your session-start context. Read the first 60 lines of KERNEL.md, the first 50 ` +
      `lines of BRAIN.md, and the last 30 lines of today's memory file from your workspace, format ` +
      `them the same way \`get_session_context\` does locally (labelled sections, ~2500 char cap, ` +
      `skip missing files), then run this exact shell command with that text as the JSON \`context\` value:\n\n` +
      "```bash\n" +
      `curl -sS -X POST '${envelope.responseUrl}' \\\n` +
      `  -H 'Authorization: Bearer ${envelope.responseSecret}' \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -d '{"context":"..."}'\n` +
      "```\n" +
      `(single-use URL, expires shortly — if no context files exist, curl back ` +
      `{"context":"(no context files found)"} rather than leaving the caller to time out.)`
    );
  }

  if (type === "notify") {
    return (
      `🤖 Coding agent update [${payload.event}]: ${payload.summary}` +
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

  const responseInstruction = envelope.responseUrl
    ? `Respond by running exactly this shell command (via your exec/Bash tool):\n` +
      "```bash\n" +
      `curl -sS -X POST '${envelope.responseUrl}' \\\n` +
      `  -H 'Authorization: Bearer ${envelope.responseSecret}' \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -d '{"decision":"approve","reason":"..."}'\n` +
      "```\n" +
      `(use \`"decision":"block"\` or \`"decision":"modify"\` with a \`"suggestion"\` field as needed — ` +
      `see skill/SKILL.md for the full decision guide. This URL is single-use and expires shortly.)`
    : `Respond with JSON to \`${envelope.responseFile}\`:\n` +
      `\`{"decision":"approve","reason":"..."}\` or \`{"decision":"block","reason":"...","suggestion":"..."}\``;

  return (
    `${riskEmoji} **Coding agent review request** (${payload.risk_level} risk)\n\n` +
    `**Action:** ${payload.action}${filesLine}\n` +
    `**Context:** ${payload.context}\n\n` +
    responseInstruction
  );
}
