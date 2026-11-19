# GKD Rule Studio Workbench 一键启动脚本
$Port = 8899
$Url = "http://127.0.0.1:$Port"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   GKD Rule Studio Workbench · 规则与控件实时调试工作站   " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

# 检查端口是否已被监听
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if ($null -eq $conn) {
    Write-Host "[1/2] 正在启动后台工作站服务 (端口: $Port)..." -ForegroundColor Yellow
    Start-Process -FilePath "node" -ArgumentList "workbench/server.mjs" -WindowStyle Hidden
    Start-Sleep -Seconds 1
} else {
    Write-Host "[1/2] 工作站服务已在运行 (端口: $Port)" -ForegroundColor Green
}

Write-Host "[2/2] 正在打开浏览器工作站: $Url" -ForegroundColor Cyan
Start-Process $Url

Write-Host ""
Write-Host "工作站已成功就绪！浏览器访问地址：" -ForegroundColor Green
Write-Host "$Url" -ForegroundColor Yellow
Write-Host ""
Write-Host "支持功能：" -ForegroundColor Gray
Write-Host "  - 浏览已爬取的 100+ 快照与 115 条已验证真实规则" -ForegroundColor Gray
Write-Host "  - 实时输入 GKD 选择器，毫秒级在真机快照上执行匹配" -ForegroundColor Gray
Write-Host "  - 截图画布高保真绘制命中控件高亮框 (绿) 与官方标准目标 (紫虚线)" -ForegroundColor Gray
Write-Host "  - 支持悬停查看控件属性、点击画布拾取控件并自动填入特征" -ForegroundColor Gray
