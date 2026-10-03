$ErrorActionPreference = 'Stop'
$bcProjectRoot = Split-Path -Parent $PSScriptRoot
$bcEntry = Join-Path $bcProjectRoot '.dev\launcher.cjs'
$bcIntegration = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.better-codex\run\launch-integration.json') -Raw | ConvertFrom-Json
$bcNode = $bcIntegration.baseCommand[0]
if (-not (Test-Path -LiteralPath $bcNode -PathType Leaf)) { $bcNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $bcNode $bcEntry repair
if ($LASTEXITCODE -ne 0) { throw '接入修复未完成，请查看 .dev 中的开发日志。' }
