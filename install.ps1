<#
.SYNOPSIS
    Установка «Волны»: плагин Claude Code + проектная часть в рабочем репозитории.

.DESCRIPTION
    Чистый PowerShell 5.1, без сторонних менеджеров пакетов. Скрипт:
      1) регистрирует маркетплейс «Волны» и ставит плагин через CLI claude (неинтерактивно);
      2) создаёт в рабочем репозитории .volna/project.md и .env из шаблонов;
      3) дописывает .gitignore, чтобы состояние и секреты не уехали в git.
    Запускать можно повторно: существующие файлы не перезаписываются.

.PARAMETER Path
    Рабочий репозиторий, куда кладётся проектная часть. По умолчанию текущий каталог.

.PARAMETER Repo
    GitHub-репозиторий маркетплейса в форме owner/repo.

.PARAMETER Ref
    Ветка или тег для загрузки шаблонов и установки плагина.

.PARAMETER Scope
    Область установки плагина: user (по умолчанию), project или local.

.PARAMETER SkipPlugin
    Не ставить плагин, только создать проектную часть.

.EXAMPLE
    irm https://raw.githubusercontent.com/alex-venediktov/Volna/main/install.ps1 | iex

.EXAMPLE
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/alex-venediktov/Volna/main/install.ps1))) -Path D:\work\my-repo
#>
[CmdletBinding()]
param(
    [string] $Path = (Get-Location).Path,
    [string] $Repo = 'alex-venediktov/Volna',
    [string] $Ref = 'main',
    [ValidateSet('user', 'project', 'local')]
    [string] $Scope = 'user',
    [switch] $SkipPlugin
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 по умолчанию берёт устаревший TLS - без этого raw.githubusercontent недоступен
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$MarketplaceName = 'volna'
$PluginName = 'volna'
$RawBase = "https://raw.githubusercontent.com/$Repo/$Ref"

function Write-Step { param([string] $Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string] $Text) Write-Host "    $Text" -ForegroundColor Green }
function Write-Skip { param([string] $Text) Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Warn { param([string] $Text) Write-Host "    $Text" -ForegroundColor Yellow }

# Файлы пишем UTF-8 без BOM: BOM ломает чтение .env и мешает diff'ам markdown
function Write-Utf8NoBom {
    param([string] $FilePath, [string] $Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FilePath, $Content, $utf8NoBom)
}

# Шаблон берём из локального клона, если скрипт запущен из него; иначе тянем с GitHub
function Get-Template {
    param([string] $RelativePath)
    $localRoot = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
    if ($localRoot) {
        $local = Join-Path $localRoot $RelativePath
        if (Test-Path -LiteralPath $local) { return Get-Content -LiteralPath $local -Raw -Encoding UTF8 }
    }
    $url = "$RawBase/$($RelativePath -replace '\\','/')"
    try {
        return (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
    } catch {
        throw "Не удалось получить шаблон $RelativePath ($url): $($_.Exception.Message)"
    }
}

function Test-Command {
    param([string] $Name)
    return [bool] (Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host 'Волна - установка' -ForegroundColor White
Write-Host "  репозиторий: $Repo ($Ref)"
Write-Host "  рабочий каталог: $Path"
Write-Host ''

# --- 1. Плагин ---------------------------------------------------------------

if ($SkipPlugin) {
    Write-Step 'Плагин: пропущен (-SkipPlugin)'
} elseif (-not (Test-Command 'claude')) {
    Write-Step 'Плагин'
    Write-Warn 'CLI claude не найден в PATH - плагин не установлен.'
    Write-Warn 'Установи Claude Code, затем повтори или выполни внутри сессии:'
    Write-Warn "  /plugin marketplace add $Repo"
    Write-Warn "  /plugin install $PluginName@$MarketplaceName"
} else {
    Write-Step 'Плагин: регистрация маркетплейса'
    $marketplaces = & claude plugin marketplace list 2>&1 | Out-String
    if ($marketplaces -match [regex]::Escape($MarketplaceName)) {
        Write-Skip "маркетплейс '$MarketplaceName' уже добавлен - обновляю"
        & claude plugin marketplace update $MarketplaceName 2>&1 | Out-String | Write-Verbose
    } else {
        & claude plugin marketplace add $Repo 2>&1 | Out-String | Write-Verbose
        if ($LASTEXITCODE -ne 0) { throw "claude plugin marketplace add $Repo завершился с кодом $LASTEXITCODE" }
        Write-Ok "маркетплейс '$MarketplaceName' добавлен"
    }

    Write-Step "Плагин: установка ($Scope)"
    & claude plugin install "$PluginName@$MarketplaceName" --scope $Scope 2>&1 | Out-String | Write-Verbose
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "claude plugin install вернул код $LASTEXITCODE - возможно, плагин уже установлен"
    } else {
        Write-Ok "плагин '$PluginName' установлен"
    }
}

# --- 2. Проектная часть ------------------------------------------------------

Write-Step 'Проектная часть в рабочем репозитории'

if (-not (Test-Path -LiteralPath $Path)) { throw "Каталог не найден: $Path" }
$Path = (Resolve-Path -LiteralPath $Path).Path

if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) {
    Write-Warn "$Path не похож на git-репозиторий - проектная часть всё равно будет создана"
}

$volnaDir = Join-Path $Path '.volna'
foreach ($dir in @($volnaDir, (Join-Path $volnaDir 'journal'), (Join-Path $volnaDir 'knowledge'))) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}
Write-Ok '.volna/{journal,knowledge}'

$indexMd = Join-Path (Join-Path $volnaDir 'knowledge') 'INDEX.md'
if (Test-Path -LiteralPath $indexMd) {
    Write-Skip '.volna/knowledge/INDEX.md уже есть - не тронут'
} else {
    Write-Utf8NoBom $indexMd (Get-Template 'skills/volna-journal/templates/knowledge-index.template.md')
    Write-Ok '.volna/knowledge/INDEX.md создан (пустой указатель по этапам)'
}

$feedbackMd = Join-Path $volnaDir 'feedback.md'
if (Test-Path -LiteralPath $feedbackMd) {
    Write-Skip '.volna/feedback.md уже есть - не тронут'
} else {
    Write-Utf8NoBom $feedbackMd (Get-Template 'skills/volna-journal/templates/feedback.template.md')
    Write-Ok '.volna/feedback.md создан (замечания к флоу с этапа capture)'
}

$projectMd = Join-Path $volnaDir 'project.md'
if (Test-Path -LiteralPath $projectMd) {
    Write-Skip '.volna/project.md уже есть - не тронут'
} else {
    Write-Utf8NoBom $projectMd (Get-Template 'skills/volna-flow/templates/project.template.md')
    Write-Ok '.volna/project.md создан из шаблона - ЗАПОЛНИТЬ команды и конвенции'
}

$envFile = Join-Path $Path '.env'
if (Test-Path -LiteralPath $envFile) {
    Write-Skip '.env уже есть - не тронут'
} else {
    Write-Utf8NoBom $envFile (Get-Template '.env.example')
    Write-Ok '.env создан из шаблона - ЗАПОЛНИТЬ адреса и пути'
}

# --- 3. .gitignore -----------------------------------------------------------

Write-Step '.gitignore'

$ignoreEntries = @(
    '.env',
    '.env.local',
    '.volna/state.json',
    '.volna/journal/',
    '.volna/feedback.md',
    '.volna/project.local.md'
)
$gitignore = Join-Path $Path '.gitignore'
$existing = if (Test-Path -LiteralPath $gitignore) {
    (Get-Content -LiteralPath $gitignore -Encoding UTF8) | ForEach-Object { $_.Trim() }
} else { @() }

$missing = $ignoreEntries | Where-Object { $existing -notcontains $_ }
if ($missing.Count -eq 0) {
    Write-Skip 'все нужные правила уже есть'
} else {
    $block = @('', '# Волна: состояние, журналы и секреты') + $missing
    Add-Content -LiteralPath $gitignore -Value ($block -join "`r`n") -Encoding UTF8
    Write-Ok "дописано правил: $($missing.Count)"
}

# Секреты в .volna/knowledge не место, но сам каталог командный - подсказываем это явно
Write-Skip '.volna/knowledge/ и .volna/project.md - коммитятся (командная часть)'

# --- Итог --------------------------------------------------------------------

Write-Host ''
Write-Host 'Готово. Дальше:' -ForegroundColor White
Write-Host "  1. заполнить $envFile (адрес трекера, PAT-файл, пути репозиториев и эталона)"
Write-Host "  2. заполнить $projectMd (команды сборки и тестов, конвенции)"
Write-Host '  3. в Claude Code:  /volna:doctor   - проверка настроек'
Write-Host '                     /volna:task <id> - взять первую задачу'
Write-Host ''
