import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = fileURLToPath(new URL("../remote-shell.config.json", import.meta.url));
const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const client = new Client({
  name: "remote-shell-mcp-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: projectRoot,
  env: {
    ...process.env,
    REMOTE_SHELL_CONFIG: configPath,
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  for (const expected of [
    "apply_patch",
    "edit_file",
    "list_dir",
    "profile_create",
    "profile_delete",
    "profile_get",
    "profile_list",
    "profile_set_default",
    "profile_update",
    "read_file",
    "search",
    "shell",
    "workspace_info",
    "write_file",
  ]) {
    assert.ok(names.includes(expected), `Missing MCP tool: ${expected}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        toolCount: tools.length,
        tools: names,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
