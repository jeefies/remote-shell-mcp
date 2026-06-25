import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type AnyAuthMethod, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { RemoteShellError } from "../errors.js";
import type {
  ApplyPatchResult,
  CompactShellResult,
  DirectoryEntry,
  EditFileResult,
  FileReadResult,
  GitChangedFile,
  GitDiffStat,
  GitSummary,
  RemoteClient,
  RemoteProfileConfig,
  ReviewChangesResult,
  SearchMatch,
  ShellResult,
  ShellToolResult,
  SessionMode,
  SessionInfo,
  WriteFileResult,
} from "../types.js";
import { sha256 } from "../util/hash.js";
import { appendLimited } from "../util/limits.js";
import { applyPatchHunks, parseCodexPatch } from "../util/patch.js";
import { resolveRemotePath, shellQuote } from "../util/posixPath.js";

interface RemoteFileEntry {
  filename: string;
  attrs: {
    size: number;
    mtime: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
}

interface CachedFile {
  buffer: Buffer;
  hash: string;
  cachedAt: number;
}

interface SessionState {
  id: string;
  mode: SessionMode;
  cwd: string;
  env: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  lastExitCode: number | null;
  interactive?: InteractiveSessionState;
}

interface InteractiveSessionState {
  stream: ClientChannel;
  queue: Promise<void>;
  closed: boolean;
}

export class SshRemoteClient implements RemoteClient {
  private readonly conn = new Client();
  private connectPromise: Promise<void> | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private readonly fileCache = new Map<string, CachedFile>();
  private readonly sessions = new Map<string, SessionState>();
  private connected = false;

  constructor(
    readonly profileName: string,
    readonly profile: RemoteProfileConfig,
  ) {
    this.conn.on("error", (error) => {
      this.connected = false;
      this.sftpPromise = null;
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = new Promise((resolve, reject) => {
        const config: ConnectConfig = {
          host: this.profile.host,
          port: this.profile.port,
          username: this.profile.username,
          agentForward: this.profile.agentForward,
          authHandler: this.buildAuthMethods(),
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        };
        const privateKeyPaths = this.resolvePrivateKeyPaths();

        this.conn
          .once("ready", () => {
            this.connected = true;
            resolve();
          })
          .once("error", (error) => {
            this.connectPromise = null;
            reject(
              new RemoteShellError(`SSH connection failed: ${error.message}`, "ERR_SSH_CONNECT", {
                host: this.profile.host,
                port: this.profile.port,
                hasAgent: Boolean(this.profile.agent),
                hasPassword: Boolean(this.profile.password),
                privateKeyPathsTried: privateKeyPaths,
              }),
            );
          })
          .connect(config);
      });
    }

    await this.connectPromise;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.sftpPromise = null;
    for (const session of this.sessions.values()) {
      this.closeInteractiveSession(session);
    }
    this.sessions.clear();
    this.conn.end();
  }

  async workspaceInfo(): Promise<Record<string, unknown>> {
    const commandNames = ["git", "rg", "node", "npm", "pnpm", "python3", "python", "pip3", "pip"];
    const probes = await Promise.all(
      commandNames.map(async (command) => {
        const result = await this.shell({
          command: `p=$(command -v ${command} 2>/dev/null) && printf '%s\\n' "$p" && ${command} --version 2>&1 | head -n 1`,
          cwd: this.profile.defaultRoot,
          timeoutMs: 5_000,
        }) as ShellResult;
        const lines = result.stdout.split(/\r?\n/).filter(Boolean);
        return [command, {
          available: result.exitCode === 0 && lines.length > 0,
          path: lines[0] ?? null,
          version: lines[1] ?? null,
        }] as const;
      }),
    );
    const shell = await this.shell({
      command: "printf '%s\\n' \"$SHELL\"; uname -srm 2>/dev/null || true",
      cwd: this.profile.defaultRoot,
      timeoutMs: 5_000,
    }) as ShellResult;
    const shellLines = shell.stdout.split(/\r?\n/).filter(Boolean);

    return {
      profile: this.profileName,
      host: this.profile.host,
      username: this.profile.username,
      defaultRoot: this.profile.defaultRoot,
      roots: this.profile.roots,
      capabilities: Object.fromEntries(probes),
      environment: {
        shell: shellLines[0] || "sh",
        configuredShell: this.profile.shell,
        hasInitCommand: Boolean(this.profile.initCommand),
        system: shellLines[1] || null,
        preferredPython: (Object.fromEntries(probes).python3 as { available: boolean }).available ? "python3" : "python",
      },
      limits: {
        defaultTimeoutMs: this.profile.defaultTimeoutMs,
        maxOutputBytes: this.profile.maxOutputBytes,
        maxReadBytes: this.profile.maxReadBytes,
        fileCache: this.profile.fileCache,
      },
    };
  }

  async listDir(inputPath: string): Promise<DirectoryEntry[]> {
    const resolved = resolveRemotePath(this.profile, inputPath);
    const sftp = await this.getSftp();
    const entries = await new Promise<RemoteFileEntry[]>((resolve, reject) => {
      sftp.readdir(resolved.path, (error, list) => {
        if (error) {
          reject(new RemoteShellError(`Failed to list directory: ${error.message}`, "ERR_LIST_DIR", { path: resolved.path }));
          return;
        }
        resolve(list as RemoteFileEntry[]);
      });
    });

    return entries.map((entry) => {
      const type = entry.attrs.isDirectory()
        ? "directory"
        : entry.attrs.isFile()
          ? "file"
          : entry.attrs.isSymbolicLink()
            ? "symlink"
            : "other";
      const childPath = `${resolved.path.replace(/\/+$/, "")}/${entry.filename}`;

      return {
        name: entry.filename,
        path: childPath,
        type,
        size: entry.attrs.size,
        mtime: entry.attrs.mtime,
      };
    });
  }

  async readFile(inputPath: string, maxBytes = this.profile.maxReadBytes): Promise<FileReadResult> {
    const resolved = resolveRemotePath(this.profile, inputPath);
    const cached = this.getCachedFile(resolved.path);
    if (cached) {
      return this.toFileReadResult(resolved.path, cached.buffer, maxBytes, cached.hash);
    }

    const sftp = await this.getSftp();
    const buffer = await this.readRequired(sftp, resolved.path);
    const hash = sha256(buffer);
    this.setCachedFile(resolved.path, buffer, hash);
    return this.toFileReadResult(resolved.path, buffer, maxBytes, hash);
  }

  async writeFile(inputPath: string, content: string, expectedHash?: string): Promise<WriteFileResult> {
    const resolved = resolveRemotePath(this.profile, inputPath);
    const sftp = await this.getSftp();
    const existing = await this.readIfExists(sftp, resolved.path);
    const previousHash = existing ? sha256(existing) : null;

    if (expectedHash && previousHash !== expectedHash) {
      throw new RemoteShellError("File hash does not match expectedHash", "ERR_HASH_MISMATCH", {
        path: resolved.path,
        expectedHash,
        actualHash: previousHash,
      });
    }

    const next = Buffer.from(content, "utf8");
    await this.writeBuffer(sftp, resolved.path, next);
    const hash = sha256(next);
    this.setCachedFile(resolved.path, next, hash);

    return {
      path: resolved.path,
      hash,
      previousHash,
      created: previousHash === null,
    };
  }

  async editFile(inputPath: string, oldText: string, newText: string, expectedHash?: string): Promise<EditFileResult> {
    if (!oldText) {
      throw new RemoteShellError("oldText must be non-empty", "ERR_INVALID_EDIT");
    }

    const resolved = resolveRemotePath(this.profile, inputPath);
    const sftp = await this.getSftp();
    const existing = await this.readRequired(sftp, resolved.path);
    const previousHash = sha256(existing);

    if (expectedHash && previousHash !== expectedHash) {
      throw new RemoteShellError("File hash does not match expectedHash", "ERR_HASH_MISMATCH", {
        path: resolved.path,
        expectedHash,
        actualHash: previousHash,
      });
    }

    const current = existing.toString("utf8");
    const first = current.indexOf(oldText);
    if (first === -1) {
      throw new RemoteShellError("oldText was not found", "ERR_EDIT_NO_MATCH", { path: resolved.path });
    }
    if (current.indexOf(oldText, first + oldText.length) !== -1) {
      throw new RemoteShellError("oldText matched more than once", "ERR_EDIT_NOT_UNIQUE", { path: resolved.path });
    }

    const nextContent = current.slice(0, first) + newText + current.slice(first + oldText.length);
    const next = Buffer.from(nextContent, "utf8");
    await this.writeBuffer(sftp, resolved.path, next);
    const hash = sha256(next);
    this.setCachedFile(resolved.path, next, hash);

    return {
      path: resolved.path,
      hash,
      previousHash,
      replacements: 1,
      diff: makeSmallDiff(oldText, newText),
    };
  }

  async applyPatch(patch: string, expectedHashes: Record<string, string> = {}): Promise<ApplyPatchResult> {
    const operations = parseCodexPatch(patch);
    const sftp = await this.getSftp();
    const results: ApplyPatchResult["results"] = [];

    for (const operation of operations) {
      const resolved = resolveRemotePath(this.profile, operation.path);
      const expectedHash = expectedHashes[operation.path] ?? expectedHashes[resolved.path];

      if (operation.type === "add") {
        const existing = await this.readIfExists(sftp, resolved.path);
        if (existing) {
          throw new RemoteShellError("Patch add target already exists", "ERR_PATCH_FILE_EXISTS", {
            path: resolved.path,
          });
        }

        if (expectedHash) {
          throw new RemoteShellError("expectedHashes cannot be used for new files", "ERR_PATCH_HASH_FOR_NEW_FILE", {
            path: resolved.path,
          });
        }

        const next = Buffer.from(operation.content, "utf8");
        await this.writeBuffer(sftp, resolved.path, next);
        const hash = sha256(next);
        this.setCachedFile(resolved.path, next, hash);
        results.push({
          type: "add",
          path: resolved.path,
          previousHash: null,
          hash,
        });
        continue;
      }

      if (operation.type === "delete") {
        const existing = await this.readRequired(sftp, resolved.path);
        const previousHash = sha256(existing);
        assertExpectedHash(resolved.path, previousHash, expectedHash);
        await this.unlinkFile(sftp, resolved.path);
        this.invalidateCachedFile(resolved.path);
        results.push({
          type: "delete",
          path: resolved.path,
          previousHash,
          hash: null,
        });
        continue;
      }

      const existing = await this.readRequired(sftp, resolved.path);
      const previousHash = sha256(existing);
      assertExpectedHash(resolved.path, previousHash, expectedHash);
      const applied = applyPatchHunks(existing.toString("utf8"), operation.hunks, resolved.path);
      const next = Buffer.from(applied.content, "utf8");
      await this.writeBuffer(sftp, resolved.path, next);
      const hash = sha256(next);
      this.setCachedFile(resolved.path, next, hash);
      results.push({
        type: "update",
        path: resolved.path,
        previousHash,
        hash,
        hunksApplied: applied.appliedHunks.length,
      });
    }

    return {
      filesChanged: results.length,
      results,
    };
  }

  async createSession(args: { cwd?: string; env?: Record<string, string>; mode?: SessionMode } = {}): Promise<SessionInfo> {
    const cwd = resolveRemotePath(this.profile, args.cwd ?? this.profile.defaultRoot).path;
    const env = args.env ?? {};
    for (const key of Object.keys(env)) {
      assertEnvName(key);
    }

    const now = new Date();
    const session: SessionState = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      mode: args.mode ?? "context",
      cwd,
      env,
      createdAt: now,
      updatedAt: now,
      lastExitCode: null,
    };
    this.sessions.set(session.id, session);
    if (session.mode === "interactive") {
      try {
        await this.openInteractiveSession(session);
      } catch (error) {
        this.closeInteractiveSession(session);
        this.sessions.delete(session.id);
        throw error;
      }
    }
    return toSessionInfo(this.profileName, session);
  }

  getSession(id: string): SessionInfo {
    return toSessionInfo(this.profileName, this.requireSession(id));
  }

  setSessionCwd(id: string, cwd: string): SessionInfo {
    const session = this.requireSession(id);
    session.cwd = resolveRemotePath(this.profile, cwd).path;
    session.updatedAt = new Date();
    return toSessionInfo(this.profileName, session);
  }

  closeSession(id: string): { closed: string } {
    const session = this.requireSession(id);
    this.closeInteractiveSession(session);
    this.sessions.delete(id);
    return { closed: id };
  }

  async gitStatus(args: { cwd?: string; sessionId?: string }): Promise<GitSummary> {
    const cwd = this.resolveExecutionCwd(args.cwd, args.sessionId);
    const result = await this.shell({
      command: "git status --porcelain=v1 -b",
      cwd,
      sessionId: args.sessionId,
      timeoutMs: this.profile.defaultTimeoutMs,
    }) as ShellResult;
    if (result.exitCode !== 0) {
      throw new RemoteShellError("git status failed", "ERR_GIT_STATUS", {
        cwd,
        stderr: result.stderr,
      });
    }
    return parseGitStatus(result.stdout, cwd);
  }

  async gitDiffStat(args: { cwd?: string; sessionId?: string; base?: string }): Promise<GitDiffStat> {
    const cwd = this.resolveExecutionCwd(args.cwd, args.sessionId);
    const base = args.base?.trim();
    const statCommand = base ? `git diff --stat ${shellQuote(base)}` : "git diff --stat";
    const nameStatusCommand = base ? `git diff --name-status ${shellQuote(base)}` : "git diff --name-status";
    const [stat, nameStatus] = await Promise.all([
      this.shell({ command: statCommand, cwd, sessionId: args.sessionId, timeoutMs: this.profile.defaultTimeoutMs }) as Promise<ShellResult>,
      this.shell({ command: nameStatusCommand, cwd, sessionId: args.sessionId, timeoutMs: this.profile.defaultTimeoutMs }) as Promise<ShellResult>,
    ]);
    if (stat.exitCode !== 0) {
      throw new RemoteShellError("git diff --stat failed", "ERR_GIT_DIFF_STAT", { cwd, stderr: stat.stderr });
    }
    if (nameStatus.exitCode !== 0) {
      throw new RemoteShellError("git diff --name-status failed", "ERR_GIT_NAME_STATUS", { cwd, stderr: nameStatus.stderr });
    }
    return {
      cwd,
      base,
      stat: stat.stdout,
      nameStatus: nameStatus.stdout.split(/\r?\n/).filter(Boolean),
    };
  }

  async gitChangedFiles(args: { cwd?: string; sessionId?: string }): Promise<GitChangedFile[]> {
    return (await this.gitStatus(args)).files;
  }

  async reviewChanges(args: { cwd?: string; sessionId?: string; base?: string }): Promise<ReviewChangesResult> {
    const [status, diffStat] = await Promise.all([
      this.gitStatus(args),
      this.gitDiffStat(args),
    ]);
    const largeChangeHints = diffStat.nameStatus
      .filter((line) => /^R|^D|^A/.test(line))
      .slice(0, 50);
    return {
      status,
      diffStat,
      untrackedCount: status.files.filter((file) => file.status === "untracked").length,
      changedCount: status.files.length,
      largeChangeHints,
    };
  }

  async search(args: { pattern: string; path?: string; glob?: string; maxResults?: number }): Promise<SearchMatch[]> {
    const resolved = resolveRemotePath(this.profile, args.path ?? ".");
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 100, 500));
    const command = [
      "rg",
      "--line-number",
      "--column",
      "--no-heading",
      "--color",
      "never",
      args.glob ? `--glob ${shellQuote(args.glob)}` : "",
      shellQuote(args.pattern),
      shellQuote(resolved.path),
      `| head -n ${maxResults}`,
    ]
      .filter(Boolean)
      .join(" ");

    const result = await this.shell({
      command,
      cwd: resolved.root,
      timeoutMs: this.profile.defaultTimeoutMs,
    }) as ShellResult;

    if (result.exitCode === 127) {
      throw new RemoteShellError("Remote ripgrep command is not available", "ERR_SEARCH_TOOL_MISSING", {
        command: "rg",
        stderr: result.stderr,
      });
    }

    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      return [];
    }

    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => parseRgLine(line))
      .filter((match): match is SearchMatch => Boolean(match));
  }

  async shell(args: {
    command: string;
    cwd?: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    outputMode?: "json" | "terminal" | "compact";
  }): Promise<ShellToolResult> {
    await this.connect();
    const session = args.sessionId ? this.requireSession(args.sessionId) : null;
    const executionCwd = args.cwd ?? session?.cwd ?? this.profile.defaultRoot;
    const resolvedCwd = resolveRemotePath(this.profile, executionCwd);
    const timeoutMs = Math.max(1, Math.min(args.timeoutMs ?? this.profile.defaultTimeoutMs, 10 * 60_000));
    const mergedEnv = { ...(session?.env ?? {}), ...(args.env ?? {}) };
    if (session?.mode === "interactive") {
      return this.runInteractiveShellCommand(session, {
        command: args.command,
        cwd: resolvedCwd.path,
        env: args.env ?? {},
        timeoutMs,
        outputMode: args.outputMode ?? "json",
      });
    }

    const envPrefix = Object.entries(mergedEnv).map(([key, value]) => {
      assertEnvName(key);
      return `${key}=${shellQuote(value)}`;
    }).join(" ");
    const commandBody = this.composeShellBody(args.command);
    const wrappedCommand = `cd ${shellQuote(resolvedCwd.path)} && ${envPrefix ? `${envPrefix} ` : ""}${shellQuote(this.profile.shell)} -lc ${shellQuote(commandBody)}`;

    const startedAt = Date.now();
    return new Promise<ShellToolResult>((resolve, reject) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      this.conn.exec(wrappedCommand, (error, stream) => {
        if (error) {
          reject(new RemoteShellError(`Failed to execute command: ${error.message}`, "ERR_SHELL_EXEC"));
          return;
        }

        timer = setTimeout(() => {
          settled = true;
          stream.close();
          this.clearFileCache();
          const raw: ShellResult = {
            command: args.command,
            cwd: resolvedCwd.path,
            outputMode: "json",
            exitCode: null,
            signal: "TIMEOUT",
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdoutTruncated,
            stderrTruncated,
            durationMs: Date.now() - startedAt,
          };
          if (session) {
            session.lastExitCode = null;
            session.updatedAt = new Date();
          }
          resolve(this.formatShellResult(raw, args.outputMode ?? "json"));
        }, timeoutMs);

        stream.on("data", (chunk: Buffer) => {
          const result = appendLimited(stdoutChunks, chunk, stdoutBytes, this.profile.maxOutputBytes);
          stdoutBytes = result.bytes;
          stdoutTruncated = stdoutTruncated || result.truncated;
        });

        stream.stderr.on("data", (chunk: Buffer) => {
          const result = appendLimited(stderrChunks, chunk, stderrBytes, this.profile.maxOutputBytes);
          stderrBytes = result.bytes;
          stderrTruncated = stderrTruncated || result.truncated;
        });

        stream.on("close", (code: number | null, signal: string | null) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          this.clearFileCache();
          const raw: ShellResult = {
            command: args.command,
            cwd: resolvedCwd.path,
            outputMode: "json",
            exitCode: code,
            signal,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdoutTruncated,
            stderrTruncated,
            durationMs: Date.now() - startedAt,
          };
          if (session) {
            session.lastExitCode = code;
            session.updatedAt = new Date();
          }
          resolve(this.formatShellResult(raw, args.outputMode ?? "json"));
        });
      });
    });
  }

  private async openInteractiveSession(session: SessionState): Promise<void> {
    await this.connect();
    const shellCommand = `${shellQuote(this.profile.shell)} -i`;
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      this.conn.exec(shellCommand, (error, channel) => {
        if (error) {
          reject(new RemoteShellError(`Failed to open interactive shell: ${error.message}`, "ERR_INTERACTIVE_SHELL"));
          return;
        }
        resolve(channel);
      });
    });

    session.interactive = {
      stream,
      queue: Promise.resolve(),
      closed: false,
    };

    stream.once("close", () => {
      if (session.interactive) {
        session.interactive.closed = true;
      }
    });

    const initCommand = [
      "export PS1=''",
      "unset PROMPT_COMMAND",
      ...this.exportCommands(session.env),
      this.profile.initCommand,
      `cd ${shellQuote(session.cwd)}`,
    ].filter((line): line is string => Boolean(line && line.trim())).join("\n");

    const result = await this.executeInteractiveCommand(session, {
      command: initCommand,
      displayCommand: "<interactive session init>",
      cwd: session.cwd,
      timeoutMs: this.profile.defaultTimeoutMs,
    });

    if (result.exitCode !== 0) {
      throw new RemoteShellError("Interactive shell initialization failed", "ERR_INTERACTIVE_INIT", {
        profile: this.profileName,
        shell: this.profile.shell,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  }

  private runInteractiveShellCommand(session: SessionState, args: {
    command: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    outputMode: "json" | "terminal" | "compact";
  }): Promise<ShellToolResult> {
    if (!session.interactive || session.interactive.closed) {
      throw new RemoteShellError("Interactive shell session is closed", "ERR_SESSION_CLOSED", {
        sessionId: session.id,
      });
    }

    const run = async (): Promise<ShellToolResult> => {
      const commandLines: string[] = [];
      if (args.cwd !== session.cwd) {
        commandLines.push(`cd ${shellQuote(args.cwd)}`);
        session.cwd = args.cwd;
      }

      commandLines.push(...this.exportCommands(args.env));
      if (Object.keys(args.env).length > 0) {
        session.env = { ...session.env, ...args.env };
      }

      commandLines.push(args.command);
      const raw = await this.executeInteractiveCommand(session, {
        command: commandLines.join("\n"),
        displayCommand: args.command,
        cwd: session.cwd,
        timeoutMs: args.timeoutMs,
      });
      return this.formatShellResult(raw, args.outputMode);
    };

    const current = session.interactive.queue.then(run, run);
    session.interactive.queue = current.then(() => undefined, () => undefined);
    return current;
  }

  private executeInteractiveCommand(session: SessionState, args: {
    command: string;
    displayCommand: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<ShellResult> {
    const runtime = session.interactive;
    if (!runtime || runtime.closed) {
      throw new RemoteShellError("Interactive shell session is closed", "ERR_SESSION_CLOSED", {
        sessionId: session.id,
      });
    }

    const startedAt = Date.now();
    const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const beginMarker = `__REMOTE_SHELL_BEGIN_${token}__`;
    const statusPrefix = `__REMOTE_SHELL_STATUS_${token}__:`;
    const pwdPrefix = `__REMOTE_SHELL_PWD_${token}__:`;
    const wrappedCommand = [
      `printf '%s\\n' ${shellQuote(beginMarker)}`,
      args.command,
      "__remote_shell_status=$?",
      "__remote_shell_pwd=$(pwd 2>/dev/null || printf '')",
      `printf '%s%s\\n' ${shellQuote(statusPrefix)} "$__remote_shell_status"`,
      `printf '%s%s\\n' ${shellQuote(pwdPrefix)} "$__remote_shell_pwd"`,
    ].join("\n") + "\n";

    return new Promise<ShellResult>((resolve) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let markerBuffer = "";
      let settled = false;

      const cleanup = () => {
        runtime.stream.off("data", onStdout);
        runtime.stream.stderr.off("data", onStderr);
        runtime.stream.off("close", onClose);
        clearTimeout(timer);
      };

      const finish = (exitCode: number | null, signal: string | null, cwd: string, timedOut = false) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.clearFileCache();
        const stdout = stripInteractiveMarkers(
          Buffer.concat(stdoutChunks).toString("utf8"),
          beginMarker,
          [statusPrefix, pwdPrefix],
        );
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        session.cwd = cwd || session.cwd;
        session.lastExitCode = exitCode;
        session.updatedAt = new Date();
        resolve({
          command: args.displayCommand,
          cwd: session.cwd,
          outputMode: "json",
          exitCode,
          signal: timedOut ? "TIMEOUT" : signal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - startedAt,
        });
      };

      const tryComplete = () => {
        const statusMatch = new RegExp(`${escapeRegExp(statusPrefix)}(\\d+)`).exec(markerBuffer);
        const pwdMatch = new RegExp(`${escapeRegExp(pwdPrefix)}([^\\r\\n]*)`).exec(markerBuffer);
        if (!statusMatch || !pwdMatch) {
          return;
        }
        finish(Number(statusMatch[1]), null, pwdMatch[1]);
      };

      const onStdout = (chunk: Buffer) => {
        const result = appendLimited(stdoutChunks, chunk, stdoutBytes, this.profile.maxOutputBytes);
        stdoutBytes = result.bytes;
        stdoutTruncated = stdoutTruncated || result.truncated;
        markerBuffer = `${markerBuffer}${chunk.toString("utf8")}`;
        if (markerBuffer.length > 32_768) {
          markerBuffer = markerBuffer.slice(-32_768);
        }
        tryComplete();
      };

      const onStderr = (chunk: Buffer) => {
        const result = appendLimited(stderrChunks, chunk, stderrBytes, this.profile.maxOutputBytes);
        stderrBytes = result.bytes;
        stderrTruncated = stderrTruncated || result.truncated;
      };

      const onClose = (code: number | null, signal: string | null) => {
        runtime.closed = true;
        finish(code, signal, session.cwd);
      };

      const timer = setTimeout(() => {
        runtime.closed = true;
        finish(null, "TIMEOUT", session.cwd, true);
        runtime.stream.close();
      }, args.timeoutMs);

      runtime.stream.on("data", onStdout);
      runtime.stream.stderr.on("data", onStderr);
      runtime.stream.once("close", onClose);
      runtime.stream.write(wrappedCommand);
    });
  }

  private composeShellBody(command: string): string {
    return [this.profile.initCommand, command]
      .filter((line): line is string => Boolean(line && line.trim()))
      .join("\n");
  }

  private exportCommands(env: Record<string, string>): string[] {
    return Object.entries(env).map(([key, value]) => {
      assertEnvName(key);
      return `export ${key}=${shellQuote(value)}`;
    });
  }

  private closeInteractiveSession(session: SessionState): void {
    if (!session.interactive || session.interactive.closed) {
      return;
    }
    session.interactive.closed = true;
    session.interactive.stream.close();
  }

  private async getSftp(): Promise<SFTPWrapper> {
    await this.connect();
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.conn.sftp((error, sftp) => {
          if (error) {
            reject(new RemoteShellError(`Failed to open SFTP session: ${error.message}`, "ERR_SFTP"));
            return;
          }
          resolve(sftp);
        });
      });
    }

    return this.sftpPromise;
  }

  private toFileReadResult(path: string, buffer: Buffer, maxBytes: number, hash = sha256(buffer)): FileReadResult {
    const truncated = buffer.byteLength > maxBytes;
    const visible = truncated ? buffer.subarray(0, maxBytes) : buffer;

    return {
      path,
      content: visible.toString("utf8"),
      hash,
      size: buffer.byteLength,
      truncated,
    };
  }

  private getCachedFile(remotePath: string): CachedFile | null {
    const config = this.profile.fileCache;
    if (!config.enabled || config.ttlMs === 0) {
      return null;
    }

    const cached = this.fileCache.get(remotePath);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.cachedAt > config.ttlMs) {
      this.fileCache.delete(remotePath);
      return null;
    }

    this.fileCache.delete(remotePath);
    this.fileCache.set(remotePath, cached);
    return cached;
  }

  private setCachedFile(remotePath: string, buffer: Buffer, hash = sha256(buffer)): void {
    const config = this.profile.fileCache;
    if (!config.enabled || config.ttlMs === 0 || buffer.byteLength > config.maxFileBytes) {
      this.fileCache.delete(remotePath);
      return;
    }

    this.fileCache.delete(remotePath);
    this.fileCache.set(remotePath, {
      buffer,
      hash,
      cachedAt: Date.now(),
    });

    while (this.fileCache.size > config.maxEntries) {
      const oldestKey = this.fileCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.fileCache.delete(oldestKey);
    }
  }

  private invalidateCachedFile(remotePath: string): void {
    this.fileCache.delete(remotePath);
  }

  private clearFileCache(): void {
    this.fileCache.clear();
  }

  private requireSession(id: string): SessionState {
    const session = this.sessions.get(id);
    if (!session) {
      throw new RemoteShellError("Unknown shell session", "ERR_SESSION_NOT_FOUND", {
        sessionId: id,
        availableSessions: [...this.sessions.keys()],
      });
    }
    return session;
  }

  private resolveExecutionCwd(cwd?: string, sessionId?: string): string {
    return resolveRemotePath(this.profile, cwd ?? (sessionId ? this.requireSession(sessionId).cwd : this.profile.defaultRoot)).path;
  }

  private formatShellResult(result: ShellResult, mode: "json" | "terminal" | "compact"): ShellToolResult {
    if (mode === "json") {
      return result;
    }

    if (mode === "terminal") {
      const header = `$ ${result.command}\n[cwd] ${result.cwd}\n`;
      const stderr = result.stderr ? `\n[stderr]\n${result.stderr}` : "";
      const footer = `\n[exit] ${result.exitCode ?? result.signal ?? "unknown"} in ${result.durationMs}ms`;
      return `${header}${result.stdout}${stderr}${footer}`;
    }

    return {
      command: result.command,
      cwd: result.cwd,
      outputMode: "compact",
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: compactText(result.stdout),
      stderr: compactText(result.stderr),
      durationMs: result.durationMs,
    } satisfies CompactShellResult;
  }

  private buildAuthMethods(): AnyAuthMethod[] {
    const methods: AnyAuthMethod[] = [];
    if (this.profile.password) {
      methods.push({
        type: "password",
        username: this.profile.username,
        password: this.profile.password,
      });
    }

    for (const keyPath of this.resolvePrivateKeyPaths()) {
      methods.push({
        type: "publickey",
        username: this.profile.username,
        key: fs.readFileSync(keyPath),
        passphrase: this.profile.passphrase,
      });
    }

    if (this.profile.agent) {
      methods.push({
        type: "agent",
        username: this.profile.username,
        agent: this.profile.agent,
      });
    }

    return methods;
  }

  private async writeBuffer(sftp: SFTPWrapper, remotePath: string, content: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, content, (error) => {
        if (error) {
          reject(new RemoteShellError(`Failed to write file: ${error.message}`, "ERR_WRITE_FILE", { path: remotePath }));
          return;
        }
        resolve();
      });
    });
  }

  private async unlinkFile(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(remotePath, (error) => {
        if (error) {
          reject(new RemoteShellError(`Failed to delete file: ${error.message}`, "ERR_DELETE_FILE", { path: remotePath }));
          return;
        }
        resolve();
      });
    });
  }

  private resolvePrivateKeyPaths(): string[] {
    if (this.profile.privateKeyPath) {
      return [this.profile.privateKeyPath];
    }

    if (!this.profile.tryDefaultPrivateKeys) {
      return [];
    }

    const sshDir = path.join(os.homedir(), ".ssh");
    const candidates = ["id_rsa", "id_ecdsa", "id_ed25519", "id_dsa"].map((fileName) => path.join(sshDir, fileName));
    const paths: string[] = [];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          paths.push(candidate);
        }
      } catch {
        // Ignore inaccessible default key candidates and continue.
      }
    }

    return paths;
  }

  private async readIfExists(sftp: SFTPWrapper, remotePath: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (error, data) => {
        if (error) {
          if (isMissingFileError(error)) {
            resolve(null);
            return;
          }
          reject(new RemoteShellError(`Failed to read file: ${error.message}`, "ERR_READ_FILE", { path: remotePath }));
          return;
        }
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
    });
  }

  private async readRequired(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
    const data = await this.readIfExists(sftp, remotePath);
    if (!data) {
      throw new RemoteShellError("File does not exist", "ERR_FILE_NOT_FOUND", { path: remotePath });
    }
    return data;
  }

}

function isMissingFileError(error: NodeJS.ErrnoException): boolean {
  const code = (error as { code?: unknown }).code;
  return error.errno === 2 || code === 2 || code === "ENOENT";
}

function parseRgLine(line: string): SearchMatch | null {
  const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
  if (!match) {
    return null;
  }

  return {
    path: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    text: match[4],
  };
}

function makeSmallDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split(/\r?\n/).slice(0, 20).map((line) => `-${line}`);
  const newLines = newText.split(/\r?\n/).slice(0, 20).map((line) => `+${line}`);
  return [...oldLines, ...newLines].join("\n");
}

function assertExpectedHash(path: string, actualHash: string, expectedHash?: string): void {
  if (expectedHash && actualHash !== expectedHash) {
    throw new RemoteShellError("File hash does not match expectedHashes entry", "ERR_HASH_MISMATCH", {
      path,
      expectedHash,
      actualHash,
    });
  }
}

function assertEnvName(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new RemoteShellError("Invalid shell environment variable name", "ERR_INVALID_ENV", { key });
  }
}

function toSessionInfo(profile: string, session: SessionState): SessionInfo {
  return {
    id: session.id,
    profile,
    mode: session.mode,
    cwd: session.cwd,
    env: session.env,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    lastExitCode: session.lastExitCode,
  };
}

function stripInteractiveMarkers(raw: string, beginMarker: string, endPrefixes: string[]): string {
  let output = raw.replace(`${beginMarker}\r\n`, "").replace(`${beginMarker}\n`, "");
  const markerIndexes = endPrefixes
    .map((prefix) => output.indexOf(prefix))
    .filter((index) => index >= 0);
  if (markerIndexes.length > 0) {
    output = output.slice(0, Math.min(...markerIndexes));
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactText(text: string): { lineCount: number; head: string[]; tail: string[]; truncated: boolean } {
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  if (lines.length <= 40) {
    return {
      lineCount: lines.length,
      head: lines,
      tail: [],
      truncated: false,
    };
  }

  return {
    lineCount: lines.length,
    head: lines.slice(0, 20),
    tail: lines.slice(-20),
    truncated: true,
  };
}

function parseGitStatus(stdout: string, cwd: string): GitSummary {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branchInfo = parseBranchLine(branchLine);
  const files = lines.filter((line) => !line.startsWith("## ")).map(parseStatusLine);
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.status] = (counts[file.status] ?? 0) + 1;
  }

  return {
    cwd,
    ...branchInfo,
    files,
    counts,
    clean: files.length === 0,
  };
}

function parseBranchLine(line?: string): Pick<GitSummary, "branch" | "upstream" | "ahead" | "behind"> {
  if (!line) {
    return { branch: null, upstream: null, ahead: 0, behind: 0 };
  }

  const text = line.slice(3);
  const [branchPart, trackingPart] = text.split("...");
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (trackingPart) {
    const match = /([^\s[]+)(?: \[(.*?)\])?/.exec(trackingPart);
    upstream = match?.[1] ?? null;
    const flags = match?.[2] ?? "";
    const aheadMatch = /ahead (\d+)/.exec(flags);
    const behindMatch = /behind (\d+)/.exec(flags);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  return {
    branch: branchPart || null,
    upstream,
    ahead,
    behind,
  };
}

function parseStatusLine(line: string): GitChangedFile {
  if (line.startsWith("?? ")) {
    return {
      path: line.slice(3),
      status: "untracked",
      staged: "?",
      unstaged: "?",
    };
  }

  const staged = line[0] ?? " ";
  const unstaged = line[1] ?? " ";
  const body = line.slice(3);
  const renameParts = body.split(" -> ");
  const status = statusLabel(staged, unstaged);
  return {
    path: renameParts.at(-1) ?? body,
    originalPath: renameParts.length > 1 ? renameParts[0] : undefined,
    status,
    staged,
    unstaged,
  };
}

function statusLabel(staged: string, unstaged: string): string {
  if (staged === "R" || unstaged === "R") return "renamed";
  if (staged === "D" || unstaged === "D") return "deleted";
  if (staged === "A" || unstaged === "A") return "added";
  if (staged === "M" || unstaged === "M") return "modified";
  if (staged === "?" || unstaged === "?") return "untracked";
  return "changed";
}
