import { RemoteShellError } from "../errors.js";

export type PatchOperation =
  | {
      type: "add";
      path: string;
      content: string;
    }
  | {
      type: "delete";
      path: string;
    }
  | {
      type: "update";
      path: string;
      hunks: PatchHunk[];
    };

export interface PatchHunk {
  lines: PatchLine[];
}

export interface PatchLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface AppliedHunk {
  oldText: string;
  newText: string;
}

export function parseCodexPatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  if (lines[0] !== "*** Begin Patch") {
    throw new RemoteShellError("Patch must start with *** Begin Patch", "ERR_PATCH_PARSE");
  }

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const contentLine = lines[index];
        if (!contentLine.startsWith("+")) {
          throw new RemoteShellError("Add File lines must start with +", "ERR_PATCH_PARSE", {
            path: filePath,
            line: index + 1,
          });
        }
        contentLines.push(contentLine.slice(1));
        index += 1;
      }
      operations.push({
        type: "add",
        path: filePath,
        content: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "",
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        type: "delete",
        path: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      index += 1;
      const hunks: PatchHunk[] = [];

      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (lines[index].startsWith("@@")) {
          index += 1;
          const hunkLines: PatchLine[] = [];
          while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
            const patchLine = lines[index];
            if (patchLine === "\\ No newline at end of file") {
              index += 1;
              continue;
            }
            if (patchLine.length === 0) {
              throw new RemoteShellError("Patch hunk lines must start with space, +, or -", "ERR_PATCH_PARSE", {
                path: filePath,
                line: index + 1,
              });
            }

            const prefix = patchLine[0];
            if (prefix === " ") {
              hunkLines.push({ kind: "context", text: patchLine.slice(1) });
            } else if (prefix === "+") {
              hunkLines.push({ kind: "add", text: patchLine.slice(1) });
            } else if (prefix === "-") {
              hunkLines.push({ kind: "remove", text: patchLine.slice(1) });
            } else {
              throw new RemoteShellError("Patch hunk lines must start with space, +, or -", "ERR_PATCH_PARSE", {
                path: filePath,
                line: index + 1,
              });
            }
            index += 1;
          }

          if (hunkLines.length === 0) {
            throw new RemoteShellError("Patch hunk must contain at least one line", "ERR_PATCH_PARSE", {
              path: filePath,
            });
          }

          hunks.push({ lines: hunkLines });
          continue;
        }

        if (lines[index] === "*** End of File") {
          index += 1;
          continue;
        }

        throw new RemoteShellError("Update File sections must contain @@ hunks", "ERR_PATCH_PARSE", {
          path: filePath,
          line: index + 1,
        });
      }

      if (hunks.length === 0) {
        throw new RemoteShellError("Update File section must contain at least one hunk", "ERR_PATCH_PARSE", {
          path: filePath,
        });
      }

      operations.push({
        type: "update",
        path: filePath,
        hunks,
      });
      continue;
    }

    throw new RemoteShellError("Unsupported patch operation", "ERR_PATCH_PARSE", {
      line: index + 1,
      content: line,
    });
  }

  throw new RemoteShellError("Patch must end with *** End Patch", "ERR_PATCH_PARSE");
}

export function applyPatchHunks(content: string, hunks: PatchHunk[], filePath: string): {
  content: string;
  appliedHunks: AppliedHunk[];
} {
  let nextContent = content;
  const appliedHunks: AppliedHunk[] = [];

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    if (oldLines.length === 0) {
      throw new RemoteShellError("Patch update hunks must include context or removed lines", "ERR_PATCH_HUNK_EMPTY_CONTEXT", {
        path: filePath,
      });
    }

    const candidates = uniqueCandidates(oldLines);
    const replacement = makeLineBlock(newLines, true);
    const match = candidates.find((candidate) => nextContent.includes(candidate));
    if (!match) {
      throw new RemoteShellError("Patch hunk did not match file content", "ERR_PATCH_HUNK_NO_MATCH", {
        path: filePath,
      });
    }

    const first = nextContent.indexOf(match);
    if (nextContent.indexOf(match, first + match.length) !== -1) {
      throw new RemoteShellError("Patch hunk matched more than once", "ERR_PATCH_HUNK_NOT_UNIQUE", {
        path: filePath,
      });
    }

    nextContent = nextContent.slice(0, first) + replacement + nextContent.slice(first + match.length);
    appliedHunks.push({
      oldText: match,
      newText: replacement,
    });
  }

  return {
    content: nextContent,
    appliedHunks,
  };
}

function uniqueCandidates(lines: string[]): string[] {
  const withTrailingNewline = makeLineBlock(lines, true);
  const withoutTrailingNewline = makeLineBlock(lines, false);
  return withTrailingNewline === withoutTrailingNewline
    ? [withTrailingNewline]
    : [withTrailingNewline, withoutTrailingNewline];
}

function makeLineBlock(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }

  const text = lines.join("\n");
  return trailingNewline ? `${text}\n` : text;
}
