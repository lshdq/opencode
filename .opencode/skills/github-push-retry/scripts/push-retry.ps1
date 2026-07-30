param(
  [string]$RepoDir = (Get-Location).Path,
  [Parameter(Mandatory = $true)]
  [string]$Args,
  [int]$RetryDelaySec = 10,
  [int]$MaxAttempts = 0
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$networkPatterns = @(
  "Could not connect",
  "Connection timed out",
  "Connection refused",
  "Connection reset",
  "Failed to connect",
  "unable to access",
  "Could not resolve host",
  "The requested URL returned error: 503",
  "The requested URL returned error: 502",
  "The requested URL returned error: 500",
  "HTTP 503",
  "HTTP 502",
  "Operation timed out",
  "Network is unreachable",
  "TLS handshake",
  "SSL",
  "EOF",
  "early EOF",
  "the remote end hung up unexpectedly",
  "index-pack failed",
  "RPC failed",
  "transfer closed",
  "broken pipe",
  "timed out"
)

function Test-NetworkError([string]$text) {
  foreach ($p in $networkPatterns) {
    if ($text -like "*$p*") { return $true }
  }
  return $false
}

Set-Location -LiteralPath $RepoDir

$attempt = 0
$infinite = $MaxAttempts -le 0
$limitLabel = $(if ($infinite) { "无限" } else { "$MaxAttempts" })
Write-Output "[push-retry] git push $Args  (上限: $limitLabel, 间隔: ${RetryDelaySec}s)"

while ($true) {
  $attempt++

  $proc = Start-Process -FilePath "git" -ArgumentList "push $Args" -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput "push-out.txt" -RedirectStandardError "push-err.txt"
  $code = $proc.ExitCode
  $out = $(if (Test-Path "push-out.txt") { Get-Content "push-out.txt" -Raw -ErrorAction SilentlyContinue })
  $err = $(if (Test-Path "push-err.txt") { Get-Content "push-err.txt" -Raw -ErrorAction SilentlyContinue })
  Remove-Item "push-out.txt", "push-err.txt" -ErrorAction SilentlyContinue
  $combined = "$out`n$err"

  if ($code -eq 0) {
    Write-Output "[push-retry] 第 $attempt 次推送成功"
    if ($out) { Write-Output $out.Trim() }
    exit 0
  }

  $isNetwork = Test-NetworkError $combined
  if (-not $isNetwork) {
    Write-Output "[push-retry] 第 $attempt 次失败，非网络错误，不重试 (exit code $code)"
    Write-Output $combined.Trim()
    exit 2
  }

  if (-not $infinite -and $attempt -ge $MaxAttempts) {
    Write-Output "[push-retry] 已达上限 $MaxAttempts 次，放弃"
    Write-Output $combined.Trim()
    exit 3
  }

  $snippet = ($combined.Trim() -split "`n" | Select-Object -Last 1)
  Write-Output "[push-retry] 第 $attempt 次网络失败: $snippet"
  Write-Output "[push-retry] ${RetryDelaySec}s 后重试..."
  Start-Sleep -Seconds $RetryDelaySec
}
