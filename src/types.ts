export type RemoteProfileName = string;

export interface RemoteProfileConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  tryDefaultPrivateKeys: boolean;
  passphrase?: string;
  agent?: string;
  agentForward: boolean;
  defaultRoot: string;
  roots: string[];
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  fileCache: FileCacheConfig;
}

export interface FileCacheConfig {
  enabled: boolean;
  maxFileBytes: number;
  ttlMs: number;
  maxEntries: number;
}

export interface AppConfig {
  defaultProfile: RemoteProfileName;
  profiles: Record<RemoteProfileName, RemoteProfileConfig>;
}

export interface ResolvedRemotePath {
  input: string;
  root: string;
  path: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: number;
}

export interface ShellResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  hash: string;
  size: number;
  truncated: boolean;
}

export interface WriteFileResult {
  path: string;
  hash: string;
  previousHash: string | null;
  created: boolean;
}

export interface EditFileResult {
  path: string;
  hash: string;
  previousHash: string;
  replacements: number;
  diff: string;
}

export interface ApplyPatchFileResult {
  type: "add" | "update" | "delete";
  path: string;
  previousHash: string | null;
  hash: string | null;
  hunksApplied?: number;
}

export interface ApplyPatchResult {
  filesChanged: number;
  results: ApplyPatchFileResult[];
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number | null;
  text: string;
}

export interface RemoteClient {
  profileName: string;
  profile: RemoteProfileConfig;
  connect(): Promise<void>;
  close(): Promise<void>;
  workspaceInfo(): Promise<Record<string, unknown>>;
  listDir(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string, maxBytes?: number): Promise<FileReadResult>;
  writeFile(path: string, content: string, expectedHash?: string): Promise<WriteFileResult>;
  editFile(path: string, oldText: string, newText: string, expectedHash?: string): Promise<EditFileResult>;
  applyPatch(patch: string, expectedHashes?: Record<string, string>): Promise<ApplyPatchResult>;
  search(args: {
    pattern: string;
    path?: string;
    glob?: string;
    maxResults?: number;
  }): Promise<SearchMatch[]>;
  shell(args: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<ShellResult>;
}
