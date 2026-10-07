@echo off
echo [*] 启动本地服务器 ... 浏览器会自动打开 http://localhost:8080
echo [*] 如果无法正常运行，则需要先安装 Node.js 18+ 后重试： https://nodejs.org
start "" http://localhost:8080/
node "%~dp0serve.mjs" --port 8080
pause
