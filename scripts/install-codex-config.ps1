param(
  [string]$ConfigPath = "$env:USERPROFILE\.codex\config.toml",
  [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServerPath = Resolve-Path (Join-Path $ProjectRoot "dist\index.js")
$RemoteConfigPath = Resolve-Path (Join-Path $ProjectRoot "remote-shell.config.json")

if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.js executable was not found: $NodePath"
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Codex config file was not found: $ConfigPath"
}

$backupPath = "$ConfigPath.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
Copy-Item -LiteralPath $ConfigPath -Destination $backupPath

$content = Get-Content -LiteralPath $ConfigPath -Raw
$block = @"
[mcp_servers.remote_shell]
command = '$NodePath'
args = ['$ServerPath']
startup_timeout_sec = 30

[mcp_servers.remote_shell.env]
REMOTE_SHELL_CONFIG = '$RemoteConfigPath'
"@

$pattern = "(?ms)(?:\r?\n)?\[mcp_servers\.remote_shell\]\r?\n.*?(?=\r?\n\[(?!mcp_servers\.remote_shell(?:\.env)?\])[^\]]+\]|\z)"
if ($content -match "\[mcp_servers\.remote_shell\]") {
  $content = [regex]::Replace($content, $pattern, "`r`n$block`r`n", 1)
} else {
  $content = $content.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
}

Set-Content -LiteralPath $ConfigPath -Value $content -NoNewline

[pscustomobject]@{
  config = $ConfigPath
  backup = $backupPath
  server = "$ServerPath"
  remoteConfig = "$RemoteConfigPath"
  node = $NodePath
} | ConvertTo-Json -Depth 3
