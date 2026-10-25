<#
.SYNOPSIS
    Update the project modification timestamp in `最近改动时间.txt`.
    Preserves all file headers, comments, and structure, updating only the timestamp line.
#>
[CmdletBinding()]
param (
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

try {
    $toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $repoRoot = Split-Path -Parent $toolsDir
    $target = Join-Path $repoRoot "最近改动时间.txt"
    if (-not (Test-Path -LiteralPath $target)) {
        $candidateCwd = Join-Path (Get-Location) "最近改动时间.txt"
        if (Test-Path -LiteralPath $candidateCwd) {
            $target = $candidateCwd
        }
    }

    # Beijing time (Asia/Shanghai, UTC+8)
    $beijingTime = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "China Standard Time")
    $nowStr = $beijingTime.ToString("yyyy-MM-dd HH:mm:ss")
    $pattern = '\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2}(:\d{2})?)?'

    # UTF-8 without BOM
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    if (Test-Path -LiteralPath $target) {
        $content = [System.IO.File]::ReadAllText($target, $utf8NoBom)
        if ($content -match $pattern) {
            $newContent = [regex]::Replace($content, $pattern, $nowStr, 1)
        } else {
            $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
            $stripped = $content.TrimEnd("`r`n")
            $newContent = if ($stripped) { $stripped + $newline + $nowStr + $newline } else { $nowStr + $newline }
        }
        [System.IO.File]::WriteAllText($target, $newContent, $utf8NoBom)
    } else {
        $defaultContent = "最近一次项目修改完成时间（北京时间 / Asia/Shanghai）`r`n$nowStr`r`n"
        [System.IO.File]::WriteAllText($target, $defaultContent, $utf8NoBom)
    }

    if (-not $Quiet) {
        Write-Host ("=" * 56)
        Write-Host "  [OK] 成功更新「最近改动时间.txt」"
        Write-Host "  最新修改时间: $nowStr (北京时间 / Asia/Shanghai)"
        Write-Host ("=" * 56)
    }
    exit 0
} catch {
    Write-Error "[ERROR] 更新修改时间失败: $_"
    exit 1
}
