# Removes the plugin junction. It never deletes the checkout itself.
$ErrorActionPreference = "Stop"

$link = Join-Path -Path $HOME -ChildPath ".config\opencode\plugins\opencode-rea-switch"

if (-not (Test-Path -LiteralPath $link)) {
  Write-Host "Not installed: $link"
  exit 0
}

$existing = Get-Item -LiteralPath $link -Force
$isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
if (-not $isLink) {
  throw "Refusing to remove a non-link path: $link"
}

Remove-Item -LiteralPath $link -Force
Write-Host "Removed: $link"
Write-Host "Restart OpenCode to unload the plugin."
