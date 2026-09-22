# opencode-win 构建包装：直接使用已合入上游的原版本号（如 1.18.11）
# 基准版本 = win-adapt 与 upstream/dev 的 merge-base 处的版本，不随上游推进而变
# 用法:
#   .\packages\opencode\script\build-win.ps1
#   .\packages\opencode\script\build-win.ps1 -SkipWebUi:$false  # 嵌入 Web UI
param(
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

# base = fork 点（merge-base）处的版本，保持与 fork 时原版版本一致
$mergeBase = git merge-base HEAD upstream/dev
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mergeBase)) { throw "Reading upstream merge-base failed" }
$packageJson = git show "${mergeBase}:packages/opencode/package.json"
if ($LASTEXITCODE -ne 0) { throw "Reading upstream package.json failed" }
$version = ($packageJson | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($version)) { throw "Upstream package.json version is missing or empty" }
Write-Output "[build-win] version=$version"

$env:OPENCODE_VERSION = $version
if (-not $env:MODELS_DEV_API_JSON) {
  $env:MODELS_DEV_API_JSON = "C:\Users\lshdq\.cache\opencode\models.json"
}

$flags = @("./packages/opencode/script/build.ts", "--single")
if ($SkipWebUi) { $flags += "--skip-embed-web-ui" }
Write-Output "[build-win] bun $($flags -join ' ')"
bun @flags
