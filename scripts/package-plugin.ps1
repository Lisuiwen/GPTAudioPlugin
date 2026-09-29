$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$staging = Join-Path $dist "plugin-package"
$zip = Join-Path $dist "gpt-audio-plugin.zip"

if (Test-Path $staging) {
  Remove-Item $staging -Recurse -Force
}

if (Test-Path $zip) {
  Remove-Item $zip -Force
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging ".codex-plugin") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging "skills\audio-creator") -Force | Out-Null

Copy-Item (Join-Path $root "plugin.json") $staging
Copy-Item (Join-Path $root "mcp.json") $staging
Copy-Item (Join-Path $root ".mcp.json") $staging
Copy-Item (Join-Path $root ".codex-plugin\plugin.json") (Join-Path $staging ".codex-plugin\plugin.json")
Copy-Item (Join-Path $root "skills\audio-creator\SKILL.md") (Join-Path $staging "skills\audio-creator\SKILL.md")

Get-ChildItem -Path $staging -Force |
  Compress-Archive -DestinationPath $zip -Force

Write-Host "Created $zip"
