@echo off
chcp 65001 >nul
rem 双击启动养鱼面板（Windows）。窗口开着就在跑，关掉就停了。要开机自启可以用任务计划程序或 pm2。
cd /d "%~dp0panel"
where node >nul 2>nul || (echo 没找到 node，先装 Node.js 18 或更新的版本：https://nodejs.org & pause & exit /b 1)
if "%PANEL_PORT%"=="" set PANEL_PORT=8899
start "" http://127.0.0.1:%PANEL_PORT%/
node panel.mjs
pause
