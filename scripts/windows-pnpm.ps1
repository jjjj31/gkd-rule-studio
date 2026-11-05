if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    [Console]::Error.WriteLine('This checkout uses Windows dependencies. Run this script in Windows PowerShell, not WSL.')
    exit 1
}

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    & pnpm @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
