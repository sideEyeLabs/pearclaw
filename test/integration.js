/**
 * Integration smoke test — verifies the MCP server starts and responds to tool calls.
 * Run: node test/integration.js
 */

import { spawn } from "child_process";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
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

  if (stdout.includes('"name":"openclaw-mcp"')) {
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

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log("Running integration tests...\n");
await testServerStarts();
await testFailOpen();
await testNotify();
console.log("\nAll tests passed.");
