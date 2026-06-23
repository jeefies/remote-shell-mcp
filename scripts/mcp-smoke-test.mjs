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
    "git_changed_files",
    "git_diff_stat",
    "git_status",
    "list_dir",
    "profile_create",
    "profile_delete",
    "profile_get",
    "profile_list",
    "profile_set_default",
    "profile_update",
    "read_file",
    "search",
    "session_close",
    "session_create",
    "session_info",
    "session_set_cwd",
    "shell",
    "workspace_info",
    "write_file",
  ]) {
    assert.ok(names.includes(expected), `Missing MCP tool: ${expected}`);
  }

  const profileList = await client.callTool({
    name: "profile_list",
    arguments: {},
  });
  const profileListText = profileList.content.find((item) => item.type === "text")?.text ?? "";
  const profiles = JSON.parse(profileListText);
  assert.ok(Array.isArray(profiles.profiles));

  const sessionCreate = await client.callTool({
    name: "session_create",
    arguments: {
      profile: "test-root",
      cwd: ".",
    },
  });
  const sessionText = sessionCreate.content.find((item) => item.type === "text")?.text ?? "";
  const session = JSON.parse(sessionText);
  assert.equal(session.cwd, "/root/remote-shell-mcp-test");

  const sessionInfo = await client.callTool({
    name: "session_info",
    arguments: {
      profile: "test-root",
      sessionId: session.id,
    },
  });
  const sessionInfoText = sessionInfo.content.find((item) => item.type === "text")?.text ?? "";
  assert.equal(JSON.parse(sessionInfoText).id, session.id);

  await client.callTool({
    name: "session_close",
    arguments: {
      profile: "test-root",
      sessionId: session.id,
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        toolCount: tools.length,
        tools: names,
        profileCount: profiles.profiles.length,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
