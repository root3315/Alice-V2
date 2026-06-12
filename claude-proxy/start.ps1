# Запуск claude-proxy под Windows PowerShell.
# Использование:  .\start.ps1   (порт 8787 по умолчанию)
param(
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Гарантируем, что ключа нет в окружении -> claude идёт через Max-подписку (OAuth).
$env:ANTHROPIC_API_KEY = ""

# Подхватим .env, если есть (простой парсер KEY=VALUE).
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $kv = $line.Split("=", 2)
            $name = $kv[0].Trim()
            $val = $kv[1].Trim()
            if ($name -ne "ANTHROPIC_API_KEY") {
                Set-Item -Path "env:$name" -Value $val
            }
        }
    }
}

Write-Host "claude-proxy → http://${BindHost}:${Port}  (model=$($env:PROXY_DEFAULT_MODEL))"
python -m uvicorn claude_proxy:app --host $BindHost --port $Port
