@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动小站动态博客...
echo 若首次运行，会自动创建 data 目录。
echo.
"C:\Users\Lenovo\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
pause
