# TC-001..004：只执行真实包装脚本；git/bun 为局部替身，绝不调用外部构建或网络。
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$build = Join-Path $root 'packages/opencode/script/build-win.ps1'
$results = [Collections.Generic.List[object]]::new()
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Test($name, [scriptblock]$body) {
  try { & $body; $results.Add([pscustomobject]@{ Name = $name; Result = 'PASS'; Detail = '' }) }
  catch { $results.Add([pscustomobject]@{ Name = $name; Result = 'FAIL'; Detail = $_.Exception.Message }) }
}
function Invoke-Build($mode = 'ok', $options = @{}, $cache = 'test-model-cache.json') {
  $state = @{ Calls = [Collections.Generic.List[object]]::new(); Git = [Collections.Generic.List[string]]::new() }
  $location = Get-Location
  $encoding = [Console]::OutputEncoding
  $versionBefore = $env:OPENCODE_VERSION
  $cacheBefore = $env:MODELS_DEV_API_JSON
  $exitBefore = Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
  $exitValue = if ($exitBefore) { $exitBefore.Value } else { $null }
  # 函数只存在于当前调用作用域，未知 git 命令一律拒绝。
  function git {
    $command = $args -join ' '
    $state.Git.Add($command)
    $global:LASTEXITCODE = 0
    switch ($command) {
      'rev-parse --show-toplevel' { return $root }
      'remote' { return 'upstream' }
      'fetch upstream' { return }
      'merge-base HEAD upstream/dev' {
        if ($mode -eq 'merge-fail') { $global:LASTEXITCODE = 1; return 'bad-base' }
        if ($mode -eq 'merge-empty') { return '' }
        return 'merged-commit'
      }
      'show merged-commit:packages/opencode/package.json' {
        if ($mode -eq 'show-fail') { $global:LASTEXITCODE = 1; return '{}' }
        if ($mode -eq 'missing') { return '{}' }
        if ($mode -eq 'empty') { return '{"version":""}' }
        if ($mode -eq 'whitespace') { return '{"version":"  "}' }
        if ($mode -eq 'invalid-json') { return '{broken' }
        return '{"version":"1.18.11"}'
      }
      default { throw "Unexpected git invocation: $command" }
    }
  }
  function bun {
    $state.Calls.Add([pscustomobject]@{ Version = $env:OPENCODE_VERSION; Flags = $args -join ' '; Cache = $env:MODELS_DEV_API_JSON })
    $global:LASTEXITCODE = 0
  }
  try {
    $env:OPENCODE_VERSION = 'previous-version'
    $env:MODELS_DEV_API_JSON = $cache
    try { & $build @options | Out-Null; $state.Error = $null }
    catch { $state.Error = $_.Exception.Message }
    return $state
  } finally {
    Set-Location -LiteralPath $location.Path
    [Console]::OutputEncoding = $encoding
    $env:OPENCODE_VERSION = $versionBefore
    $env:MODELS_DEV_API_JSON = $cacheBefore
    if ($exitBefore) { $global:LASTEXITCODE = $exitValue }
    else { Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
  }
}
Test 'TC-002 Parser and parameters' {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($build, [ref]$tokens, [ref]$errors)
  Assert ($errors.Count -eq 0) 'Parser errors'
  $parameters = @($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)
  Assert ($parameters -notcontains 'WinVersion') 'WinVersion still declared'
  Assert ($parameters -contains 'SkipWebUi') 'SkipWebUi removed'
}
Test 'TC-001 original version, repeat and default flags' {
  foreach ($iteration in 1..2) {
    $run = Invoke-Build
    Assert (-not $run.Error) $run.Error
    Assert ($run.Calls.Count -eq 1) 'Expected one bun invocation'
    Assert ($run.Calls[0].Version -ceq '1.18.11') 'Version not preserved'
    Assert ($run.Calls[0].Flags -eq './packages/opencode/script/build.ts --single --skip-embed-web-ui') 'Flags changed'
    Assert ($run.Calls[0].Cache -eq 'test-model-cache.json') 'Cache override lost'
    Assert ($run.Git -contains 'show merged-commit:packages/opencode/package.json') 'Not using merge-base version'
  }
}
Test 'TC-001 SkipWebUi false and default cache' {
  $run = Invoke-Build -options @{ SkipWebUi = $false } -cache ''
  Assert (-not $run.Error) $run.Error
  Assert ($run.Calls.Count -eq 1) 'Expected bun'
  Assert ($run.Calls[0].Flags -eq './packages/opencode/script/build.ts --single') 'SkipWebUi false ignored'
  Assert ($run.Calls[0].Cache -eq 'C:\Users\lshdq\.cache\opencode\models.json') 'Default cache changed'
}
foreach ($mode in 'merge-fail', 'merge-empty', 'show-fail', 'missing', 'empty', 'whitespace', 'invalid-json') {
  Test "TC-003 $mode" {
    $run = Invoke-Build -mode $mode
    Assert ([bool]$run.Error) 'Expected failure'
    Assert ($run.Calls.Count -eq 0) 'Failure invoked bun'
  }
}
Test 'TC-004 skill rules, actual regex and history' {
  $text = [IO.File]::ReadAllText((Join-Path $root '.opencode/skills/win-adapt/SKILL.md'))
  $match = [regex]::Match($text, '\$version -notmatch ''([^'']+)''')
  Assert $match.Success 'Deployment regex not found'
  Assert ('1.18.11' -match $match.Groups[1].Value) 'Upstream version rejected'
  Assert ('1.18.11.w4' -notmatch $match.Groups[1].Value) 'Local suffix accepted'
  $active = ($text -split '## 已知 Windows 问题清单')[0]
  Assert ($active.Contains('git merge-base HEAD upstream/dev')) 'Version source undocumented'
  Assert ($active.Contains('不添加本地后缀') -and $active.Contains('不递增')) 'Version rules inconsistent'
  Assert ($active -notmatch 'WinVersion|\.w\d|\.wN') 'Obsolete active version rules'
  Assert ($active.Contains('$versionOutput = & $source --version')) 'Artifact version read missing'
  Assert ($active.Contains('(Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash')) 'Hash verification missing'
  Assert ($text.Contains('| 1.18.11.w4 |')) 'Historical version removed'
}
$results | Format-Table -AutoSize
if (@($results | Where-Object Result -eq 'FAIL').Count) { throw 'Build version validation failed' }
