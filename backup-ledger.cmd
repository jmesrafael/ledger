@echo off
REM Runs one ledger backup now. Set up a daily one with:  node scripts\backup-ledger.mjs --schedule 02:30
REM Needs backup.config.json with the backup key (see backup.config.example.json). Results: backups\ folder and backups\backup.log
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & exit /b 1)
node scripts\backup-ledger.mjs %*
