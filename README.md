# Remote Shell MCP

Remote Shell MCP is a local MCP server that exposes agent-safe remote workspace tools over SSH.

The MVP focuses on a small remote code workspace surface:

- `profile_list`
- `profile_get`
- `profile_create`
- `profile_update`
- `profile_delete`
- `profile_set_default`
- `workspace_info`
- `session_create`
- `session_info`
- `session_set_cwd`
- `session_close`
- `list_dir`
- `read_file`
- `write_file`
- `edit_file`
- `apply_patch`
- `search`
- `shell`
- `git_status`
- `git_diff_stat`
- `git_changed_files`
- `review_changes`

The server is intended to run locally. It connects to remote hosts over SSH/SFTP and restricts all file operations and command working directories to configured remote roots.

## Configuration

Create a config file from `remote-shell.config.example.json`, then point the server at it:

```powershell
$env:REMOTE_SHELL_CONFIG = "C:\path\to\remote-shell.config.json"
npm run dev
```

## MCP Client Command

After building:

```json
{
  "mcpServers": {
    "remote-shell": {
      "command": "node",
      "args": ["C:\\path\\to\\remote-shell-mcp\\dist\\index.js"],
      "env": {
        "REMOTE_SHELL_CONFIG": "C:\\path\\to\\remote-shell.config.json"
      }
    }
  }
}
```

## Codex Integration

Run the local MCP smoke test first:

```powershell
npm run build
npm run test:mcp
```

Then install the server into Codex's global config:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex-config.ps1
```

The script backs up `%USERPROFILE%\.codex\config.toml` and writes:

```toml
[mcp_servers.remote_shell]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\jeefy\Documents\RemoteShell\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.remote_shell.env]
REMOTE_SHELL_CONFIG = 'C:\Users\jeefy\Documents\RemoteShell\remote-shell.config.json'
```

Restart Codex, or start a new Codex thread, after changing MCP config.

## Safety Model

- Remote paths are normalized as POSIX paths.
- Relative paths are resolved under the profile's `defaultRoot`.
- Absolute paths must stay under one of the profile's allowed `roots`.
- Writes and edits support `expectedHash` to avoid overwriting changed files.
- Shell `cwd` must stay under an allowed root.
- Command output is truncated by configurable byte limits.

## Sessions And Shell Output

Use sessions when a task has a working directory that should persist across multiple commands:

```json
{ "cwd": "/root/project" }
```

Then pass the returned `sessionId` to `shell`, `git_status`, `git_diff_stat`, `git_changed_files`, or `review_changes`.

By default, sessions use `mode: "context"` and store cwd/env only. To reuse one remote shell process across multiple commands, create an interactive session:

```json
{ "cwd": "/root/project", "mode": "interactive" }
```

Interactive sessions preserve shell-local state such as `cd`, exported variables, functions, and environment activations until `session_close` or server shutdown.

`shell` supports three output modes:

- `json`: default structured output with stdout/stderr fields.
- `terminal`: terminal-like plain text for easier reading.
- `compact`: line counts plus head/tail summaries for long output.

## Git Review Tools

For large working tree changes, prefer Git-specific tools over raw `git status` output:

- `git_status`: parsed branch, ahead/behind, changed files, and counts.
- `git_diff_stat`: `git diff --stat` plus name-status lines.
- `git_changed_files`: changed files only.
- `review_changes`: compact status + diff stat + review hints.

## Connection And Cache Behavior

Within one running MCP server process, SSH connections are reused per profile. One-shot `shell` calls open new exec channels over the existing SSH connection. Interactive sessions keep one shell channel alive and serialize commands sent to that session.

Profiles can set `shell` and `initCommand`. One-shot shell calls run the init command before the user command. Interactive sessions run it once when the session is created.

`read_file` uses a small in-memory cache when `fileCache.enabled` is true:

- Only files at or below `fileCache.maxFileBytes` are cached.
- Cache entries expire after `fileCache.ttlMs`.
- `write_file`, `edit_file`, and `apply_patch` update or invalidate affected entries.
- `shell` clears the profile file cache because shell commands may modify arbitrary files.
- External server-side changes made outside this MCP server can remain invisible until the TTL expires.

See `docs/mvp-design.md` for the MVP boundaries and extension points.

## Profile Management

Profiles are stored in the JSON config file pointed to by `REMOTE_SHELL_CONFIG`.

Profile tools persist changes atomically:

- `profile_create` fails with `ERR_PROFILE_EXISTS` when the name already exists.
- `profile_update` fails with `ERR_PROFILE_NOT_FOUND` when the name does not exist.
- `profile_delete` fails with `ERR_PROFILE_NOT_FOUND` when the name does not exist.
- `profile_delete` fails with `ERR_DEFAULT_PROFILE_DELETE` when deleting the default profile without `newDefaultProfile`.
- `profile_delete` fails with `ERR_PROFILE_LAST_DELETE` when deleting the only remaining profile.

Secret fields such as `password` and `passphrase` are not returned by `profile_list` or `profile_get`.

## Patch Format

`apply_patch` accepts Codex-style patches:

```text
*** Begin Patch
*** Add File: hello.txt
+hello
+world
*** Update File: app.txt
@@
 context
-old
+new
*** Delete File: old.txt
*** End Patch
```

The MVP supports `Add File`, `Update File`, and `Delete File`.

- Paths are resolved under the selected profile's allowed roots.
- `Update File` hunks must match exactly once.
- `Add File` fails if the target already exists.
- `Delete File` fails if the target does not exist.
- `expectedHashes` can be provided for update/delete conflict checks.
