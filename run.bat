@echo off
rem Token Calendar を開発用の環境から起動する。
rem 初回は依存部品の導入と Electron 本体の取得を自動で行う。
rem 使い方: run.bat          ... 組み立ててから起動
rem         run.bat dev      ... 開発モード（画面の変更がすぐ反映される）
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。Node.js 22.15 以上を入れてください。
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 依存部品を導入しています（初回のみ）...
  call npm ci
  if errorlevel 1 (
    echo [エラー] npm ci に失敗しました。
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron 本体を取得しています（初回のみ）...
  node node_modules\electron\install.js
  if errorlevel 1 (
    echo [エラー] Electron 本体の取得に失敗しました。
    pause
    exit /b 1
  )
)

if /i "%~1"=="dev" (
  call npm run dev
) else (
  call npm run start
)
if errorlevel 1 (
  echo [エラー] 起動に失敗しました。
  pause
  exit /b 1
)
endlocal
