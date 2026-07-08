# 和旭电商售后系统 - 服务管理脚本
# 用法: 在 PowerShell 中运行 .\manage.ps1
# 参数: .\manage.ps1 start|stop|status|install|uninstall|install-watchdog|uninstall-watchdog|watchdog-log

param([string]$Action = 'menu')

$AppDir = $PSScriptRoot
$VbsPath = Join-Path $AppDir 'start-silent.vbs'
$TaskName = 'HexuKuaidiQuery'
$WatchdogTaskName = 'HexuKuaidiWatchdog'
$WatchdogScript = Join-Path $AppDir 'watchdog.ps1'
$WatchdogLog = Join-Path $AppDir 'watchdog.log'
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
    Write-Host "`n=== 服务状态 ===" -ForegroundColor Cyan
    if (Test-PortListening) {
        $procId = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        Write-Host "  [运行中] PID $procId" -ForegroundColor Green
        Write-Host "  启动时间: $($proc.StartTime)"
        Write-Host "  局域网访问: http://$(Get-LocalIP):$Port"
        # API健康检查
        try {
            $resp = Invoke-RestMethod -Uri "http://localhost:$Port/api/automation/status" -TimeoutSec 5
            if ($resp.success) {
                $d = $resp.data
                if ($d.lastSearchTime) {
                    $lastSearch = [DateTimeOffset]::FromUnixTimeMilliseconds($d.lastSearchTime).LocalDateTime
                } else {
                    $lastSearch = "无"
                }
                if ($d.running) {
                    $engineStatus = "运行中"
                    $engineColor = "Green"
                } else {
                    $engineStatus = "已停止"
                    $engineColor = "Yellow"
                }
                Write-Host "  自动化引擎: $engineStatus" -ForegroundColor $engineColor
                Write-Host "  最后搜索: $lastSearch"
                Write-Host "  已处理: $($d.processedCount) | 待审: $($d.pendingCount) | 拒绝: $($d.stats.totalRejected)"
            }
        } catch {
            Write-Host "  [!] API无响应 (事件循环可能卡死)" -ForegroundColor Red
        }
    } else {
        Write-Host '  [已停止] 服务未运行' -ForegroundColor Yellow
    }

    Write-Host "`n=== 开机自启 ===" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "  [已安装] 服务自启 ($($task.State))" -ForegroundColor Green
    } else {
        Write-Host '  [未安装] 服务开机自启未配置' -ForegroundColor Yellow
    }

    Write-Host "`n=== 看门狗 ===" -ForegroundColor Cyan
    $wdTask = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
    if ($wdTask) {
        Write-Host "  [已安装] 看门狗计划任务 ($($wdTask.State))" -ForegroundColor Green
    } else {
        Write-Host '  [未安装] 看门狗未配置' -ForegroundColor Yellow
    }
    # 检查看门狗进程是否在运行
    $wdProc = Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like '*watchdog.ps1*'
    }
    if ($wdProc) {
        Write-Host "  [运行中] 看门狗进程 PID $($wdProc.Id)" -ForegroundColor Green
    } else {
        $wdProc2 = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
        if ($wdProc2) {
            Write-Host "  [运行中] 看门狗进程 PID $($wdProc2.ProcessId)" -ForegroundColor Green
        } else {
            Write-Host "  [未运行] 看门狗进程未检测到" -ForegroundColor Yellow
        }
    }
    if (Test-Path $WatchdogLog) {
        $logInfo = Get-Item $WatchdogLog
        Write-Host "  日志文件: $WatchdogLog ($([math]::Round($logInfo.Length/1024, 1))KB, 修改于 $($logInfo.LastWriteTime))"
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

function Install-Watchdog {
    Write-Host '`n正在注册看门狗计划任务...' -ForegroundColor Cyan

    # 注册计划任务: 开机登录时自动启动看门狗
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $WatchdogTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    # 立即启动看门狗
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`"" -WindowStyle Hidden

    Write-Host '  [OK] 看门狗已安装并启动！' -ForegroundColor Green
    Write-Host "  检查间隔: 60秒 | 日志: $WatchdogLog" -ForegroundColor Gray
    Write-Host '  看门狗会在服务器异常时自动重启，并在开机时自动运行。' -ForegroundColor Gray
}

function Uninstall-Watchdog {
    Write-Host '`n正在移除看门狗...' -ForegroundColor Cyan

    # 移除计划任务
    Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue

    # 终止运行中的看门狗进程
    $wdProcs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
    if ($wdProcs) {
        $wdProcs | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Write-Host "  [OK] 已终止看门狗进程" -ForegroundColor Green
    }

    Write-Host '  [OK] 看门狗已移除。' -ForegroundColor Green
}

function Show-WatchdogLog {
    Write-Host "`n=== 看门狗日志 (最后20行) ===" -ForegroundColor Cyan
    if (Test-Path $WatchdogLog) {
        Get-Content $WatchdogLog -Tail 20 | ForEach-Object {
            if ($_ -match '\[ERROR\]') { Write-Host $_ -ForegroundColor Red }
            elseif ($_ -match '\[WARN\]') { Write-Host $_ -ForegroundColor Yellow }
            else { Write-Host $_ -ForegroundColor Gray }
        }
    } else {
        Write-Host '  日志文件不存在（看门狗可能尚未运行过）' -ForegroundColor Yellow
    }
}

# 主逻辑
switch ($Action) {
    'start'               { Start-Service }
    'stop'                { Stop-Service }
    'status'              { Show-Status }
    'install'             { Install-AutoStart }
    'uninstall'           { Uninstall-AutoStart }
    'install-watchdog'    { Install-Watchdog }
    'uninstall-watchdog'  { Uninstall-Watchdog }
    'watchdog-log'        { Show-WatchdogLog }
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
        Write-Host '  --- 看门狗 ---'
        Write-Host '  [6] 安装看门狗（开机自启+自动重启）'
        Write-Host '  [7] 卸载看门狗'
        Write-Host '  [8] 查看看门狗日志'
        Write-Host '  [0] 退出'
        Write-Host ''
        $choice = Read-Host '请选择操作'
        switch ($choice) {
            '1' { Start-Service }
            '2' { Stop-Service }
            '3' { Install-AutoStart }
            '4' { Uninstall-AutoStart }
            '5' { Show-Status }
            '6' { Install-Watchdog }
            '7' { Uninstall-Watchdog }
            '8' { Show-WatchdogLog }
            '0' { return }
            default { Write-Host '无效选择' -ForegroundColor Red }
        }
        Write-Host ''
        Read-Host '按回车键退出'
    }
    default { Write-Host "未知操作: $Action。可用: start, stop, status, install, uninstall, install-watchdog, uninstall-watchdog, watchdog-log, menu" -ForegroundColor Red }
}
