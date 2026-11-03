[CmdletBinding()]
param(
    [ValidateSet('Build', 'Test', 'Check')]
    [string]$Task = 'Build',
    [string]$JavaHome,
    [string]$AndroidSdk,
    [string]$BuildRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$repoRoot = Split-Path -Parent $PSScriptRoot

function Get-JdkMajor([string]$Directory) {
    if (-not $Directory -or
        -not (Test-Path -LiteralPath "$Directory/bin/java.exe") -or
        -not (Test-Path -LiteralPath "$Directory/bin/javac.exe") -or
        -not (Test-Path -LiteralPath "$Directory/release")) { return 0 }
    $version = Get-Content -LiteralPath "$Directory/release" |
        Select-String '^JAVA_VERSION="([0-9]+)\.' | Select-Object -First 1
    if ($version) { return [int]$version.Matches[0].Groups[1].Value }
    return 0
}

function Get-PhysicalDirectory([string]$Directory) {
    $item = Get-Item -Force -LiteralPath $Directory
    # Resolve a root junction without rewriting or trusting its existing target.
    while ($item.LinkType -in @('Junction', 'SymbolicLink')) {
        $target = @($item.Target)[0]
        if (-not [IO.Path]::IsPathRooted($target)) {
            $target = Join-Path $item.Parent.FullName $target
        }
        $item = Get-Item -Force -LiteralPath $target
    }
    return $item.FullName.TrimEnd('\', '/')
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This build entry requires Windows PowerShell.' }
    if ($JavaHome) {
        if ((Get-JdkMajor $JavaHome) -lt 17) { throw "JDK 17+ not found at -JavaHome: $JavaHome" }
    } else {
        $jdkCandidates = @(
            (Join-Path $env:USERPROFILE '.local/tools/jdk21-current'),
            $env:JAVA_HOME
        )
        $JavaHome = $jdkCandidates | Where-Object { (Get-JdkMajor $_) -ge 17 } | Select-Object -First 1
        if (-not $JavaHome) { throw 'JDK 17+ is required. Set JAVA_HOME or pass -JavaHome (JDK 21 recommended).' }
    }
    $JavaHome = (Get-Item -LiteralPath $JavaHome).FullName

    $localProperties = Join-Path $repoRoot 'android/local.properties'
    $localSdk = if (Test-Path -LiteralPath $localProperties) {
        $sdkLine = Get-Content -LiteralPath $localProperties |
            Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
        if ($sdkLine) { $sdkLine.Substring(8).Replace('\:', ':').Replace('\\', '\') }
    }
    if ($localSdk -and -not [IO.Path]::IsPathRooted($localSdk)) {
        $localSdk = [IO.Path]::GetFullPath((Join-Path "$repoRoot/android" $localSdk))
    }
    if (-not $AndroidSdk) {
        # Gradle gives sdk.dir priority over environment variables; honor the same pin.
        if ($localSdk) { $AndroidSdk = $localSdk }
        else {
            $AndroidSdk = @(
                (Join-Path $env:USERPROFILE '.local/tools/android-sdk-current'),
                $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT
            ) | Where-Object { $_ -and (Test-Path -LiteralPath "$_/platforms/android-35/android.jar") } |
                Select-Object -First 1
        }
    }
    if (-not $AndroidSdk) { throw 'Android SDK 35 is required. Set ANDROID_HOME or pass -AndroidSdk.' }
    foreach ($component in @('platforms/android-35/android.jar', 'build-tools/35.0.0/aapt2.exe', 'platform-tools/adb.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $AndroidSdk $component))) {
            throw "Missing Android SDK component: $component. Install platforms;android-35, build-tools;35.0.0 and platform-tools."
        }
    }
    $AndroidSdk = (Get-Item -LiteralPath $AndroidSdk).FullName
    if ($localSdk -and ((Get-PhysicalDirectory $localSdk) -ne (Get-PhysicalDirectory $AndroidSdk))) {
        throw "android/local.properties pins sdk.dir=$localSdk. Update that local setting before selecting a different -AndroidSdk."
    }

    if (-not $BuildRoot) {
        $BuildRoot = $repoRoot
        if ($BuildRoot -match '[^\x00-\x7F]') {
            $BuildRoot = Join-Path $env:USERPROFILE '.local/worktrees/gkd-rule-builder-ascii'
        }
    }
    if (-not (Test-Path -LiteralPath $BuildRoot -PathType Container)) {
        throw "ASCII build directory missing: $BuildRoot. Create a directory junction to this repository and pass -BuildRoot. See android/README.md."
    }
    $BuildRoot = (Get-Item -Force -LiteralPath $BuildRoot).FullName
    if ($BuildRoot -match '[^\x00-\x7F]') { throw '-BuildRoot must use an ASCII path (no Chinese characters).' }
    if ((Get-PhysicalDirectory $BuildRoot) -ne (Get-PhysicalDirectory $repoRoot)) {
        throw "-BuildRoot points to another checkout: $BuildRoot. Existing directories will not be changed."
    }
    $pnpm = (Get-Command pnpm -ErrorAction Stop).Source
    $androidRoot = Join-Path $BuildRoot 'android'
    Write-Host "Build directory: $androidRoot"
    Write-Host "JDK: $JavaHome"
    Write-Host "Android SDK: $AndroidSdk"
    if ($Task -eq 'Check') { exit 0 }

    $env:JAVA_HOME = $JavaHome
    $env:ANDROID_HOME = $AndroidSdk
    $env:ANDROID_SDK_ROOT = $AndroidSdk
    Push-Location -LiteralPath $BuildRoot
    try {
        & $pnpm run build:android-assets
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Set-Location -LiteralPath $androidRoot
        $gradleTasks = @('testDebugUnitTest')
        if ($Task -eq 'Build') { $gradleTasks += 'assembleDebug' }
        & .\gradlew.bat @gradleTasks "-Dorg.gradle.java.home=$JavaHome" --console=plain
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if ($Task -eq 'Build') {
            $apk = Join-Path $repoRoot 'android/app/build/outputs/apk/debug/app-debug.apk'
            if (-not (Test-Path -LiteralPath $apk)) { throw "Build did not produce APK: $apk" }
            Write-Host "APK: $apk"
            $hasher = [Security.Cryptography.SHA256]::Create()
            $stream = [IO.File]::OpenRead($apk)
            try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $stream.Dispose(); $hasher.Dispose() }
            Write-Host "SHA256: $hash"
        }
    } finally { Pop-Location }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
