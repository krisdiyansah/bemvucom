@echo off
title Bemvu - Personal Finance Ledger
cd /d "%~dp0"
echo Menyalakan server Bemvu di http://localhost:3000 ...
start "" http://localhost:3000
node server.js
pause
