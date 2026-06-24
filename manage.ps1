# 和旭电商售后系统 - 服务管理脚本
# 用法: 在 PowerShell 中运行 .\manage.ps1
# 参数: .\manage.ps1 start|stop|status|install|uninstall

param([string]$Action = 'menu')

$AppDir = $PSScriptRoot
$VbsPath = Join-Path $AppDir 'start-silent.vbs'
$TaskName = 'HexuKuaidiQuery'
$Port = 3000

function Start-Service {
    Write-Host '`n正在启动服务...' -ForegroundColor Cyan
    if (Test-PortListening) {
        Write-Host '  [!] 服务已在运行中' -ForegroundColor Yellow
        return
    }
    if (Test-Path $VbsPath) {
        Start-Process wscript.exe -ArgumentList "`"$VbsPath`""
    } else {
        Start-Process node -ArgumentList "server.js" -WorkingDirectory $AppDir -WindowStyle Hidden
    }
    Start-Sleep -Seconds 2
    if (Test-PortListening) {
        Write-Host '  [OK] 服务已启动（后台运行）' -ForegroundColor Green
        Write-Host "  局域网访问: http://$(Get-LocalIP):$Port"
    } else {
        Write-Host '  [X] 服务启动失败，请检查 Node.js 是否安装' -ForegroundColor Red
    }
}

function Stop-Service {
    Write-Host '`n正在停止服务...' -ForegroundColor Cyan
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    if ($pids) {
        $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
        Write-Host '  [OK] 服务已停止' -ForegroundColor Green
    } else {
        Write-Host '  [!] 服务未在运行' -ForegroundColor Yellow
    }
}

function Test-PortListening {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Get-LocalIP {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias Wi*,Eth* -ErrorAction SilentlyContinue |
          Select-Object -First 1 -ExpandProperty IPAddress
    return $ip
}

function Show-Status {
    Write-Host "`n端口 $Port 状态:" -ForegroundColor Cyan
    if (Test-PortListening) {
        Write-Host "  [运行中] 服务正在运行" -ForegroundColor Green
        Write-Host "  局域网访问: http://$(Get-LocalIP):$Port"
    } else {
        Write-Host '  [已停止] 服务未运行' -ForegroundColor Yellow
    }
    Write-Host "`n计划任务状态:" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "  [已安装] 开机自启 ($($task.State))" -ForegroundColor Green
    } else {
        Write-Host '  [未安装] 开机自启未配置' -ForegroundColor Yellow
    }
}

function Install-AutoStart {
    Write-Host '`n正在注册开机自启计划任务...' -ForegroundColor Cyan
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$VbsPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Host '  [OK] 开机自启已安装！下次登录时自动启动。' -ForegroundColor Green
}

function Uninstall-AutoStart {
    Write-Host '`n正在移除开机自启计划任务...' -ForegroundColor Cyan
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host '  [OK] 开机自启已移除。' -ForegroundColor Green
}

# 主逻辑
switch ($Action) {
    'start'     { Start-Service }
    'stop'      { Stop-Service }
    'status'    { Show-Status }
    'install'   { Install-AutoStart }
    'uninstall' { Uninstall-AutoStart }
    'menu' {
        Write-Host '========================================' -ForegroundColor Cyan
        Write-Host '  和旭电商售后系统 - 服务管理' -ForegroundColor Cyan
        Write-Host '========================================' -ForegroundColor Cyan
        Write-Host ''
        Write-Host '  [1] 启动服务（后台）'
        Write-Host '  [2] 停止服务'
        Write-Host '  [3] 安装开机自启'
        Write-Host '  [4] 卸载开机自启'
        Write-Host '  [5] 查看服务状态'
        Write-Host '  [0] 退出'
        Write-Host ''
        $choice = Read-Host '请选择操作'
        switch ($choice) {
            '1' { Start-Service }
            '2' { Stop-Service }
            '3' { Install-AutoStart }
            '4' { Uninstall-AutoStart }
            '5' { Show-Status }
            '0' { return }
            default { Write-Host '无效选择' -ForegroundColor Red }
        }
        Write-Host ''
        Read-Host '按回车键退出'
    }
    default { Write-Host "未知操作: $Action。可用: start, stop, status, install, uninstall, menu" -ForegroundColor Red }
}
