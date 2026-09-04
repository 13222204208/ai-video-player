# 在 Windows 上一条命令构建安装包（NSIS .exe）
# 前置依赖：
#   - Git、Node.js 20+、pnpm 10
#   - Visual Studio Build Tools（C++ 桌面开发负载）或 MinGW
#   - CMake
$ErrorActionPreference = "Stop"

Write-Host "==> 安装依赖" -ForegroundColor Cyan
pnpm install

Write-Host "==> 编译 whisper.cpp（whisper-cli.exe / whisper-server.exe）" -ForegroundColor Cyan
pnpm run build:whisper

Write-Host "==> 编译 llama.cpp（llama-server.exe）" -ForegroundColor Cyan
pnpm run build:llama

Write-Host "==> 构建 Windows 安装包" -ForegroundColor Cyan
pnpm run build:win

Write-Host ""
Write-Host "==> 完成，产物在 dist/ 目录：" -ForegroundColor Green
Get-ChildItem "dist\*.exe" | ForEach-Object { Write-Host ("  " + $_.FullName) }
