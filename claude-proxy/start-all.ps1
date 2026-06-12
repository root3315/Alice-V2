# Launch Alice's voice (TTS/XTTS, 5123) and hearing (ASR/whisper, 5124) shims,
# each in its own window. ASCII-only (PS5.1 reads .ps1 as cp1251).
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
Start-Process powershell -ArgumentList '-NoExit', '-File', (Join-Path $here 'start-tts.ps1')
Start-Process powershell -ArgumentList '-NoExit', '-File', (Join-Path $here 'start-asr.ps1')
Write-Host "Started TTS shim (5123) and ASR shim (5124) in separate windows."
Write-Host "Each loads its model into VRAM (~10-20s) before it answers. Then start Alice."
