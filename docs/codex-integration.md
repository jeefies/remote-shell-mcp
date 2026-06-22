# Codex Integration

This project is installed into Codex as a local stdio MCP server.

## Installed Config

The installer writes to:

```text
%USERPROFILE%\.codex\config.toml
```

Current server block:

```toml
[mcp_servers.remote_shell]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\jeefy\Documents\RemoteShell\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.remote_shell.env]
REMOTE_SHELL_CONFIG = 'C:\Users\jeefy\Documents\RemoteShell\remote-shell.config.json'
```

## Local Verification

Run:

```powershell
npm run build
npm run test:mcp
```

`test:mcp` starts the built MCP server over stdio and verifies that Codex-facing tools are listed.

## Codex Verification

After changing MCP config, restart Codex or start a fresh Codex thread.

Expected tool namespace:

```text
remote_shell
```

Expected tools include:

- `profile_list`
- `workspace_info`
- `list_dir`
- `read_file`
- `write_file`
- `edit_file`
- `apply_patch`
- `shell`

Start with read-only checks:

```text
profile_list
workspace_info
shell { "command": "pwd", "cwd": "." }
list_dir { "path": "." }
```

Only run write tools against the configured test root:

```text
/root/remote-shell-mcp-test
```

## Reinstall

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex-config.ps1
```

The script is idempotent and creates a timestamped backup before changing Codex config.
