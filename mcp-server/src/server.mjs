#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { tool as cancelTool } from "./tools/cancel.mjs";
import { tool as promptTool } from "./tools/prompt.mjs";
import { tool as resultTool } from "./tools/result.mjs";
import { tool as reviewTool } from "./tools/review.mjs";
import { runSetup, tool as setupTool } from "./tools/setup.mjs";
import { tool as statusTool } from "./tools/status.mjs";
import { tool as taskTool } from "./tools/task.mjs";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

async function main() {
  if (process.argv.slice(2).includes("--self-test")) {
    try {
      const result = await runSetup({ cwd: process.cwd() });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ready ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ready: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const server = new McpServer({ name: "grok-build", version: String(packageJson.version) });
  for (const tool of [setupTool, promptTool, reviewTool, taskTool, statusTool, resultTool, cancelTool]) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: z.object({ result: z.unknown() }),
      annotations: tool.annotations
    }, tool.handler);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`grok-build MCP server failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
