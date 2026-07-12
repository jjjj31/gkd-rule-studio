$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$current = Join-Path $root "release\current"
$portable = Join-Path $current "GKD-Rule-Studio-Portable-0.1.0"
$template = Join-Path $root "packaging\windows"

if (-not (Test-Path -LiteralPath $template)) {
  throw "Missing packaging template: $template"
}

New-Item -ItemType Directory -Path $portable -Force | Out-Null
$portableResolved = (Resolve-Path -LiteralPath $portable).Path
if (-not $portableResolved.StartsWith($current, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unexpected portable path: $portableResolved"
}

foreach ($name in @("dist", "scripts", "adb")) {
  $target = Join-Path $portableResolved $name
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

Copy-Item -LiteralPath (Join-Path $root "dist") -Destination (Join-Path $portableResolved "dist") -Recurse
New-Item -ItemType Directory -Path (Join-Path $portableResolved "scripts") -Force | Out-Null
foreach ($name in @("adb-helper.mjs", "portable-server.mjs")) {
  $sourceScript = Join-Path (Join-Path $root "scripts") $name
  $targetScript = Join-Path (Join-Path $portableResolved "scripts") $name
  Copy-Item -LiteralPath $sourceScript -Destination $targetScript -Force
}
Copy-Item -LiteralPath (Join-Path $template "adb") -Destination (Join-Path $portableResolved "adb") -Recurse
Copy-Item -LiteralPath (Join-Path $template "runtime") -Destination (Join-Path $portableResolved "runtime") -Recurse

foreach ($name in @("START.cmd", "STOP.cmd")) {
  Copy-Item -LiteralPath (Join-Path $template $name) -Destination (Join-Path $portableResolved $name) -Force
}

Get-ChildItem -LiteralPath $template -Filter "*.txt" -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $portableResolved $_.Name) -Force
}

$zip = Join-Path $current "GKD-Rule-Studio-Portable-0.1.0.zip"
if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -LiteralPath $portableResolved -DestinationPath $zip -Force

$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path -LiteralPath $apk) {
  Copy-Item -LiteralPath $apk -Destination (Join-Path $current "GKD-Rule-Studio-Android-0.1.0-debug.apk") -Force
}

Remove-Item -LiteralPath $portableResolved -Recurse -Force
Get-ChildItem -LiteralPath $current -File | Select-Object Name, Length, LastWriteTime
