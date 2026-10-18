# Links this checkout into the OpenCode plugin directory so both halves load.
[CmdletBinding()]
param(
  [string]$Target = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$targetPath = (Resolve-Path -LiteralPath $Target).Path
$plugins = Join-Path -Path $HOME -ChildPath ".config\opencode\plugins"
$link = Join-Path -Path $plugins -ChildPath "opencode-rea-switch"

New-Item -ItemType Directory -Force -Path $plugins | Out-Null

if (Test-Path -LiteralPath $link) {
  $existing = Get-Item -LiteralPath $link -Force
  $isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  if (-not $isLink) {
    throw "Refusing to replace a non-link path: $link"
  }
  Remove-Item -LiteralPath $link -Force
}

New-Item -ItemType Junction -Path $link -Target $targetPath | Out-Null

Write-Host "Installed: $link"
Write-Host "        -> $targetPath"
Write-Host ""
Write-Host "Restart OpenCode once so the server half loads."
Write-Host "After that, /rea opens the switch panel; edits to tui.tsx hot-reload."
