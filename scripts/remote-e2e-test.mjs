import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ClientManager } from "../dist/clientManager.js";
import { ConfigStore } from "../dist/config.js";
import { callTool } from "../dist/tools/handlers.js";

process.env.REMOTE_SHELL_CONFIG ??= fileURLToPath(new URL("../remote-shell.config.json", import.meta.url));

const store = new ConfigStore();
const manager = new ClientManager(() => store.getConfig());
const profile = "test-root";
const fileName = `mcp-e2e-${Date.now()}.txt`;
const patchFileName = `mcp-e2e-patch-${Date.now()}.txt`;
let createdTestFile = false;
let createdPatchFile = false;

try {
  const profiles = await callTool(manager, store, "profile_list", {});
  const testProfile = profiles.profiles.find((entry) => entry.name === profile);
  assert.ok(testProfile, `Missing test profile: ${profile}`);
  assert.equal(testProfile.defaultRoot, "/root/remote-shell-mcp-test");

  const workspace = await callTool(manager, store, "workspace_info", { profile });
  assert.equal(workspace.defaultRoot, "/root/remote-shell-mcp-test");

  const pwd = await callTool(manager, store, "shell", {
    profile,
    command: "pwd",
    cwd: ".",
    timeoutMs: 10000,
  });
  assert.equal(pwd.exitCode, 0);
  assert.equal(pwd.stdout.trim(), "/root/remote-shell-mcp-test");

  const initialList = await callTool(manager, store, "list_dir", {
    profile,
    path: ".",
  });
  assert.ok(Array.isArray(initialList));

  const created = await callTool(manager, store, "write_file", {
    profile,
    path: fileName,
    content: "alpha\nbeta\n",
  });
  createdTestFile = true;
  assert.equal(created.created, true);
  assert.equal(created.path, `/root/remote-shell-mcp-test/${fileName}`);

  const read = await callTool(manager, store, "read_file", {
    profile,
    path: fileName,
  });
  assert.equal(read.content, "alpha\nbeta\n");
  assert.equal(read.hash, created.hash);

  const cachedRead = await callTool(manager, store, "read_file", {
    profile,
    path: fileName,
  });
  assert.equal(cachedRead.hash, read.hash);

  await assertToolError("ERR_HASH_MISMATCH", () =>
    callTool(manager, store, "write_file", {
      profile,
      path: fileName,
      content: "should not write\n",
      expectedHash: "not-the-real-hash",
    }),
  );

  const edited = await callTool(manager, store, "edit_file", {
    profile,
    path: fileName,
    oldText: "beta",
    newText: "gamma",
    expectedHash: read.hash,
  });
  assert.notEqual(edited.hash, read.hash);

  const afterEdit = await callTool(manager, store, "read_file", {
    profile,
    path: fileName,
  });
  assert.equal(afterEdit.content, "alpha\ngamma\n");
  assert.equal(afterEdit.hash, edited.hash);

  const shellMutation = await callTool(manager, store, "shell", {
    profile,
    command: `printf 'shell-updated\\n' > ${fileName}`,
    cwd: ".",
    timeoutMs: 10000,
  });
  assert.equal(shellMutation.exitCode, 0);

  const afterShellMutation = await callTool(manager, store, "read_file", {
    profile,
    path: fileName,
  });
  assert.equal(afterShellMutation.content, "shell-updated\n");

  await assertToolError("ERR_PATH_OUTSIDE_ROOT", () =>
    callTool(manager, store, "read_file", {
      profile,
      path: "/etc/passwd",
    }),
  );

  const addPatch = `*** Begin Patch
*** Add File: ${patchFileName}
+one
+two
*** End Patch`;
  const addResult = await callTool(manager, store, "apply_patch", {
    profile,
    patch: addPatch,
  });
  createdPatchFile = true;
  assert.equal(addResult.filesChanged, 1);
  assert.equal(addResult.results[0].type, "add");

  const patchRead = await callTool(manager, store, "read_file", {
    profile,
    path: patchFileName,
  });
  assert.equal(patchRead.content, "one\ntwo\n");

  const updatePatch = `*** Begin Patch
*** Update File: ${patchFileName}
@@
 one
-two
+three
*** End Patch`;
  const updateResult = await callTool(manager, store, "apply_patch", {
    profile,
    patch: updatePatch,
    expectedHashes: {
      [patchFileName]: patchRead.hash,
    },
  });
  assert.equal(updateResult.results[0].type, "update");
  assert.equal(updateResult.results[0].hunksApplied, 1);

  const patchAfterUpdate = await callTool(manager, store, "read_file", {
    profile,
    path: patchFileName,
  });
  assert.equal(patchAfterUpdate.content, "one\nthree\n");

  await assertToolError("ERR_PATH_OUTSIDE_ROOT", () =>
    callTool(manager, store, "apply_patch", {
      profile,
      patch: `*** Begin Patch
*** Add File: /etc/remote-shell-mcp-denied
+denied
*** End Patch`,
    }),
  );

  const deletePatch = `*** Begin Patch
*** Delete File: ${patchFileName}
*** End Patch`;
  const deleteResult = await callTool(manager, store, "apply_patch", {
    profile,
    patch: deletePatch,
    expectedHashes: {
      [patchFileName]: patchAfterUpdate.hash,
    },
  });
  createdPatchFile = false;
  assert.equal(deleteResult.results[0].type, "delete");

  console.log(
    JSON.stringify(
      {
        ok: true,
        profile,
        root: workspace.defaultRoot,
        testFile: `/root/remote-shell-mcp-test/${fileName}`,
        patchFile: `/root/remote-shell-mcp-test/${patchFileName}`,
        initialListCount: initialList.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (createdTestFile) {
    try {
      await callTool(manager, store, "shell", {
        profile,
        command: `rm -f -- ${fileName}`,
        cwd: ".",
        timeoutMs: 10000,
      });
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            cleanupWarning: true,
            fileName,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  }
  if (createdPatchFile) {
    try {
      await callTool(manager, store, "shell", {
        profile,
        command: `rm -f -- ${patchFileName}`,
        cwd: ".",
        timeoutMs: 10000,
      });
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            cleanupWarning: true,
            fileName: patchFileName,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  }
  await manager.closeAll();
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
