# 电商主图生成场景

## 触发指令
- "做主图"、"电商主图"、"产品图做主图"、"帮我做电商图"

## 前置条件
- 用户必须提供至少一张产品图片
- 如未提供图片，**必须向用户索要**，不可跳过

## 执行流程

### Step 1：视觉分析产品图

Agent 用多模态能力分析用户上传的产品图，输出：

1. **产品品类判断**
   - 潮玩摆件类：光动乐 / 捏捏乐 / 场景摆件 / 盲盒手办
   - 卡通实用物件类：手持风扇 / 卡通手表 / 卡通抓夹 / 其他日用品

2. **角色识别**
   - 识别 Sanrio 角色（Hello Kitty / My Melody / Kuromi / Cinnamoroll 等）

3. **产品特征提取**
   - 材质（软胶/透明/金属/亚克力等）
   - 是否有发光功能
   - 尺寸感判断
   - 核心卖点推测

### Step 2：生成 Prompt
- 自动生成 **2-3 个差异化方案**，每个方案对应一段英文 Gemini Prompt（包含产品特征、角色、特征等, 并且每个方案的构图思路不同）
- 无需展示给用户确认，直接进入生图环节

**方案差异化要求**：
- 至少覆盖该品类的「默认首选」方案
- 其余方案从备选中选取，确保构图思路不同
- 不生成白底方案（除非用户明确要求）

**用户覆盖规则**：
- 如果用户明确指定了构图方式（如"我要平铺"、"做手持图"），直接按用户要求生成 Prompt
- 仍可在用户要求基础上补充 1-2 个其他风格方案

### Step 3：环境初始化

```bash
bash $SKILL_DIR/scripts/start.sh
```

### Step 4：调用 ecom 二进制

```bash
$SKILL_DIR/scripts/build/ecom \
  --images "img1.png,img2.png" \
  --prompt "English prompt for scheme 1" \
  --prompt "English prompt for scheme 2" \
  --prompt "English prompt for scheme 3"
```

**CLI 参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `--prompt` | 是（至少 1 个） | Gemini prompt，可重复传入多个，每个对应一个 Tab |
| `--images` | 是 | 本地产品图路径，多个用逗号分隔 |

**ecom 二进制内部流程**：

| 步骤 | 执行者 | 目标 | 说明 |
|------|--------|------|------|
| Step 0 | Go HTTP | 上传产品图到 CDN | 直传，非 CUA |
| Step 1 | CUA → PowerShell 脚本 | 建目录 + 下载图片 + 设置 Chrome 下载路径 + 开 N 个 Gemini Tab | 调用沙箱内置 `ecom_init.ps1 -TaskId '<id>' -TabCount N`，脚本会自动将 Chrome 默认下载路径设为 output 目录 |
| Step 2a | CUA → Gemini UI | 逐 Tab 上传图 + 提交 prompt | Tab 已由脚本打开，CUA 只需逐 Tab 上传+提交，不等结果 |
| Step 2b | CUA → Gemini UI | 轮询等待生成完成 | Ctrl+Tab 循环切换，每个 Tab 滚动检查（每 Tab 一张图） |
| Step 2c | CUA → Gemini UI | 逐 Tab 用 hover 下载按钮下载生成图 | hover 图片显示浮层按钮 → 点击下载按钮（向下箭头图标），文件自动保存到 output 目录（Chrome 下载路径已由 ecom_init.ps1 预设） |
| Step 2d | CUA → Gemini UI | 关闭所有 Gemini Tab | Ctrl+W 逐个关闭，保留一个空白 Tab（非致命） |
| Step 3 | CUA → PowerShell | upload.mjs 上传 output 到 CDN | `node upload.mjs --dir <cdn_dir> <output>` |
| Step 4 | Go HTTP | 查询 CDN 获取生成图 URL | 查询后输出 JSON 结果 |

**沙箱内置脚本 `ecom_init.ps1`**：

```powershell
C:\Users\ecs\Desktop\tools\ecom_init.ps1 -TaskId '<taskId>' -TabCount <N>
```

脚本职责：
1. 创建 `C:\Users\ecs\Desktop\temp\<TaskId>\input` 和 `output` 目录
2. 通过 CDN 查询接口获取 input 目录文件列表，逐文件下载到沙箱 input 目录
3. 关闭 Chrome → 修改 Chrome Preferences 将默认下载路径设为 output 目录并禁用下载路径询问 → 重新启动 Chrome
4. 循环 `Start-Process chrome` 打开 N 个 gemini.google.com Tab

**重试策略**：

| 失败阶段 | 重试方式 | 重试次数 |
|----------|---------|---------|
| Step 1 脚本失败 | 不重试，直接报错 | 0 |
| 2a 提交失败 | 2a+2b+2c 整体重试 | ≤ 2 次 |
| 2b 等待超时 | 2a+2b+2c 整体重试 | ≤ 2 次 |
| 2c 下载失败 | 仅重试 2c（图已生成） | 先重试 2c 1 次，仍失败则整体重试 |
| 2d 清理失败 | 不重试，仅 stderr 记录 | 非致命，不影响结果 |

### Step 5：汇总展示结果

将所有方案的生成结果统一展示给用户：
- 标注每张图对应哪个构图方案（简要说明）
- 让用户选择满意的结果
- 不满意可指定方向调整 Prompt 重新生成

## 超时配置

| 参数 | 值 | 说明 |
|------|---|------|
| 单任务超时 | 600s | 单个 CUA 子任务的执行上限（可通过环境变量 `CUA_TASK_TIMEOUT` 覆盖） |
| 空闲等待 | 120s | 等待沙箱空闲的上限（可通过环境变量 `CUA_IDLE_WAIT` 覆盖） |
| Gemini 重试 | 2 次 | 2a+2b 组合失败时整体重试，2c 单独重试 1 次 |

## CUA Prompt 编写约束

以下是已知的 CUA 行为边界 case，Go 代码中的 Prompt builder 已内置这些约束。
如果需要手动编写或调试 Prompt，**必须**包含以下要点：

### 1. Tab 已由脚本打开（子任务 2a 前提）
- `ecom_init.ps1` 已打开 N 个 gemini.google.com Tab
- CUA 不需要再开 Tab 或导航到 Gemini
- 直接在已有 Tab 中操作，用 Ctrl+Tab 切换

### 2. 上传图片 + 选择生图模式（子任务 2a 中每个 Tab 都执行）
- **上传产品图**：点击附件/图片上传按钮，在弹出的文件选择对话框中，**在地址栏手动输入 input 目录完整路径**后回车导航，再 Ctrl+A 全选所有图片文件并确认
- **选择 "Create images" 模式**：点击 "Create images" 选项进入图片生成模式
- 两步都完成后，再在输入框中输入英文 Prompt 并提交
- 如果未选择 "Create images"，Gemini 可能只做文本回复而不生图

### 3. 滚动检查（子任务 2b 包含）
轮询所有 Tab 检查生成状态：
- 使用 Ctrl+Tab 在各 Tab 间循环切换
- 每个 Tab 向下滚动页面，检查是否有一张生成图片出现在 "Show thinking" 下方
- 仍在加载的 Tab 跳过，稍后再来检查
- 所有 Tab 都显示生成完成后结束等待

### 4. 用 hover 下载按钮下载生成图（子任务 2c 包含）
逐 Tab 下载 Gemini 生成的高清原图（每个 Tab 一张生成图）：
- **区分上传图和生成图**：上传图在用户消息气泡中（对话顶部，用户头像旁）；生成图在 Gemini 回复区（"Show thinking" 下方，sparkle 图标旁）
- 仅下载 Gemini 生成图，不下载用户上传的产品图
- **hover 生成图**，图片右上角会出现两个浮层按钮（复制和下载），**点击下载按钮**（右侧向下箭头图标）
- **不要使用右键 "Save image as"**——右键保存的是浏览器渲染的缩略图，分辨率低；hover 下载按钮下载的才是高清原图
- Chrome 默认下载路径已由 `ecom_init.ps1` 预设为 output 目录，点击下载后文件**自动保存到 output**，无需手动指定路径
- 所有 Tab 的生成图都自动保存到同一个 output 目录
- 全部下载完成后，通过 PowerShell `ls` 验证 output 目录中的文件数量

### 5. 关闭所有 Tab（子任务 2d 包含）
生图完成后清理 Chrome 标签：
- 使用 Ctrl+W 逐个关闭所有 Gemini Tab
- 如果 Chrome 只剩最后一个 Tab，保留一个空白 Tab 避免 Chrome 退出
- 清理失败不影响任务结果（非致命操作）

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 产品图上传 CDN 失败 | 检查网络，通知用户上传失败 |
| 无法识别产品品类 | 按通用策略生成，不阻塞流程 |
| ecom_init.ps1 脚本执行失败 | 直接报错，不重试 |
| Chrome Preferences 修改失败 | 非致命，脚本会打印 Warning 继续执行；2c 下载时文件可能落到 Downloads，需要注意 |
| 2a 批量提交失败 | 整体重试 2a+2b+2c（含重试上限 2 次） |
| 2b 等待超时 | 整体重试 2a+2b+2c |
| 2c 下载失败 | 先单独重试 2c 1 次，仍失败则整体重试 |
| 2d 清理 Tab 失败 | 非致命，仅 stderr 记录，不影响结果 |
| 生成结果与 Sanrio 角色不符 | Agent 检查截图，描述偏差，优化 Prompt 中角色描述后重试 |
| upload.mjs 上传失败 | 检查沙箱 Node.js 环境，通知用户 |
| CDN 查询无文件 | 看截图判断 output/ 是否有文件生成 |
| 未选择 Create images 导致纯文本回复 | 重试时确保先点击 Create images 再提交 |
| hover 下载按钮不可见/不可点击 | 尝试滚动使图片完全可见后重新 hover；仍失败则 fallback 到右键另存为 |
