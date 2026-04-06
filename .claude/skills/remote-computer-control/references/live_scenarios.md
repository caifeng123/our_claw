# 直播控制场景

## 开播管理

### 触发指令
- "开播了"、"开始直播"、"开播"

### 常用开播地址映射

以下为预置的常用开播地址，用户可通过**名称/别名**快速指定：

| 名称 | 别名 | 直播地址 |
|------|------|---------|
| funwave泰国 | funwaveth | `https://www.tiktok.com/@funwave2000th/live` |
| funwave越南 | funwavevn | `https://www.tiktok.com/@funwave2000/live` |
| funwave新加坡 | funwavesg | `https://www.tiktok.com/@funwave2000sg/live` |
| funwave马来 | funwavem | `https://www.tiktok.com/@funwave2000my/live` |
| playcc2026泰国 | playcc2026th | `https://www.tiktok.com/@playcc2026/live` |
| playcc2026新加坡 | playcc2026sg | `https://www.tiktok.com/@playcc_sg/live` |
| playcc2026马来 | playcc2026my | `https://www.tiktok.com/@playcc2026my/live` |

> **维护说明**：如需新增常用地址，直接在上方表格追加行即可。

### 执行流程

1. **确认直播 URL**
   - 用户指定了名称/别名：在上方「常用开播地址映射」表中查找匹配项，使用对应 URL
   - 用户未指定或指定的名称不在映射表中：**必须询问用户提供完整的直播 URL，严禁自行编造或猜测地址**
   - 用户直接给出了完整 URL：直接使用该 URL

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
