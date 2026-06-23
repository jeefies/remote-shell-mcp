#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ClientManager } from "./clientManager.js";
import { ConfigStore } from "./config.js";
import { toSerializableError } from "./errors.js";
import { callTool } from "./tools/handlers.js";
import { toolDefinitions } from "./tools/schemas.js";

const store = new ConfigStore();
const manager = new ClientManager(() => store.getConfig());

const server = new Server(
  {
    name: "remote-shell-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callTool(manager, store, request.params.name, request.params.arguments);
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const payload = error instanceof z.ZodError ? { error: error.message, code: "ERR_INVALID_INPUT" } : toSerializableError(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void manager.closeAll().finally(() => process.exit(0));
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
