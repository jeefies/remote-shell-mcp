import { ClientManager } from "../dist/clientManager.js";
import { ConfigStore } from "../dist/config.js";
import { callTool } from "../dist/tools/handlers.js";
import { fileURLToPath } from "node:url";

process.env.REMOTE_SHELL_CONFIG ??= fileURLToPath(new URL("../remote-shell.config.json", import.meta.url));

const store = new ConfigStore();
const manager = new ClientManager(() => store.getConfig());

try {
  const profiles = await callTool(manager, store, "profile_list", {});
  console.log("profile_list", JSON.stringify(profiles, null, 2));

  const workspace = await callTool(manager, store, "workspace_info", {});
  console.log("workspace_info", JSON.stringify(workspace, null, 2));

  const pwd = await callTool(manager, store, "shell", {
    command: "pwd",
    cwd: ".",
    timeoutMs: 10000,
  });
  console.log("shell_pwd", JSON.stringify(pwd, null, 2));

  const list = await callTool(manager, store, "list_dir", {
    path: ".",
  });
  console.log("list_dir_count", Array.isArray(list) ? list.length : null);
  console.log("list_dir_sample", JSON.stringify(Array.isArray(list) ? list.slice(0, 10) : list, null, 2));
} finally {
  await manager.closeAll();
}
