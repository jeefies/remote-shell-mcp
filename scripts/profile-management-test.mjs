import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientManager } from "../dist/clientManager.js";
import { ConfigStore } from "../dist/config.js";
import { callTool } from "../dist/tools/handlers.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-shell-mcp-"));
const configPath = path.join(tempDir, "config.json");

fs.writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      defaultProfile: "base",
      profiles: {
        base: {
          host: "127.0.0.1",
          port: 22,
          username: "root",
          agent: "pageant",
          defaultRoot: "/root",
          roots: ["/root"],
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.env.REMOTE_SHELL_CONFIG = configPath;

const store = new ConfigStore();
const manager = new ClientManager(() => store.getConfig());

try {
  const initial = await callTool(manager, store, "profile_list", {});
  assert.equal(initial.defaultProfile, "base");
  assert.equal(initial.profiles.length, 1);

  const created = await callTool(manager, store, "profile_create", {
    name: "second",
    profile: {
      host: "example.com",
      username: "deploy",
      agent: "pageant",
      defaultRoot: "/srv/app",
      roots: ["/srv/app"],
    },
  });
  assert.equal(created.name, "second");
  assert.equal(created.port, 22);

  await assertToolError("ERR_PROFILE_EXISTS", () =>
    callTool(manager, store, "profile_create", {
      name: "second",
      profile: {
        host: "example.com",
        username: "deploy",
        defaultRoot: "/srv/app",
        roots: ["/srv/app"],
      },
    }),
  );

  const updated = await callTool(manager, store, "profile_update", {
    name: "second",
    patch: {
      port: 2222,
      defaultTimeoutMs: 12000,
    },
  });
  assert.equal(updated.port, 2222);
  assert.equal(updated.defaultTimeoutMs, 12000);

  await assertToolError("ERR_PROFILE_NOT_FOUND", () =>
    callTool(manager, store, "profile_update", {
      name: "missing",
      patch: {
        port: 2222,
      },
    }),
  );

  const defaultResult = await callTool(manager, store, "profile_set_default", { name: "second" });
  assert.equal(defaultResult.defaultProfile, "second");

  await assertToolError("ERR_DEFAULT_PROFILE_DELETE", () =>
    callTool(manager, store, "profile_delete", {
      name: "second",
    }),
  );

  const deleted = await callTool(manager, store, "profile_delete", {
    name: "second",
    newDefaultProfile: "base",
  });
  assert.equal(deleted.deleted, "second");
  assert.equal(deleted.defaultProfile, "base");

  await assertToolError("ERR_PROFILE_LAST_DELETE", () =>
    callTool(manager, store, "profile_delete", {
      name: "base",
    }),
  );

  await manager.closeAll();
  console.log("profile management tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function assertToolError(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.code, code);
    return;
  }

  assert.fail(`Expected tool error: ${code}`);
}
