$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'build-android.ps1'
# Validate the default junction before creating any fixture through it.
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Task Check | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Build environment preflight failed; no test fixtures were created.' }
$fixtureCheckout = $repoRoot
if ($fixtureCheckout -match '[^\x00-\x7F]') {
    $fixtureCheckout = Join-Path $env:USERPROFILE '.local/worktrees/gkd-rule-builder-ascii'
}
$scratchRoot = Join-Path $fixtureCheckout '.scratch'
$fixtureRoot = Join-Path $scratchRoot ('android-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

function Assert-Check([string]$Name, [string[]]$Arguments, [int]$ExpectedCode, [string]$ExpectedMessage) {
    # Windows PowerShell 5 maps native stderr to error records, including expected failures.
    $ErrorActionPreference = 'Continue'
    $result = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Task Check @Arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne $ExpectedCode -or ($result -join "`n") -notmatch $ExpectedMessage) {
        throw "$Name failed (exit $code): $($result -join '`n')"
    }
    Write-Host "PASS: $Name"
}

try {
    # The wrapper must locate its own checkout even when called from another directory.
    Push-Location -LiteralPath $fixtureRoot
    try { Assert-Check 'foreign working directory' @() 0 'Build directory:.*android' }
    finally { Pop-Location }
    Assert-Check 'missing JDK stops before build' @('-JavaHome', "$fixtureRoot/missing-jdk") 1 'JDK 17\+ not found'
    Assert-Check 'missing SDK stops before build' @('-AndroidSdk', "$fixtureRoot/missing-sdk") 1 'Missing Android SDK component'
    $marker = Join-Path $fixtureRoot 'keep.txt'
    Set-Content -LiteralPath $marker -Value 'preserve-existing-checkout'
    Assert-Check 'another checkout is rejected' @('-BuildRoot', $fixtureRoot) 1 'another checkout'
    if ((Get-Content -LiteralPath $marker) -ne 'preserve-existing-checkout') { throw 'Existing directory was modified.' }
    $unicodeRoot = Join-Path $fixtureRoot ([string][char]0x4e2d)
    New-Item -ItemType Directory -Path $unicodeRoot | Out-Null
    Assert-Check 'Unicode build directory is rejected' @('-BuildRoot', $unicodeRoot) 1 'ASCII path'
} finally {
    $fixtureItem = Get-Item -Force -LiteralPath $fixtureRoot
    if (($fixtureItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $fixtureItem.Parent.FullName -ne (Get-Item -LiteralPath $scratchRoot).FullName) {
        throw 'Refusing to clean outside the task scratch directory.'
    }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
