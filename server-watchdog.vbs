' 和旭电商售后系统 - 自动重启启动器
' node server.js 崩溃后自动重启，stdout/stderr 重定向到日志
' 由任务计划程序运行（wscript），VBS 无限循环同步等待 node 退出
' node 退出(崩溃) -> 等5秒 -> 重新启动，形成自愈

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

workDir = "d:\Code\Kuaidi\local"
logFile = workDir & "\server.log"
WshShell.CurrentDirectory = workDir

' 日志轮转：超过 5MB 备份重建
If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 5242880 Then
        On Error Resume Next
        fso.CopyFile logFile, logFile & ".bak", True
        fso.DeleteFile logFile, True
        On Error GoTo 0
    End If
End If

Do While True
    ' Run 第3个参数 True = 同步等待 node 退出；0 = 隐藏窗口
    ' cmd /c 把 node 的输出重定向到 server.log
    WshShell.Run "cmd /c node server.js >> """ & logFile & """ 2>&1", 0, True
    ' 崩溃后等 5 秒再重启，避免快速崩溃导致狂循环
    WScript.Sleep 5000
Loop
