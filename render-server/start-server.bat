@echo off
title SmartBoard 86 - Node.js Backend Server
cd /d "%~dp0"
echo =========================================
echo SmartBoard 86 Node.js Server ishga tushirilmoqda...
echo Brauzerda http://localhost:3000 ochiladi.
echo Ushbu oynani yopmang!
echo =========================================
start "" http://localhost:3000
node server.js
pause
