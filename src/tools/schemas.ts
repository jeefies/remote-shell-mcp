import { z } from "zod";
import { profilePatchSchema, profileSchema } from "../config.js";

export const profileField = {
  type: "string",
  description: "Optional remote profile name. Defaults to config.defaultProfile.",
};

export const profileNameSchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/);

export const profileListSchema = z.object({});

export const profileGetSchema = z.object({
  name: profileNameSchema,
});

export const profileCreateSchema = z.object({
  name: profileNameSchema,
  profile: profileSchema,
  makeDefault: z.boolean().default(false),
});

export const profileUpdateSchema = z.object({
  name: profileNameSchema,
  patch: profilePatchSchema,
});

export const profileDeleteSchema = z.object({
  name: profileNameSchema,
  newDefaultProfile: profileNameSchema.optional(),
});

export const profileSetDefaultSchema = z.object({
  name: profileNameSchema,
});

export const workspaceInfoSchema = z.object({
  profile: z.string().optional(),
});

export const sessionCreateSchema = z.object({
  profile: z.string().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  mode: z.enum(["context", "interactive"]).default("context"),
});

export const sessionInfoSchema = z.object({
  profile: z.string().optional(),
  sessionId: z.string().min(1),
});

export const sessionSetCwdSchema = z.object({
  profile: z.string().optional(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
});

export const sessionCloseSchema = z.object({
  profile: z.string().optional(),
  sessionId: z.string().min(1),
});

export const listDirSchema = z.object({
  profile: z.string().optional(),
  path: z.string().min(1).default("."),
});

export const readFileSchema = z.object({
  profile: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
});

export const writeFileSchema = z.object({
  profile: z.string().optional(),
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().optional(),
});

export const editFileSchema = z.object({
  profile: z.string().optional(),
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  expectedHash: z.string().optional(),
});

export const applyPatchSchema = z.object({
  profile: z.string().optional(),
  patch: z.string().min(1),
  expectedHashes: z.record(z.string()).optional(),
});

export const searchSchema = z.object({
  profile: z.string().optional(),
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  maxResults: z.number().int().positive().max(500).optional(),
});

export const shellSchema = z.object({
  profile: z.string().optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
  outputMode: z.enum(["json", "terminal", "compact"]).default("json"),
});

export const gitToolSchema = z.object({
  profile: z.string().optional(),
  cwd: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

export const gitDiffStatSchema = gitToolSchema.extend({
  base: z.string().min(1).optional(),
});

export const toolDefinitions = [
  {
    name: "profile_list",
    description: "List configured SSH profiles. Secret fields are redacted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "profile_get",
    description: "Get one configured SSH profile by name. Secret fields are redacted.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Profile name.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profile_create",
    description: "Create a new SSH profile in the config file. Fails if the profile already exists.",
    inputSchema: {
      type: "object",
      required: ["name", "profile"],
      properties: {
        name: {
          type: "string",
          description: "Profile name. Use letters, numbers, dots, underscores, or dashes.",
        },
        profile: {
          type: "object",
          required: ["host", "username", "defaultRoot", "roots"],
          properties: remoteProfileProperties(),
          additionalProperties: false,
        },
        makeDefault: {
          type: "boolean",
          description: "Set this profile as the default profile after creation.",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profile_update",
    description: "Update an existing SSH profile in the config file. Fails if the profile does not exist.",
    inputSchema: {
      type: "object",
      required: ["name", "patch"],
      properties: {
        name: {
          type: "string",
          description: "Profile name.",
        },
        patch: {
          type: "object",
          properties: remoteProfileProperties(),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profile_delete",
    description: "Delete an SSH profile from the config file. Deleting the default profile requires newDefaultProfile.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Profile name to delete.",
        },
        newDefaultProfile: {
          type: "string",
          description: "Replacement default profile when deleting the current default profile.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profile_set_default",
    description: "Set an existing SSH profile as the default profile.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Profile name.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workspace_info",
    description: "Show the selected remote profile, allowed roots, limits, and common command availability.",
    inputSchema: {
      type: "object",
      properties: {
        profile: profileField,
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_create",
    description: "Create a shell session. Use mode=interactive to keep one remote shell process alive across commands.",
    inputSchema: {
      type: "object",
      properties: {
        profile: profileField,
        cwd: {
          type: "string",
          description: "Initial remote cwd. Defaults to profile.defaultRoot.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables to apply to commands run through this session.",
        },
        mode: {
          type: "string",
          enum: ["context", "interactive"],
          description: "context stores cwd/env only; interactive opens a persistent remote shell instance.",
          default: "context",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_info",
    description: "Return a shell session's current cwd, env, and last exit code.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        profile: profileField,
        sessionId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_set_cwd",
    description: "Update a shell session's cwd under the configured allowed roots.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "cwd"],
      properties: {
        profile: profileField,
        sessionId: { type: "string" },
        cwd: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_close",
    description: "Close a shell session context.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        profile: profileField,
        sessionId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List a remote directory under the configured allowed roots.",
    inputSchema: {
      type: "object",
      properties: {
        profile: profileField,
        path: {
          type: "string",
          description: "Remote path. Relative paths resolve under defaultRoot.",
          default: ".",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a remote UTF-8 text file with byte limits and a content hash.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        profile: profileField,
        path: {
          type: "string",
          description: "Remote file path. Relative paths resolve under defaultRoot.",
        },
        maxBytes: {
          type: "number",
          description: "Optional read limit. Defaults to the profile maxReadBytes.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or replace a remote UTF-8 file. Use expectedHash to guard overwrites.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        profile: profileField,
        path: {
          type: "string",
          description: "Remote file path. Relative paths resolve under defaultRoot.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 file content to write.",
        },
        expectedHash: {
          type: "string",
          description: "Optional SHA-256 hash of the current remote file. Mismatches reject the write.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Apply one exact unique oldText -> newText replacement to a remote UTF-8 file.",
    inputSchema: {
      type: "object",
      required: ["path", "oldText", "newText"],
      properties: {
        profile: profileField,
        path: {
          type: "string",
          description: "Remote file path. Relative paths resolve under defaultRoot.",
        },
        oldText: {
          type: "string",
          description: "Exact text to replace. It must match exactly once.",
        },
        newText: {
          type: "string",
          description: "Replacement text.",
        },
        expectedHash: {
          type: "string",
          description: "Optional SHA-256 hash of the current remote file. Mismatches reject the edit.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description: "Apply a Codex-style patch to remote files under the configured allowed roots.",
    inputSchema: {
      type: "object",
      required: ["patch"],
      properties: {
        profile: profileField,
        patch: {
          type: "string",
          description: "Patch text starting with *** Begin Patch and ending with *** End Patch.",
        },
        expectedHashes: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
          description: "Optional SHA-256 hashes keyed by patch path or resolved remote path.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search remote files with ripgrep under the configured allowed roots.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        profile: profileField,
        pattern: {
          type: "string",
          description: "Ripgrep search pattern.",
        },
        path: {
          type: "string",
          description: "Remote path to search. Defaults to defaultRoot.",
        },
        glob: {
          type: "string",
          description: "Optional ripgrep glob, for example '*.ts'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum matches to return, capped at 500.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shell",
    description: "Run a remote shell command with cwd/session restriction, timeout, output limits, and optional compact/terminal output.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        profile: profileField,
        command: {
          type: "string",
          description: "Command to run through the profile shell. Interactive sessions reuse one shell instance.",
        },
        cwd: {
          type: "string",
          description: "Remote working directory. Defaults to profile.defaultRoot and must stay under allowed roots.",
        },
        sessionId: {
          type: "string",
          description: "Optional session id created by session_create. Uses the session cwd/env unless overridden.",
        },
        timeoutMs: {
          type: "number",
          description: "Command timeout in milliseconds.",
        },
        env: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
          description: "Optional environment variables for this command.",
        },
        outputMode: {
          type: "string",
          enum: ["json", "terminal", "compact"],
          description: "json returns structured stdout/stderr; terminal returns plain terminal-like text; compact returns head/tail summaries.",
          default: "json",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Return a parsed git status summary for a remote working tree.",
    inputSchema: gitInputSchema(),
  },
  {
    name: "git_diff_stat",
    description: "Return git diff --stat and name-status output for a remote working tree.",
    inputSchema: gitInputSchema({
      base: {
        type: "string",
        description: "Optional diff base argument.",
      },
    }),
  },
  {
    name: "git_changed_files",
    description: "Return parsed changed files from git status.",
    inputSchema: gitInputSchema(),
  },
  {
    name: "review_changes",
    description: "Return a compact review summary combining git status, diff stat, and change counts.",
    inputSchema: gitInputSchema({
      base: {
        type: "string",
        description: "Optional diff base argument.",
      },
    }),
  },
];

function gitInputSchema(extraProperties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      profile: profileField,
      cwd: {
        type: "string",
        description: "Remote working directory. Defaults to profile.defaultRoot or session cwd.",
      },
      sessionId: {
        type: "string",
        description: "Optional session id created by session_create.",
      },
      ...extraProperties,
    },
    additionalProperties: false,
  };
}

function remoteProfileProperties(): Record<string, unknown> {
  return {
    host: {
      type: "string",
      description: "SSH host or IP address.",
    },
    port: {
      type: "number",
      description: "SSH port.",
      default: 22,
    },
    username: {
      type: "string",
      description: "SSH username.",
    },
    password: {
      type: "string",
      description: "Optional SSH password. Prefer key or agent authentication.",
    },
    privateKeyPath: {
      type: "string",
      description: "Optional local private key path.",
    },
    tryDefaultPrivateKeys: {
      type: "boolean",
      description: "Try common local private key paths when privateKeyPath is not set.",
      default: false,
    },
    passphrase: {
      type: "string",
      description: "Optional private key passphrase.",
    },
    agent: {
      type: "string",
      description: "Optional ssh-agent socket path, or 'pageant' on Windows.",
    },
    agentForward: {
      type: "boolean",
      description: "Enable SSH agent forwarding.",
      default: false,
    },
    shell: {
      type: "string",
      description: "Remote shell executable used for shell commands, for example sh or bash.",
      default: "sh",
    },
    initCommand: {
      type: "string",
      description: "Optional shell initialization command run before one-shot commands and once when creating an interactive session.",
    },
    defaultRoot: {
      type: "string",
      description: "Default remote workspace root. Must be absolute and not '/'.",
    },
    roots: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Allowed absolute remote roots.",
    },
    defaultTimeoutMs: {
      type: "number",
      description: "Default shell timeout in milliseconds.",
      default: 30000,
    },
    maxOutputBytes: {
      type: "number",
      description: "Maximum stdout/stderr bytes returned by shell.",
      default: 65536,
    },
    maxReadBytes: {
      type: "number",
      description: "Maximum file bytes returned by read_file.",
      default: 262144,
    },
    fileCache: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable in-memory small-file caching for read_file.",
          default: true,
        },
        maxFileBytes: {
          type: "number",
          description: "Only cache files at or below this byte size.",
          default: 65536,
        },
        ttlMs: {
          type: "number",
          description: "Maximum cache age in milliseconds. Set 0 to expire immediately.",
          default: 5000,
        },
        maxEntries: {
          type: "number",
          description: "Maximum cached files per SSH profile.",
          default: 256,
        },
      },
      additionalProperties: false,
      description: "Optional in-memory small-file cache settings.",
    },
  };
}
