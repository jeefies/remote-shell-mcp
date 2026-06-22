import path from "node:path";
import { RemoteShellError } from "../errors.js";
import type { RemoteProfileConfig, ResolvedRemotePath } from "../types.js";

const posix = path.posix;

export function normalizeRemoteRoot(root: string): string {
  if (!root.startsWith("/")) {
    throw new RemoteShellError(`Remote root must be absolute: ${root}`, "ERR_INVALID_ROOT", { root });
  }

  const normalized = posix.normalize(root);
  if (normalized === "/") {
    throw new RemoteShellError("Remote root cannot be /", "ERR_INVALID_ROOT", { root });
  }

  return normalized.replace(/\/+$/, "");
}

export function isSubpath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function resolveRemotePath(profile: RemoteProfileConfig, inputPath: string): ResolvedRemotePath {
  if (!inputPath || inputPath.includes("\0")) {
    throw new RemoteShellError("Path must be a non-empty string without NUL bytes", "ERR_INVALID_PATH", {
      path: inputPath,
    });
  }

  const roots = profile.roots.map(normalizeRemoteRoot);
  const defaultRoot = normalizeRemoteRoot(profile.defaultRoot);
  if (!roots.some((root) => isSubpath(defaultRoot, root))) {
    throw new RemoteShellError("defaultRoot must be inside configured roots", "ERR_INVALID_ROOT", {
      defaultRoot,
      roots,
    });
  }

  const candidate = inputPath.startsWith("/")
    ? posix.normalize(inputPath)
    : posix.normalize(posix.join(defaultRoot, inputPath));

  const root = roots.find((allowedRoot) => isSubpath(candidate, allowedRoot));
  if (!root) {
    throw new RemoteShellError("Path escapes configured remote roots", "ERR_PATH_OUTSIDE_ROOT", {
      path: inputPath,
      resolvedPath: candidate,
      roots,
    });
  }

  return {
    input: inputPath,
    root,
    path: candidate,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
