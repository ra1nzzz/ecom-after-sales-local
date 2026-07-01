' 启动售后系统服务器 - 独立于 TRAE 运行
' 使用 VBScript WScript.Shell 启动，进程不会随父进程关闭而终止

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "d:\Code\Kuaidi\local"
WshShell.Run "node server.js", 0, False
Set WshShell = Nothing
