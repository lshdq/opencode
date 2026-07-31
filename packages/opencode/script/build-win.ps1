# opencode-win 构建包装：版本号 = <upstream/dev 版本>.w<适配号>（如 1.18.9.w1）
# 用法:
#   .\packages\opencode\script\build-win.ps1                  # 适配号默认 1
#   .\packages\opencode\script\build-win.ps1 -WinVersion 2    # 适配号 2
#   .\packages\opencode\script\build-win.ps1 -SkipWebUi:$false  # 嵌入 Web UI
param(
  [int]$WinVersion = 1,
  [switch]$SkipWebUi = $true
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repo = git rev-parse --show-toplevel
Set-Location -LiteralPath $repo.Trim()

# 确保有 upstream remote
$remotes = git remote
if ($remotes -notcontains "upstream") {
  git remote add upstream https://github.com/anomalyco/opencode.git
}
git fetch upstream

# base = upstream/dev 的 packages/opencode/package.json version
$base = (git show upstream/dev:packages/opencode/package.json | ConvertFrom-Json).version
$version = "$base.w$WinVersion"
Write-Output "[build-win] base=$base  winVersion=$WinVersion  =>  version=$version"

$env:OPENCODE_VERSION = $version
if (-not $env:MODELS_DEV_API_JSON) {
  $env:MODELS_DEV_API_JSON = "C:\Users\lshdq\.cache\opencode\models.json"
}

$flags = @("./packages/opencode/script/build.ts", "--single")
if ($SkipWebUi) { $flags += "--skip-embed-web-ui" }
Write-Output "[build-win] bun $($flags -join ' ')"
bun @flags
