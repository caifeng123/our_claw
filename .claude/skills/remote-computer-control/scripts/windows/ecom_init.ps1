<#
.SYNOPSIS
  电商主图生成 - 沙箱初始化脚本
.DESCRIPTION
  1. 创建 input/output 目录
  2. 查询 CDN 获取 input 文件列表并下载
  3. 关闭 Chrome，修改 Profile 下载路径，重启并打开 N 个 Gemini Tab
.PARAMETER TaskId
  任务 ID，用于拼接目录路径和 CDN 查询
.PARAMETER TabCount
  要打开的 Gemini Tab 数量
.EXAMPLE
  .\ecom_init.ps1 -TaskId 'c3090fff' -TabCount 3
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$TaskId,

    [Parameter(Mandatory=$true)]
    [int]$TabCount
)

$ErrorActionPreference = "Stop"

# ── 配置 ──
$CDN_QUERY_URL = "https://ife.bytedance.net/cdn/getCurrentDir"
$CDN_BASE_URL  = "https://lf3-static.bytednsdoc.com/obj/eden-cn/"
$CDN_REGION    = "CN"
$CDN_EMAIL     = "caifeng.nice@bytedance.com"

$Base      = "C:\Users\ecs\Desktop\temp\$TaskId"
$InputDir  = Join-Path $Base "input"
$OutputDir = Join-Path $Base "output"
$CdnDir    = "images/$TaskId/input"

# ── 1. 创建目录 ──
New-Item -ItemType Directory -Force -Path $InputDir  | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# ── 2. 查询 CDN 获取文件列表 ──
$queryParams = "dir=$([uri]::EscapeDataString($CdnDir))&region=$CDN_REGION&email=$([uri]::EscapeDataString($CDN_EMAIL))"
$queryUrl = "$CDN_QUERY_URL`?$queryParams"

try {
    $response = Invoke-RestMethod -Uri $queryUrl -Method Get
} catch {
    exit 1
}

$cdnFullDir = $response.dir
$files = $response.files

if (-not $files -or $files.Count -eq 0) {
    exit 1
}

# ── 3. 下载所有文件到 input 目录 ──
foreach ($file in $files) {
    $url = "$CDN_BASE_URL$cdnFullDir/$file"
    $outPath = Join-Path $InputDir $file
    Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing
}

# ── 4. 关闭 Chrome + 修改 Profile Preferences 下载路径 ──
$chromeProc = Get-Process chrome -ErrorAction SilentlyContinue
if ($chromeProc) {
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$prefsPath = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Preferences"
if (Test-Path $prefsPath) {
    $prefs = Get-Content -Path $prefsPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $prefs.download) {
        $prefs | Add-Member -NotePropertyName 'download' -NotePropertyValue ([PSCustomObject]@{
            default_directory   = $OutputDir
            prompt_for_download = $false
        }) -Force
    } else {
        $prefs.download | Add-Member -NotePropertyName 'default_directory' -NotePropertyValue $OutputDir -Force
        $prefs.download | Add-Member -NotePropertyName 'prompt_for_download' -NotePropertyValue $false -Force
    }

    if (-not $prefs.savefile) {
        $prefs | Add-Member -NotePropertyName 'savefile' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    $prefs.savefile | Add-Member -NotePropertyName 'default_directory' -NotePropertyValue $OutputDir -Force

    $prefs | ConvertTo-Json -Depth 100 -Compress | Set-Content -Path $prefsPath -Encoding UTF8 -NoNewline
}

# ── 5. 启动 Chrome 并一次性打开所有 Gemini Tab ──
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chromePath)) {
    $chromePath = 'chrome'
}

$urls = @('https://gemini.google.com/app') * $TabCount
& $chromePath $urls
