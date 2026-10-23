#!/bin/bash
# Browser smoke test on an isolated in-memory database (never contacts production). Usage: bash scripts/ui-smoke/run.sh "$PWD"  (needs Chrome; set the path inside if different)
# kill whatever listens on 8099 and any harness Chrome, then run on a fresh database and a clean browser profile
S="$(cd "$(dirname "$0")" && pwd)"; REPO="$1"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8099 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*remote-debugging-port=9333*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
sleep 2; rm -rf "$S/out/profile" "$S/server.log"
(node "$S/server.mjs" "$REPO" 8099 > "$S/server.log" 2>&1 &)
for i in $(seq 1 90); do grep -q listening "$S/server.log" 2>/dev/null && break; sleep 1; done
node "$S/drive.mjs" "C:/Program Files/Google/Chrome/Application/chrome.exe" "http://127.0.0.1:8099/" "$S/out" > "$S/run.log" 2>&1
cat "$S/run.log" | cut -c1-250
