# watch-dog.ps1 - 自动重启售后系统服务器
# 用法: 以管理员身份运行，或在启动时通过任务计划程序调用
# 功能: 检查端口3000是否在监听，如果不在则自动启动服务器

$serverDir = "d:\Code\Kuaidi\local"
$vbsPath = Join-Path $serverDir "start-server.vbs"
$checkInterval = 60  # 检查间隔(秒)

Write-Output "[watchdog] 启动看门狗，检查间隔 ${checkInterval}秒"

while ($true) {
    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) {
        $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Output "[$now] [watchdog] 端口3000未监听，正在启动服务器..."
        
        # 通过VBS启动(独立进程，不随父进程关闭)
        cscript $vbsPath 2>&1 | Out-Null
        Start-Sleep -Seconds 5
        
        # 验证是否启动成功
        $conn2 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        if ($conn2) {
            Write-Output "[$now] [watchdog] 服务器已启动 (PID $($conn2.OwningProcess))"
        } else {
            Write-Output "[$now] [watchdog] 启动失败，将在下个周期重试"
        }
    }
    Start-Sleep -Seconds $checkInterval
}
