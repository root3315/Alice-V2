# Start Alice TTS shim (XTTS-v2 live voice on GPU, free, no API key).
# Sync http.server (NOT uvicorn). Default engine = xtts (fallback edge -> gtts).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as cp1251,
# so non-ASCII (Cyrillic) here breaks the parser. Russian lives in .env-tts / .py.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# XTTS CPML license: agree up-front, else the lib waits for stdin and the server hangs.
$env:COQUI_TOS_AGREED = "1"
# UTF-8 stdio: else printing/logging Cyrillic crashes with UnicodeEncodeError (console = cp1251).
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

# .env-tts can override engine/voice (TTS_PROXY_ENGINE, XTTS_SPEAKER, XTTS_SPEAKER_WAV, XTTS_SPEED ...).
if (Test-Path ".env-tts") {
    Get-Content ".env-tts" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $kv = $line.Split("=", 2)
            Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim()
        }
    }
}

# Python from the XTTS venv (.venv-xtts). If missing -> global Python (edge/gtts only).
$venvPy = Join-Path $PSScriptRoot ".venv-xtts\Scripts\python.exe"
if (Test-Path $venvPy) {
    Write-Host "[start-tts] XTTS venv: $venvPy"
    & $venvPy tts_proxy.py
} else {
    Write-Warning "[start-tts] .venv-xtts not found - running on global Python (xtts unavailable, edge/gtts only)."
    python tts_proxy.py
}
