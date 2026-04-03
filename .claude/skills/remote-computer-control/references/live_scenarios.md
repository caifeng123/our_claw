# 直播控制场景

## 开播管理

### 触发指令
- "开播了"、"开始直播"、"开播"

### 执行流程

1. **确认直播 URL**
   - 首次使用：询问用户是否使用默认地址 `https://www.tiktok.com/@funwave2000th/live`
   - 已有记录：询问 "使用上次地址（{地址}）还是其他？"
   - 记录最终 URL 到 `data/temp/last_live_url.txt`

2. **编写目标级 Prompt 并执行**
   ```bash
   $SKILL_DIR/scripts/task --prompt "打开 PowerShell，执行 C:\Users\ecs\Desktop\multi.bat {URL}，等待浏览器窗口打开并加载直播页面" --screenshot-dir "$PROJECT_ROOT/data/temp"
   ```

3. **验证**
   用 `Read` 工具查看截图，确认直播页面已正常加载。

4. **发送截图**
   ```
   send_image({ file_path: "<screenshot_path>", alt_text: "开播截图" })
   ```

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| `multi.bat` 不存在 | 通知用户批处理文件缺失，请求确认路径 |
| URL 无效或无法加载 | 发送截图给用户，请求确认正确的直播 URL |
| 浏览器未启动 | 优化 Prompt 使用 `start chrome {URL}` 重试 |

---

## 下播管理

### 触发指令
- "下播"、"关掉浏览器"、"结束直播"

### 执行流程

1. **编写目标级 Prompt 并执行**
   ```bash
   $SKILL_DIR/scripts/task --prompt "打开 PowerShell，执行 C:\Users\ecs\Desktop\kill_chrome.bat 终止所有 Chrome 进程。如果 bat 文件不存在，直接执行 taskkill /F /IM chrome.exe" --screenshot-dir "$PROJECT_ROOT/data/temp"
   ```

2. **验证**
   用 `Read` 工具查看截图，确认桌面上已无 Chrome 窗口。

3. **发送截图**
   ```
   send_image({ file_path: "<screenshot_path>", alt_text: "下播截图" })
   ```

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| `kill_chrome.bat` 不存在 | Prompt 已包含 fallback，自动使用 taskkill |
| 无 Chrome 进程运行 | 通知用户"当前没有运行中的直播浏览器" |
| 部分进程未终止 | 重试一次，仍失败则报告残留进程信息 |
