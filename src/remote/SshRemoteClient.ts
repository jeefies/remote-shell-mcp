import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type AnyAuthMethod, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { RemoteShellError } from "../errors.js";
import type {
  ApplyPatchResult,
  DirectoryEntry,
  EditFileResult,
  FileReadResult,
  RemoteClient,
  RemoteProfileConfig,
  SearchMatch,
  ShellResult,
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

export class SshRemoteClient implements RemoteClient {
  private readonly conn = new Client();
  private connectPromise: Promise<void> | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private readonly fileCache = new Map<string, CachedFile>();
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
    this.conn.end();
  }

  async workspaceInfo(): Promise<Record<string, unknown>> {
    const probes = await Promise.all(
      ["git", "rg", "node", "python3", "python"].map(async (command) => {
        const result = await this.shell({
          command: `command -v ${command}`,
          cwd: this.profile.defaultRoot,
          timeoutMs: 5_000,
        });
        return [command, result.exitCode === 0 && result.stdout.trim().length > 0] as const;
      }),
    );

    return {
      profile: this.profileName,
      host: this.profile.host,
      username: this.profile.username,
      defaultRoot: this.profile.defaultRoot,
      roots: this.profile.roots,
      capabilities: Object.fromEntries(probes),
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
    });

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
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<ShellResult> {
    await this.connect();
    const resolvedCwd = resolveRemotePath(this.profile, args.cwd ?? this.profile.defaultRoot);
    const timeoutMs = Math.max(1, Math.min(args.timeoutMs ?? this.profile.defaultTimeoutMs, 10 * 60_000));
    const envPrefix = args.env ? Object.entries(args.env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new RemoteShellError("Invalid shell environment variable name", "ERR_INVALID_ENV", { key });
      }
      return `${key}=${shellQuote(value)}`;
    }).join(" ") : "";
    const wrappedCommand = `cd ${shellQuote(resolvedCwd.path)} && ${envPrefix ? `${envPrefix} ` : ""}sh -lc ${shellQuote(args.command)}`;

    const startedAt = Date.now();
    return new Promise<ShellResult>((resolve, reject) => {
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
          resolve({
            command: args.command,
            cwd: resolvedCwd.path,
            exitCode: null,
            signal: "TIMEOUT",
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdoutTruncated,
            stderrTruncated,
            durationMs: Date.now() - startedAt,
          });
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
          resolve({
            command: args.command,
            cwd: resolvedCwd.path,
            exitCode: code,
            signal,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdoutTruncated,
            stderrTruncated,
            durationMs: Date.now() - startedAt,
          });
        });
      });
    });
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
