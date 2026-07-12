$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$release = Join-Path $root "release\current"
$tools = Join-Path $root "tools"

# Bundled tool paths
$jdkHome = Join-Path $tools "jdk21\jdk-21.0.11+10"
$gradleHome = Join-Path $tools "gradle\gradle-8.10.2"
$androidSdk = Join-Path $tools "android-sdk"

# Platform detection
if ($IsWindows -or ($env:OS -eq "Windows_NT")) {
  $javaBin = Join-Path $jdkHome "bin\java.exe"
  $gradleBin = Join-Path $gradleHome "bin\gradle.bat"
} else {
  $javaBin = Join-Path $jdkHome "bin\java"
  $gradleBin = Join-Path $gradleHome "bin\gradle"
}

# Verify tools exist
foreach ($path in @($jdkHome, $gradleHome, $androidSdk, $javaBin, $gradleBin)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing bundled tool: $path"
  }
}

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $androidSdk

New-Item -ItemType Directory -Path $release -Force | Out-Null

Write-Host "=== Step 1/4: Build frontend assets for Android ===" -ForegroundColor Cyan
Push-Location $root
try {
  pnpm run build:android-assets
  if ($LASTEXITCODE -ne 0) {
    throw "build:android-assets failed"
  }
} finally {
  Pop-Location
}

Write-Host "=== Step 2/4: Build Android APK ===" -ForegroundColor Cyan
$localProperties = Join-Path $root "android\local.properties"
"sdk.dir=$($androidSdk -replace '\\', '/')" | Out-File -LiteralPath $localProperties -Encoding ascii

Push-Location (Join-Path $root "android")
try {
  $gradleArgs = @(
    "--no-daemon",
    "-Dorg.gradle.java.home=$jdkHome",
    "-Dorg.gradle.appname=gradle",
    "assembleDebug"
  )
  & $gradleBin @gradleArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle build failed"
  }
} finally {
  Pop-Location
}

$apkSource = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path -LiteralPath $apkSource)) {
  throw "APK not found at: $apkSource"
}

Write-Host "=== Step 3/4: Build web dist for portable ===" -ForegroundColor Cyan
Push-Location $root
try {
  pnpm run build
  if ($LASTEXITCODE -ne 0) {
    throw "build failed"
  }
} finally {
  Pop-Location
}

Write-Host "=== Step 4/4: Package to release\current ===" -ForegroundColor Cyan

# Copy APK
$apkTarget = Join-Path $release "GKD-Rule-Studio-Android-0.1.0-debug.apk"
Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
Write-Host "  APK -> $apkTarget" -ForegroundColor Green

# Package portable
$portable = Join-Path $release "GKD-Rule-Studio-Portable-0.1.0"
$template = Join-Path $root "packaging\windows"

if (Test-Path -LiteralPath $portable) {
  Remove-Item -LiteralPath $portable -Recurse -Force
}
New-Item -ItemType Directory -Path $portable -Force | Out-Null

foreach ($name in @("dist", "scripts", "adb")) {
  $target = Join-Path $portable $name
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

Copy-Item -LiteralPath (Join-Path $root "dist") -Destination (Join-Path $portable "dist") -Recurse
New-Item -ItemType Directory -Path (Join-Path $portable "scripts") -Force | Out-Null
foreach ($name in @("adb-helper.mjs", "portable-server.mjs")) {
  Copy-Item -LiteralPath (Join-Path $root "scripts\$name") -Destination (Join-Path $portable "scripts\$name") -Force
}
Copy-Item -LiteralPath (Join-Path $template "adb") -Destination (Join-Path $portable "adb") -Recurse
Copy-Item -LiteralPath (Join-Path $template "runtime") -Destination (Join-Path $portable "runtime") -Recurse
foreach ($name in @("START.cmd", "STOP.cmd")) {
  Copy-Item -LiteralPath (Join-Path $template $name) -Destination (Join-Path $portable $name) -Force
}
Get-ChildItem -LiteralPath $template -Filter "*.txt" -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $portable $_.Name) -Force
}

# Zip portable
$zip = Join-Path $release "GKD-Rule-Studio-Portable-0.1.0.zip"
if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -LiteralPath $portable -DestinationPath $zip -Force
Remove-Item -LiteralPath $portable -Recurse -Force
Write-Host "  Portable -> $zip" -ForegroundColor Green

# Show results
Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Cyan
Get-ChildItem -LiteralPath $release -File | ForEach-Object {
  $sizeKb = [math]::Round($_.Length / 1KB, 1)
  Write-Host "  $($_.Name) ($sizeKb KB)" -ForegroundColor Green
}
