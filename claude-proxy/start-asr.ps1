# Start Alice ASR shim (Whisper via faster-whisper; local, free, no API key).
# ASCII-only: Windows PowerShell 5.1 reads .ps1 as cp1251, non-ASCII breaks the parser.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# UTF-8 stdio (Cyrillic transcripts in logs).
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

# Optional overrides (WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE, WHISPER_LANG ...) from .env-tts.
if (Test-Path ".env-tts") {
    Get-Content ".env-tts" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $kv = $line.Split("=", 2)
            Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim()
        }
    }
}

$venvPy = Join-Path $PSScriptRoot ".venv-xtts\Scripts\python.exe"
if (Test-Path $venvPy) {
    Write-Host "[start-asr] venv: $venvPy"
    & $venvPy asr_proxy.py
} else {
    Write-Warning "[start-asr] .venv-xtts not found - using global Python."
    python asr_proxy.py
}
