[CmdletBinding()]
param(
  [switch]$CreateShortcut
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$jarvisExe = Join-Path $repoRoot 'dist-desktop\electron\win-unpacked\Jarvis.exe'

Push-Location $repoRoot
try {
  node scripts/build-jarvis-electron.mjs --package
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build Jarvis desktop package."
  }

  if ($CreateShortcut) {
    if (-not (Test-Path $jarvisExe)) {
      throw "Packaged Jarvis executable was not found at $jarvisExe"
    }

    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktopPath 'Jarvis.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $jarvisExe
    $shortcut.WorkingDirectory = Split-Path $jarvisExe -Parent
    $shortcut.Description = 'Launch Jarvis'
    $shortcut.Save()
    Write-Host "Created desktop shortcut at $shortcutPath"
  }

  Write-Host "Built Jarvis desktop package:"
  Write-Host "  $jarvisExe"
} finally {
  Pop-Location
}
