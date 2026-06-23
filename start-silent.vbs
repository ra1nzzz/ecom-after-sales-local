' 和旭电商退货查询系统 - 无窗口启动脚本
' 使用方法：双击运行或在计划任务中调用
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node d:\Code\Kuaidi\server.js", 0, False
