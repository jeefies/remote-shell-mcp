# MVP Design

## Goal

Provide a local MCP server that lets agents operate a configured remote code workspace through structured tools instead of repeatedly composing raw SSH commands.

## Non-goals

- No remote worker in the MVP.
- No file watching.
- No multi-user collaboration model.
- No long-running process/session manager.
- No deployment automation.
- No unrestricted remote filesystem access.

## Layers

### MCP Layer

Files:

- `src/index.ts`
- `src/tools/schemas.ts`
- `src/tools/handlers.ts`

Responsibilities:

- Register MCP tool metadata.
- Validate tool inputs.
- Convert tool results and errors into MCP text responses.

### Client Management Layer

File:

- `src/clientManager.ts`

Responsibilities:

- Select the configured remote profile.
- Cache one remote client per profile.
- Own lifecycle cleanup.

Within one MCP server process, this means SSH connections are reused per profile. One-shot shell commands run as new exec channels over the existing SSH connection. Interactive sessions keep one remote shell channel alive and serialize commands through it.

### Remote Client Interface

File:

- `src/types.ts`

Responsibilities:

- Define the stable remote workspace contract.
- Keep MCP tools independent from the transport implementation.

Current implementation:

- `src/remote/SshRemoteClient.ts`

Future implementation options:

- Remote worker over HTTP.
- SSH tunnel to a remote MCP-compatible worker.
- Container or VM executor.

### Safety Utilities

Files:

- `src/util/posixPath.ts`
- `src/util/hash.ts`
- `src/util/limits.ts`

Responsibilities:

- Normalize remote POSIX paths.
- Reject paths outside configured roots.
- Hash file contents for write/edit conflict detection.
- Bound shell output sizes.

### File Cache

`SshRemoteClient` keeps an in-memory small-file cache per profile.

Cache rules:

- `read_file` can return cached content for files within `fileCache.maxFileBytes`.
- Entries expire after `fileCache.ttlMs`.
- `write_file`, `edit_file`, and `apply_patch` update or invalidate affected paths.
- `shell` clears the whole profile cache because it can modify arbitrary files.
- Write paths always read fresh remote content before conflict checks, so stale cache entries are not used to compute `expectedHash` behavior.

## MVP Tools

### `profile_list`

Lists configured SSH profiles and the default profile. Secret fields are redacted.

### `profile_get`

Returns one configured SSH profile by name. Secret fields are redacted.

### `profile_create`

Creates a profile in the config file. Creation fails if the profile already exists or if the profile is invalid.

### `profile_update`

Updates an existing profile and invalidates any cached SSH client for that profile.

### `profile_delete`

Deletes a profile and invalidates any cached SSH client for that profile.

Deleting the default profile requires `newDefaultProfile`. Deleting the last profile is rejected.

### `profile_set_default`

Sets an existing profile as the default profile.

### `workspace_info`

Returns selected profile metadata, configured roots, limits, common remote command availability, command paths, versions, detected shell, configured shell, system, and a preferred Python command.

### `session_create`

Creates a session. `mode: "context"` stores cwd and env only. `mode: "interactive"` opens one persistent remote shell process for the session.

### `session_info`

Returns a session's mode, cwd, env, timestamps, and last exit code.

### `session_set_cwd`

Updates a session cwd after validating it stays inside allowed roots.

### `session_close`

Removes a session context and closes its interactive shell channel when present.

### `list_dir`

Lists a remote directory under allowed roots.

### `read_file`

Reads a UTF-8 file and returns:

- resolved path
- content
- full file SHA-256 hash
- file size
- truncation flag

### `write_file`

Writes full UTF-8 file content.

If `expectedHash` is present, the current remote file must match it before writing.

### `edit_file`

Applies one exact `oldText` to `newText` replacement.

The MVP intentionally rejects ambiguous edits where `oldText` appears more than once.

### `apply_patch`

Applies a Codex-style patch under the selected profile's allowed roots.

Supported operations:

- `*** Add File: path`
- `*** Update File: path`
- `*** Delete File: path`

Update hunks use exact context matching. A hunk is rejected when it does not match or when it matches more than once.

`expectedHashes` can be supplied as a map keyed by patch path or resolved remote path. Hash checks apply to update and delete operations.

Current MVP limitations:

- No `Move to` support.
- No fuzzy hunk matching.
- Update hunks must include context or removed lines.

### `search`

Runs remote `rg` under the selected root and returns parsed match objects.

### `shell`

Runs a remote command through the configured profile shell with:

- cwd restricted to allowed roots
- optional session cwd/env
- optional profile `initCommand`
- timeout
- stdout/stderr byte limits
- structured exit code and signal fields

When called with an interactive `sessionId`, `shell` reuses that session's shell process so state from previous commands can persist.

Output modes:

- `json`: current structured result.
- `terminal`: terminal-like plain text.
- `compact`: line counts plus head/tail summaries.

### `git_status`

Returns parsed branch, upstream, ahead/behind, changed files, and change counts.

### `git_diff_stat`

Returns `git diff --stat` and `git diff --name-status` output.

### `git_changed_files`

Returns changed files from parsed `git status --porcelain=v1 -b`.

### `review_changes`

Combines Git status, diff stat, changed counts, untracked count, and review hints for large change sets.

## Extension Points

### More Edit Modes

Add later:

- standard unified diff input
- `Move to` support
- multiple exact replacements
- line-range replacement with hash checks
- AST-aware edits for common languages

### Long-running Processes

Add a session manager:

- `shell_start`
- `shell_read`
- `shell_write`
- `shell_stop`

Interactive sessions cover request/response shell state reuse. Streaming process control is still a separate future surface.

### Approval Policy

Add configurable command policy:

- allowlist
- denylist
- destructive command detection
- per-tool approval requirements

### Remote Worker

The current `RemoteClient` interface is the boundary for replacing SSH/SFTP with a remote worker without changing MCP tool schemas.

### Codex Integration

The server is installed into Codex through `[mcp_servers.remote_shell]` in `%USERPROFILE%\.codex\config.toml`.

See `docs/codex-integration.md` for the install script, verification flow, and expected tool list.
