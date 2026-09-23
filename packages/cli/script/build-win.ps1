#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Bun = 'D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe',
    [switch]$BuildOnly,
    [switch]$NoDeploy,
    [switch]$SkipInstall,
    [string]$DeployRoot = 'D:\Program\opencode'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not (Test-Path -LiteralPath $Bun -PathType Leaf)) { throw "Bun not found: $Bun" }
$version = & $Bun --version
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne '1.4.2') { throw 'Bun 1.4.2 is required' }
$arguments = @((Join-Path $PSScriptRoot 'windows-build.ts'), "--deploy-root=$DeployRoot")
if ($BuildOnly) { $arguments += '--build-only' }
if ($NoDeploy) { $arguments += '--no-deploy' }
if ($SkipInstall) { $arguments += '--skip-install' }
& $Bun @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows build failed (exit $LASTEXITCODE)" }
