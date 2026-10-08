$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$staging = Join-Path $dist "plugin-package"
$zip = Join-Path $dist "gpt-audio-plugin.zip"

$dist = [System.IO.Path]::GetFullPath($dist)
$staging = [System.IO.Path]::GetFullPath($staging)
if (-not $staging.StartsWith($dist + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Package staging directory must stay inside $dist"
}

if (Test-Path $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}

if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip -Force
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging ".codex-plugin") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging "skills\audio-creator") -Force | Out-Null

Copy-Item (Join-Path $root "plugin.json") $staging
Copy-Item (Join-Path $root "mcp.json") $staging
Copy-Item (Join-Path $root ".mcp.json") $staging
Copy-Item (Join-Path $root ".codex-plugin\plugin.json") (Join-Path $staging ".codex-plugin\plugin.json")
Copy-Item (Join-Path $root "skills\audio-creator\SKILL.md") (Join-Path $staging "skills\audio-creator\SKILL.md")

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $staging -Recurse -Force -File | ForEach-Object {
    $entryName = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  foreach ($entry in @("plugin.json", "mcp.json", ".mcp.json", ".codex-plugin/plugin.json", "skills/audio-creator/SKILL.md")) {
    if (-not $archive.GetEntry($entry)) {
      throw "Missing plugin package entry: $entry"
    }
  }
} finally {
  $archive.Dispose()
}

Write-Host "Created $zip"
