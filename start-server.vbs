' 启动售后系统服务器 - 独立于 TRAE 运行
' 使用 VBScript WScript.Shell 启动，进程不会随父进程关闭而终止

Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("Process")

' 继承用户级环境变量（新设置的环境变量需要显式读取）
On Error Resume Next
WshEnv("KINGSOFT_DOCS_TOKEN") = WshShell.RegRead("HKCU\Environment\KINGSOFT_DOCS_TOKEN")
On Error GoTo 0

' 确保 kdocs-cli 在 PATH 中
WshEnv("PATH") = "C:\Users\hexu\AppData\Local\kdocs-cli;" & WshEnv("PATH")

WshShell.CurrentDirectory = "d:\Code\Kuaidi\local"
WshShell.Run "node server.js", 0, False
Set WshShell = Nothing
