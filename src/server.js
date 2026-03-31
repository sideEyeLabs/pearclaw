#!/usr/bin/env node
/**
 * openclaw-mcp — MCP server that bridges Claude Code to your OpenClaw agent.
 *
 * Your OpenClaw agent gets real-time visibility into every Claude Code action,
 * can inject guidance mid-session, and can block tool calls before they run.
 *
 * Usage:
 *   npx openclaw-mcp
 *
 * Or add to ~/.claude/settings.json mcpServers block (see README).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createGatewayBridge } from "./gateway-bridge.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const bridge = createGatewayBridge(config);

const server = new Server(
  { name: "openclaw-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool: consult_supervisor ────────────────────────────────────────────────
// Called by Claude Code before significant actions. Returns approve/block/modify.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "consult_supervisor",
      description:
        "Consult your OpenClaw supervisor agent before proceeding. " +
        "Use this before writing files, running commands, or making architectural decisions. " +
        "Returns: { decision: 'approve'|'block'|'modify', reason: string, suggestion?: string }",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "What you are about to do. Be specific: include file paths, command text, or the decision you're making.",
          },
          context: {
            type: "string",
            description:
              "Why you want to do this. What problem does it solve? What's the broader task?",
          },
          files_affected: {
            type: "array",
            items: { type: "string" },
            description: "File paths that will be created, modified, or deleted.",
          },
          risk_level: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Your assessment of risk. high = destructive/irreversible/security-sensitive.",
          },
        },
        required: ["action", "context"],
      },
    },
    {
      name: "notify_supervisor",
      description:
        "Send a one-way update to your OpenClaw supervisor. " +
        "Use after completing a task, encountering an error, or finishing a session. " +
        "Does not wait for a response.",
      inputSchema: {
        type: "object",
        properties: {
          event: {
            type: "string",
            enum: ["task_complete", "task_failed", "session_end", "info"],
            description: "The type of event.",
          },
          summary: {
            type: "string",
            description: "What happened. Be concise.",
          },
          details: {
            type: "object",
            description: "Optional structured metadata (files changed, PR URL, errors, etc.).",
          },
        },
        required: ["event", "summary"],
      },
    },
  ],
}));

// ─── Handler ─────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "consult_supervisor") {
    try {
      const result = await bridge.consult({
        action: args.action,
        context: args.context,
        files_affected: args.files_affected || [],
        risk_level: args.risk_level || "medium",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      // Fail open: if supervisor unreachable, log and approve with warning
      const fallback = {
        decision: "approve",
        reason: `Supervisor unreachable (${err.message}). Proceeding with caution.`,
        warning: "No supervisor review was performed.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(fallback, null, 2) }],
      };
    }
  }

  if (name === "notify_supervisor") {
    try {
      await bridge.notify({
        event: args.event,
        summary: args.summary,
        details: args.details || {},
      });
      return {
        content: [{ type: "text", text: '{"ok": true}' }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `{"ok": false, "error": "${err.message}"}` }],
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
