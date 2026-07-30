#Requires -Version 5.1
# CoMind entry point for native Windows (PowerShell / Windows Terminal).
# All logic lives in comind.js so behaviour is identical on every platform —
# this file only locates it and hands off. Do not add logic here.
#
# With no arguments this runs STAGE 1 (install CoMind itself; your repo is not
# touched). Project setup is stage 2: run /comind-init inside Claude Code.
#
# If PowerShell blocks the script, run:
#   powershell -ExecutionPolicy Bypass -File .\bin\comind-init.ps1

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "comind: Node 18+ is required and was not found on PATH. Install it from https://nodejs.org/ and re-run."
    exit 1
}

& node (Join-Path $PSScriptRoot 'comind.js') @args
exit $LASTEXITCODE
