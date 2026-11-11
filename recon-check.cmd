@echo off
REM Runs the books-vs-MEXC check now. Set up a daily one with:  node scripts\recon-check.mjs --schedule 08:00
REM Needs backup.config.json with the backup key (and optionally "telegram": {"token","chatId"}). Results: backups\recon-log.jsonl
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & exit /b 1)
node scripts\recon-check.mjs %*
