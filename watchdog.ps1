# watchdog.ps1 - 售后系统看门狗
# 功能: 检查服务器是否健康(端口+API响应)，异常时自动重启
# 运行: 通过 manage.ps1 install-watchdog 注册为计划任务(开机自启)

$ServerDir = "d:\Code\Kuaidi\local"
$VbsPath = Join-Path $ServerDir "start-server.vbs"
$LogFile = Join-Path $ServerDir "watchdog.log"
$CheckInterval = 60       # 检查间隔(秒)
$ApiTimeout = 10          # API健康检查超时(秒)
$MaxLogSize = 2MB         # 日志文件最大大小，超过自动轮转

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$now] [$Level] $Message"
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt $MaxLogSize) {
            Rename-Item $LogFile "watchdog.old.log" -Force -ErrorAction SilentlyContinue
        }
        # 使用 StreamWriter 确保在隐藏窗口/计划任务环境中也能写入
        $sw = [System.IO.StreamWriter]::new($LogFile, $true, [System.Text.Encoding]::UTF8)
        $sw.WriteLine($line)
        $sw.Close()
        $sw.Dispose()
    } catch {
        # 最后兜底: 用 cmd 写
        $escaped = $line -replace "'", "''"
        cmd /c "echo $escaped >> `"$LogFile`"" 2>NUL
    }
}

function Test-ServerHealth {
    # 第一层: 检查端口是否在监听
    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) {
        return @{ healthy = $false; reason = "端口3000未监听" }
    }

    $procId = $conn.OwningProcess

    # 第二层: 检查进程是否存活(防御僵尸端口)
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        return @{ healthy = $false; reason = "进程 $procId 不存在" }
    }

    # 第三层: API健康检查(确认Node事件循环未卡死)
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:3000/api/automation/status" -TimeoutSec $ApiTimeout -ErrorAction Stop
        if ($resp -and $resp.success) {
            return @{ healthy = $true; reason = "正常"; pid = $procId; running = $resp.data.running }
        } else {
            return @{ healthy = $false; reason = "API返回异常: $($resp | ConvertTo-Json -Compress)" }
        }
    } catch {
        return @{ healthy = $false; reason = "API无响应: $($_.Exception.Message)" }
    }
}

function Restart-Server {
    Write-Log "正在重启服务器..." "WARN"

    # 先杀掉旧进程(防止端口占用)
    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $oldPid = $conn.OwningProcess
        try {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Write-Log "已终止旧进程 PID $oldPid" "INFO"
        } catch {
            Write-Log "终止旧进程失败: $($_.Exception.Message)" "ERROR"
        }
        Start-Sleep -Seconds 3
    }

    # 通过VBS启动(独立进程)
    cscript $VbsPath 2>&1 | Out-Null
    Start-Sleep -Seconds 5

    # 验证是否启动成功
    $health = Test-ServerHealth
    if ($health.healthy) {
        Write-Log "服务器重启成功 (PID $($health.pid), 引擎运行: $($health.running))" "INFO"
    } else {
        Write-Log "服务器重启失败: $($health.reason)" "ERROR"
    }
}

# ========== 主循环 ==========

Write-Log "看门狗启动 (检查间隔: ${CheckInterval}秒, API超时: ${ApiTimeout}秒)" "INFO"
Write-Log "主循环即将开始" "INFO"

$consecutiveFailures = 0

while ($true) {
    $health = Test-ServerHealth

    if ($health.healthy) {
        if ($consecutiveFailures -gt 0) {
            Write-Log "服务器已恢复正常 (PID $($health.pid))" "INFO"
        }
        $consecutiveFailures = 0
    } else {
        $consecutiveFailures++
        Write-Log "健康检查失败 (${consecutiveFailures}次): $($health.reason)" "WARN"

        # 连续失败才重启(避免偶发网络抖动误杀)
        if ($consecutiveFailures -ge 2) {
            Write-Log "连续 ${consecutiveFailures} 次失败，触发重启" "WARN"
            Restart-Server
            $consecutiveFailures = 0  # 重置计数，给服务器恢复时间
        }
    }

    Start-Sleep -Seconds $CheckInterval
}
