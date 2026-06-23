import type { ClientManager } from "../clientManager.js";
import type { ConfigStore } from "../config.js";
import {
  applyPatchSchema,
  editFileSchema,
  gitDiffStatSchema,
  gitToolSchema,
  listDirSchema,
  profileCreateSchema,
  profileDeleteSchema,
  profileGetSchema,
  profileListSchema,
  profileSetDefaultSchema,
  profileUpdateSchema,
  readFileSchema,
  searchSchema,
  sessionCloseSchema,
  sessionCreateSchema,
  sessionInfoSchema,
  sessionSetCwdSchema,
  shellSchema,
  workspaceInfoSchema,
  writeFileSchema,
} from "./schemas.js";

type ToolArgs = Record<string, unknown> | undefined;

export async function callTool(manager: ClientManager, store: ConfigStore, name: string, rawArgs: ToolArgs): Promise<unknown> {
  const args = rawArgs ?? {};

  switch (name) {
    case "profile_list": {
      profileListSchema.parse(args);
      return store.listProfiles();
    }
    case "profile_get": {
      const parsed = profileGetSchema.parse(args);
      return store.getProfile(parsed.name);
    }
    case "profile_create": {
      const parsed = profileCreateSchema.parse(args);
      return store.createProfile(parsed.name, parsed.profile, parsed.makeDefault);
    }
    case "profile_update": {
      const parsed = profileUpdateSchema.parse(args);
      const result = store.updateProfile(parsed.name, parsed.patch);
      await manager.invalidate(parsed.name);
      return result;
    }
    case "profile_delete": {
      const parsed = profileDeleteSchema.parse(args);
      const result = store.deleteProfile(parsed.name, parsed.newDefaultProfile);
      await manager.invalidate(parsed.name);
      return result;
    }
    case "profile_set_default": {
      const parsed = profileSetDefaultSchema.parse(args);
      return store.setDefaultProfile(parsed.name);
    }
    case "workspace_info": {
      const parsed = workspaceInfoSchema.parse(args);
      return manager.get(parsed.profile).workspaceInfo();
    }
    case "session_create": {
      const parsed = sessionCreateSchema.parse(args);
      return manager.get(parsed.profile).createSession({
        cwd: parsed.cwd,
        env: parsed.env,
      });
    }
    case "session_info": {
      const parsed = sessionInfoSchema.parse(args);
      return manager.get(parsed.profile).getSession(parsed.sessionId);
    }
    case "session_set_cwd": {
      const parsed = sessionSetCwdSchema.parse(args);
      return manager.get(parsed.profile).setSessionCwd(parsed.sessionId, parsed.cwd);
    }
    case "session_close": {
      const parsed = sessionCloseSchema.parse(args);
      return manager.get(parsed.profile).closeSession(parsed.sessionId);
    }
    case "list_dir": {
      const parsed = listDirSchema.parse(args);
      return manager.get(parsed.profile).listDir(parsed.path);
    }
    case "read_file": {
      const parsed = readFileSchema.parse(args);
      return manager.get(parsed.profile).readFile(parsed.path, parsed.maxBytes);
    }
    case "write_file": {
      const parsed = writeFileSchema.parse(args);
      return manager.get(parsed.profile).writeFile(parsed.path, parsed.content, parsed.expectedHash);
    }
    case "edit_file": {
      const parsed = editFileSchema.parse(args);
      return manager
        .get(parsed.profile)
        .editFile(parsed.path, parsed.oldText, parsed.newText, parsed.expectedHash);
    }
    case "apply_patch": {
      const parsed = applyPatchSchema.parse(args);
      return manager.get(parsed.profile).applyPatch(parsed.patch, parsed.expectedHashes);
    }
    case "search": {
      const parsed = searchSchema.parse(args);
      return manager.get(parsed.profile).search(parsed);
    }
    case "shell": {
      const parsed = shellSchema.parse(args);
      return manager.get(parsed.profile).shell(parsed);
    }
    case "git_status": {
      const parsed = gitToolSchema.parse(args);
      return manager.get(parsed.profile).gitStatus(parsed);
    }
    case "git_diff_stat": {
      const parsed = gitDiffStatSchema.parse(args);
      return manager.get(parsed.profile).gitDiffStat(parsed);
    }
    case "git_changed_files": {
      const parsed = gitToolSchema.parse(args);
      return manager.get(parsed.profile).gitChangedFiles(parsed);
    }
    case "review_changes": {
      const parsed = gitDiffStatSchema.parse(args);
      return manager.get(parsed.profile).reviewChanges(parsed);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
