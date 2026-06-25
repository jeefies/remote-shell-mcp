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
  shell: string;
  initCommand?: string;
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
  outputMode: "json";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface CompactShellResult {
  command: string;
  cwd: string;
  outputMode: "compact";
  exitCode: number | null;
  signal: string | null;
  stdout: CompactText;
  stderr: CompactText;
  durationMs: number;
}

export interface CompactText {
  lineCount: number;
  head: string[];
  tail: string[];
  truncated: boolean;
}

export type ShellOutputMode = "json" | "terminal" | "compact";
export type ShellToolResult = ShellResult | CompactShellResult | string;
export type SessionMode = "context" | "interactive";

export interface SessionInfo {
  id: string;
  profile: string;
  mode: SessionMode;
  cwd: string;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastExitCode: number | null;
}

export interface GitChangedFile {
  path: string;
  originalPath?: string;
  status: string;
  staged: string;
  unstaged: string;
}

export interface GitSummary {
  cwd: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  counts: Record<string, number>;
  clean: boolean;
}

export interface GitDiffStat {
  cwd: string;
  base?: string;
  stat: string;
  nameStatus: string[];
}

export interface ReviewChangesResult {
  status: GitSummary;
  diffStat: GitDiffStat;
  untrackedCount: number;
  changedCount: number;
  largeChangeHints: string[];
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
  createSession(args?: { cwd?: string; env?: Record<string, string>; mode?: SessionMode }): Promise<SessionInfo>;
  getSession(id: string): SessionInfo;
  setSessionCwd(id: string, cwd: string): SessionInfo;
  closeSession(id: string): { closed: string };
  gitStatus(args: { cwd?: string; sessionId?: string }): Promise<GitSummary>;
  gitDiffStat(args: { cwd?: string; sessionId?: string; base?: string }): Promise<GitDiffStat>;
  gitChangedFiles(args: { cwd?: string; sessionId?: string }): Promise<GitChangedFile[]>;
  reviewChanges(args: { cwd?: string; sessionId?: string; base?: string }): Promise<ReviewChangesResult>;
  search(args: {
    pattern: string;
    path?: string;
    glob?: string;
    maxResults?: number;
  }): Promise<SearchMatch[]>;
  shell(args: {
    command: string;
    cwd?: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    outputMode?: ShellOutputMode;
  }): Promise<ShellToolResult>;
}
