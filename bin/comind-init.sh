#!/bin/sh
# CoMind entry point for POSIX shells: macOS, Linux, Git Bash, WSL.
# All logic lives in comind.js so behaviour is identical on every platform —
# this file only locates it and hands off. Do not add logic here.
#
# With no arguments this runs STAGE 1 (install CoMind itself; your repo is not
# touched). Project setup is stage 2: run /comind-init inside Claude Code.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

if ! command -v node >/dev/null 2>&1; then
  echo "comind: Node 18+ is required and was not found on PATH." >&2
  echo "        Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi

exec node "$DIR/comind.js" "$@"
