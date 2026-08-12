@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   一键推送到 GitHub
echo ============================================
echo.

set /p GH_USER=请输入你的 GitHub 用户名: 
set /p GH_REPO=请输入仓库名 (留空默认 lin-quan-xi-blog): 
if "%GH_REPO%"=="" set GH_REPO=lin-quan-xi-blog

set REPO_URL=https://github.com/%GH_USER%/%GH_REPO%.git

echo.
echo 目标仓库: %REPO_URL%
echo.

REM 如果已存在 origin 则更新地址，否则新增
git remote get-url origin >nul 2>&1
if %errorlevel%==0 (
  echo [1/2] 已存在 origin，更新地址...
  git remote set-url origin %REPO_URL%
) else (
  echo [1/2] 添加 origin...
  git remote add origin %REPO_URL%
)

echo [2/2] 推送 main 分支...
git push -u origin main

if %errorlevel%==0 (
  echo.
  echo ============================================
  echo   成功！打开下面的地址查看代码:
  echo   https://github.com/%GH_USER%/%GH_REPO%
  echo ============================================
) else (
  echo.
  echo ============================================
  echo   推送失败，常见原因:
  echo   1. 密码不对: GitHub 已不支持账户密码，
  echo      请用 Personal Access Token 当密码
  echo      (Settings - Developer settings - Tokens)
  echo   2. 仓库非空: 建仓库时勾了 README，
  echo      需先 git pull，或删掉仓库重建(别勾README)
  echo   详见 README.md 部署章节。
  echo ============================================
)
echo.
pause
