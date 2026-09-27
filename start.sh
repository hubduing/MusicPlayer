#!/usr/bin/env sh
# Grooveshelf — оффлайн-плеер (macOS / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 18+ с https://nodejs.org"
  exit 1
fi
exec node server/index.js --open "$@"