# Запуск edge-tts→MiniMax шима (бесплатный голос для Alice).
# Синхронный http.server (НЕ uvicorn) — иначе edge-tts отдаёт NoAudioReceived на Windows.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (Test-Path ".env-tts") {
    Get-Content ".env-tts" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $kv = $line.Split("=", 2)
            Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim()
        }
    }
}
python tts_proxy.py
