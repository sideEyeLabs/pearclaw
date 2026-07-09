/**
 * Integration smoke test — verifies the MCP server starts and responds to tool calls.
 * Run: node test/integration.js
 */

import { spawn } from "child_process";
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function pass(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.error(`${RED}✗${RESET} ${msg}`); process.exit(1); }

// ─── Test: MCP server starts and responds to initialize ──────────────────────
async function testServerStarts() {
  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_FAIL_OPEN: "true",
      OPENCLAW_MCP_TIMEOUT: "2000",
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  const initRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.1" },
    },
  }) + "\n";

  server.stdin.write(initRequest);

  await new Promise((r) => setTimeout(r, 1000));
  server.kill();

  if (stdout.includes('"name":"pearclaw"')) {
    pass("Server starts and responds to initialize");
  } else {
    fail(`Server did not respond correctly. stdout: ${stdout.slice(0, 200)}`);
  }
}

// ─── Test: consult_supervisor returns fail-open on timeout ───────────────────
async function testFailOpen() {
  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_FAIL_OPEN: "true",
      OPENCLAW_MCP_TIMEOUT: "1000", // Short timeout for test
      OPENCLAW_MCP_TRANSPORT: "file",
      OPENCLAW_MCP_INBOX_DIR: join(tmpdir(), "test-inbox-" + Date.now()),
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  // Initialize
  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );

  // Call consult_supervisor — should time out and return approve (fail-open)
  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "tools/call",
      params: {
        name: "consult_supervisor",
        arguments: {
          action: "Write src/test.js",
          context: "Test file",
          risk_level: "low",
        },
      },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 3500));
  server.kill();

  // Should contain approve in the response (fail-open)
  if (stdout.includes("approve") || stdout.includes("unreachable")) {
    pass("consult_supervisor fails open on timeout");
  } else {
    fail(`Expected fail-open response. Got: ${stdout.slice(0, 400)}`);
  }
}

// ─── Test: notify_supervisor returns ok immediately ──────────────────────────
async function testNotify() {
  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_FAIL_OPEN: "true",
      OPENCLAW_MCP_TRANSPORT: "file",
      OPENCLAW_MCP_INBOX_DIR: join(tmpdir(), "test-inbox-notify-" + Date.now()),
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "tools/call",
      params: {
        name: "notify_supervisor",
        arguments: { event: "task_complete", summary: "Done." },
      },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 500));
  server.kill();

  if (stdout.includes('"ok": true') || stdout.includes('"ok":true') || stdout.includes('\\"ok\\": true')) {
    pass("notify_supervisor returns ok immediately");
  } else {
    fail(`Expected ok. Got: ${stdout.slice(0, 400)}`);
  }
}

// ─── Helper: start server, send a consult, answer via response file ──────────
async function runConsultRoundTrip({ responseBody, label, expect }) {
  const inboxDir = join(tmpdir(), `test-inbox-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(inboxDir, { recursive: true });

  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_FAIL_OPEN: "true",
      OPENCLAW_MCP_TIMEOUT: "5000",
      OPENCLAW_MCP_TRANSPORT: "file",
      OPENCLAW_MCP_INBOX_DIR: inboxDir,
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "tools/call",
      params: {
        name: "consult_supervisor",
        arguments: { action: "Edit src/x.js", context: "Round-trip test", risk_level: "medium" },
      },
    }) + "\n"
  );

  // Wait for the request envelope to land in the inbox, then play supervisor
  let responseFile = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !responseFile) {
    const files = readdirSync(inboxDir).filter((f) => f.startsWith("req-"));
    if (files.length) {
      const envelope = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
      responseFile = envelope.responseFile;
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!responseFile) {
    server.kill();
    fail(`${label}: request envelope never appeared in inbox dir`);
    return;
  }
  writeFileSync(responseFile, responseBody);

  await new Promise((r) => setTimeout(r, 1500));
  server.kill();

  if (expect.some((s) => stdout.includes(s))) {
    pass(label);
  } else {
    fail(`${label}: expected one of ${JSON.stringify(expect)}. Got: ${stdout.slice(0, 500)}`);
  }
}

// ─── Test: full consult round-trip via file transport ────────────────────────
async function testConsultRoundTrip() {
  await runConsultRoundTrip({
    label: "consult_supervisor round-trip returns supervisor decision",
    responseBody: JSON.stringify({ decision: "block", reason: "duplicate of lib/x.js", suggestion: "import it" }),
    expect: ["duplicate of lib/x.js"],
  });
}

// ─── Test: malformed supervisor response fails open, not crash ───────────────
async function testMalformedResponseFailsOpen() {
  await runConsultRoundTrip({
    label: "malformed supervisor response fails open with warning",
    responseBody: JSON.stringify({ decision: "yolo", reason: 42 }),
    expect: ["Invalid supervisor response", "unreachable"],
  });
}

// ─── Test: full consult round-trip via webhook transport ─────────────────────
// Stands in for the real gateway's `<hooks.path>/agent` route with a plain
// HTTP server, and stands in for "Hedy" by extracting the responseUrl +
// bearer secret from the injected message and curling a decision back —
// exactly the shell command formatAgentMessage() tells a real agent turn to
// run. This proves the transport plumbing (request auth, message shape,
// response auth, one-shot delivery) without needing a live model.
import { createServer } from "http";

async function testWebhookRoundTrip() {
  let capturedAuth = null;
  const fakeGateway = createServer((req, res) => {
    capturedAuth = req.headers["authorization"];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const match = message.match(/curl -sS -X POST '([^']+)'.*?Bearer ([a-f0-9-]+)/s);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (!match) return;
      const [, responseUrl, secret] = match;
      await fetch(responseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ decision: "modify", reason: "add an idempotency check", suggestion: "see stripe docs" }),
      });
    });
  });
  await new Promise((r) => fakeGateway.listen(0, "127.0.0.1", r));
  const gatewayPort = fakeGateway.address().port;

  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_TRANSPORT: "webhook",
      PEARCLAW_WEBHOOK_URL: `http://127.0.0.1:${gatewayPort}/hooks/agent`,
      PEARCLAW_WEBHOOK_TOKEN: "test-hook-token",
      PEARCLAW_AGENT_ID: "hedy",
      OPENCLAW_MCP_TIMEOUT: "5000",
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );
  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "tools/call",
      params: {
        name: "consult_supervisor",
        arguments: { action: "Write stripe webhook handler", context: "webhook transport test", risk_level: "medium" },
      },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 1500));
  server.kill();
  fakeGateway.close();

  if (capturedAuth !== "Bearer test-hook-token") {
    fail(`webhook transport round-trip: gateway request not authenticated. Got: ${capturedAuth}`);
    return;
  }
  if (stdout.includes("add an idempotency check")) {
    pass("webhook transport: consult_supervisor round-trip via HTTP (mocked gateway)");
  } else {
    fail(`webhook transport round-trip: expected decision text. Got: ${stdout.slice(0, 500)}`);
  }
}

// ─── Test: get_session_context via webhook transport ─────────────────────────
async function testWebhookContext() {
  const fakeGateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const match = message.match(/curl -sS -X POST '([^']+)'.*?Bearer ([a-f0-9-]+)/s);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (!match) return;
      const [, responseUrl, secret] = match;
      await fetch(responseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ context: "--- Hedy Context ---\nfrom remote gateway" }),
      });
    });
  });
  await new Promise((r) => fakeGateway.listen(0, "127.0.0.1", r));
  const gatewayPort = fakeGateway.address().port;

  const server = spawn("node", ["src/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_MCP_TRANSPORT: "webhook",
      PEARCLAW_WEBHOOK_URL: `http://127.0.0.1:${gatewayPort}/hooks/agent`,
      PEARCLAW_WEBHOOK_TOKEN: "test-hook-token",
      PEARCLAW_AGENT_ID: "hedy",
      OPENCLAW_MCP_TIMEOUT: "5000",
    },
  });

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
  );
  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "tools/call",
      params: { name: "get_session_context", arguments: {} },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 1500));
  server.kill();
  fakeGateway.close();

  if (stdout.includes("from remote gateway")) {
    pass("webhook transport: get_session_context round-trip via HTTP (mocked gateway)");
  } else {
    fail(`webhook context round-trip: expected remote context text. Got: ${stdout.slice(0, 500)}`);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log("Running integration tests...\n");
await testServerStarts();
await testFailOpen();
await testNotify();
await testConsultRoundTrip();
await testMalformedResponseFailsOpen();
await testWebhookRoundTrip();
await testWebhookContext();
console.log("\nAll tests passed.");
