/**
 * Response server — the network half of the "webhook" transport's response
 * channel. OpenClaw has no built-in mechanism to POST a hook-triggered
 * agent turn's result to an arbitrary external URL (that only exists for
 * cron jobs via `--webhook`, a different subsystem — see
 * docs/REMOTE_TRANSPORT_PLAN.md and the async job's decisions log for the
 * full investigation). So instead of polling a local response file
 * (gateway-bridge.js's "gateway-call"/"file" transports), the "webhook"
 * transport asks the responding agent turn to `curl` its decision back to
 * a small HTTP listener started here, authenticated with a one-shot
 * per-request bearer secret.
 *
 * One process-lifetime server, many in-flight requests multiplexed by
 * requestId. Started lazily on first webhook consult/notify/context call.
 */

import { createServer } from "http";
import { randomUUID } from "crypto";

let server = null;
let listenReady = null;
const pending = new Map(); // requestId -> { secret, resolve, reject, timer }

function ensureServer(host) {
  if (server) return listenReady;

  server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const match = req.url.match(/^\/response\/([a-f0-9-]+)$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const requestId = match[1];
    const entry = pending.get(requestId);
    if (!entry) {
      // Unknown, already-resolved, or expired requestId — do not leak which.
      res.writeHead(404).end();
      return;
    }

    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== entry.secret) {
      res.writeHead(401).end();
      return;
    }

    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      pending.delete(requestId); // one-shot delivery
      clearTimeout(entry.timer);
      try {
        entry.resolve(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } catch (e) {
        entry.reject(new Error(`Invalid response body: ${e.message}`));
        res.writeHead(400).end('{"ok":false,"error":"invalid JSON"}');
      }
    });
    req.on("error", () => {
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new Error("Response upload failed"));
    });
  });

  listenReady = new Promise((resolve) => server.listen(0, host, resolve));
  return listenReady;
}

/**
 * Register a pending request and return { requestId, secret, responseUrl,
 * awaitResponse }. `publicBase` is the externally-reachable host/port
 * prefix the responder should POST to (e.g. the Tailscale hostname —
 * this process only knows its bind address, not how others reach it).
 */
export async function registerPendingResponse({ bindHost = "127.0.0.1", publicBase, timeoutMs }) {
  await ensureServer(bindHost);

  const requestId = randomUUID();
  const secret = randomUUID();

  const awaitResponse = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Webhook response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(requestId, { secret, resolve, reject, timer });
  });

  const port = server.address().port;
  const base = publicBase || `http://127.0.0.1:${port}`;
  const responseUrl = `${base.replace(/\/$/, "")}/response/${requestId}`;

  return { requestId, secret, responseUrl, awaitResponse };
}

/** Test/shutdown helper — closes the listener if idle. */
export function closeResponseServer() {
  if (server && pending.size === 0) {
    server.close();
    server = null;
  }
}
