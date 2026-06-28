@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 使用 Node.js 22（better-sqlite3 需要）
set PATH=C:\Users\admin\AppData\Local\nvm\v22.23.1;%PATH%

echo ============================================
echo   WorldX - 启动中...
echo ============================================
echo   客户端: http://localhost:3200
echo   服务端: http://localhost:3100
echo ============================================
echo.

npm run dev
pause