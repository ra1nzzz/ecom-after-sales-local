@echo off
chcp 65001 >nul
echo ========================================
echo   综合电商售后处理系统 - 服务管理
echo ========================================
echo.
echo  [1] 启动服务（后台窗口）
echo  [2] 停止服务
echo  [3] 安装开机自启
echo  [4] 卸载开机自启
echo  [5] 查看服务状态
echo  [0] 退出
echo.
set /p choice=请选择操作:

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto install
if "%choice%"=="4" goto uninstall
if "%choice%"=="5" goto status
goto end

:start
echo.
echo 正在启动服务...
wscript "d:\Code\Kuaidi\start-silent.vbs"
timeout /t 3 >nul
echo 服务已启动（后台运行）
echo 局域网访问: http://192.168.2.111:3000
goto end

:stop
echo.
echo 正在停止服务...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo 服务已停止
goto end

:install
echo.
echo 正在注册开机自启计划任务...
schtasks /create /tn "HexuKuaidiQuery" /tr "wscript \"d:\Code\Kuaidi\start-silent.vbs\"" /sc onlogon /rl highest /f
echo.
echo 开机自启已安装！下次登录 Windows 时服务将自动启动。
goto end

:uninstall
echo.
echo 正在移除开机自启计划任务...
schtasks /delete /tn "HexuKuaidiQuery" /f 2>nul
echo 开机自启已移除。
goto end

:status
echo.
echo 检查端口 3000...
netstat -aon | findstr :3000 | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
    echo   [运行中] 服务正在运行
    echo   局域网访问: http://192.168.2.111:3000
) else (
    echo   [已停止] 服务未运行
)
echo.
echo 计划任务状态:
schtasks /query /tn "HexuKuaidiQuery" 2>nul || echo   未安装开机自启
goto end

:end
echo.
pause
