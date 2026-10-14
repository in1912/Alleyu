@echo off
cd /d "%~dp0"
echo Starting Alleyu (You Xiang) on port 9610 ...
node --no-warnings server/index.js
pause
