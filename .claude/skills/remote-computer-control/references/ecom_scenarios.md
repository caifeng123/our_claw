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
   - 查阅 `ecom_style_guide.md` 的「角色色彩速查」匹配主题色

3. **产品特征提取**
   - 材质（软胶/透明/金属/亚克力等）
   - 是否有发光功能
   - 尺寸感判断
   - 核心卖点推测

### Step 2：构图决策 + 生成 Prompt

查阅 `references/ecom_style_guide.md`，根据品类匹配构图策略：

- 自动生成 **2-3 个差异化方案**，每个方案对应一段英文 Gemini Prompt
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

### Step 4：调用 ecom 二进制（多 Tab 并行生成）

每个 `--prompt` 对应一个 Chrome Tab，多个方案一次调用并行生图：

```bash
$SKILL_DIR/scripts/build/ecom \
  --images "img1.png,img2.png" \
  --prompt "English prompt for scheme 1" \
  --prompt "English prompt for scheme 2" \
  --prompt "English prompt for scheme 3" \
```

**CLI 参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `--prompt` | 是（至少 1 个） | Gemini prompt，可重复传入多个，每个对应一个 Tab |
| `--images` | 是 | 本地产品图路径，多个用逗号分隔 |

**ecom 二进制内部流程**：

| 阶段 | 步骤 | 目标 | 说明 |
|------|------|------|------|
| 准备 | Step 0 | 上传产品图到 CDN | Go HTTP 直传，非 CUA |
| 准备 | Step 1 | 创建沙箱 input/output 目录 | CUA 执行 PowerShell |
| 准备 | Step 2 | 下载产品图到沙箱 input 目录 | CUA 执行 PowerShell |
| 生图 | Step 3a — 批量提交 | 在 N 个 Tab 中各提交一个 Gemini 请求 | 依次打开 Tab → 新会话 → 上传图 → 选 Create images → 输入 Prompt → 提交，**不等结果直接下一个** |
| 生图 | Step 3b — 批量等待 | 轮询检查所有 Tab 直到全部生成完成 | Ctrl+Tab 循环切换，每个 Tab 滚动检查是否有生成图片（每个 Tab 生成一张） |
| 生图 | Step 3c — 批量下载 | 逐 Tab 保存生成图片到统一 output 目录 | 每个 Tab 保存一张 Gemini 生成图（非上传图），右键另存到 output 目录 |
| 清理 | Step 3d — 关闭 Tab | 关闭所有 Gemini Tab | Ctrl+W 逐个关闭，保留一个空白 Tab 防止 Chrome 退出 |
| 上传 | Step 4 | 通过 upload.mjs 上传 output 到 CDN | CUA 执行 PowerShell |
| 查询 | Step 5 | 查询 CDN 获取生成图 URL | Go HTTP 查询 |

**多 Tab 并行的优势**：
- N 个方案的 Gemini 生成同时进行，总耗时约等于单方案的耗时
- 相比逐方案串行执行（N × 单方案时间），节约约 5 分钟以上

**重试策略**：

| 失败阶段 | 重试方式 | 重试次数 |
|----------|---------|---------|
| 3a 提交失败 | 3a+3b+3c 整体重试 | ≤ 2 次 |
| 3b 等待超时 | 3a+3b+3c 整体重试 | ≤ 2 次 |
| 3c 下载失败 | 仅重试 3c（图已生成） | 先重试 3c 1 次，仍失败则整体重试 |
| 3d 清理失败 | 不重试，仅 stderr 记录 | 非致命，不影响结果 |

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
| Gemini 重试 | 2 次 | 3a+3b 组合失败时整体重试，3c 单独重试 1 次 |

## CUA Prompt 编写约束

以下是已知的 CUA 行为边界 case，Go 代码中的 Prompt builder 已内置这些约束。
如果需要手动编写或调试 Prompt，**必须**包含以下要点：

### 1. 新会话 + 多 Tab（子任务 3a 包含）
每个方案在独立的 Chrome Tab 中执行，每个 Tab 使用全新的 Gemini 会话：
- Tab 1：直接在当前标签页导航到 gemini.google.com，点击 "New chat"
- Tab 2+：通过 Ctrl+T 新开标签页，导航到 gemini.google.com，点击 "New chat"
- 每个 Tab 独立会话，不复用上下文
- 提交 Prompt 后**不等结果**，立即处理下一个 Tab

### 2. 上传图片 + 选择生图模式（子任务 3a 中每个 Tab 都执行）
在每个 Tab 的新会话中，必须依次完成：
- **上传产品图**：点击附件/图片上传按钮，导航到 input 目录，选中目录下**所有**图片文件
- **选择 "Create images" 模式**：点击 "Create images" 选项进入图片生成模式
- 两步都完成后，再在输入框中输入英文 Prompt 并提交
- 如果未选择 "Create images"，Gemini 可能只做文本回复而不生图

### 3. 滚动检查（子任务 3b 包含）
轮询所有 Tab 检查生成状态：
- 使用 Ctrl+Tab 在各 Tab 间循环切换
- 每个 Tab 向下滚动页面，检查是否有一张生成图片出现在 "Show thinking" 下方
- 仍在加载的 Tab 跳过，稍后再来检查
- 所有 Tab 都显示生成完成后结束等待

### 4. 下载各 Tab 生成图片到指定目录（子任务 3c 包含）
逐 Tab 保存 Gemini 生成的图片到统一 output 目录（每个 Tab 一张生成图）：
- **区分上传图和生成图**：上传图在用户消息气泡中（对话顶部，用户头像旁）；生成图在 Gemini 回复区（"Show thinking" 下方，sparkle 图标旁）
- 仅保存 Gemini 生成图，不保存用户上传的产品图
- 右键该生成图 → "Save image as" → 在保存对话框地址栏中**手动输入 output 目录路径**后回车 → 保存
- **不保存到 Downloads 或任何默认文件夹**，必须保存到指定的 output 目录
- 所有 Tab 的生成图都保存到同一个 output 目录
- 全部保存完成后，通过 PowerShell `ls` 验证 output 目录中的文件数量

### 5. 关闭所有 Tab（子任务 3d 包含）
生图完成后清理 Chrome 标签：
- 使用 Ctrl+W 逐个关闭所有 Gemini Tab
- 如果 Chrome 只剩最后一个 Tab，保留一个空白 Tab 避免 Chrome 退出
- 清理失败不影响任务结果（非致命操作）

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 产品图上传 CDN 失败 | 检查网络，通知用户上传失败 |
| 无法识别产品品类 | 按通用策略生成，不阻塞流程 |
| 3a 批量提交失败 | 整体重试 3a+3b+3c（含重试上限 2 次） |
| 3b 等待超时 | 整体重试 3a+3b+3c |
| 3c 下载失败 | 先单独重试 3c 1 次，仍失败则整体重试 |
| 3d 清理 Tab 失败 | 非致命，仅 stderr 记录，不影响结果 |
| 生成结果与 Sanrio 角色不符 | Agent 检查截图，描述偏差，优化 Prompt 中角色描述后重试 |
| upload.mjs 上传失败 | 检查沙箱 Node.js 环境，通知用户 |
| CDN 查询无文件 | 看截图判断 output/ 是否有文件生成 |
| 未选择 Create images 导致纯文本回复 | 重试时确保先点击 Create images 再提交 |
| 部分 Tab 的图片未保存 | 重新切到对应 Tab，补充保存遗漏的图片 |
| 图片保存到错误目录 | 重试 3c，确保在保存对话框中手动输入 output 路径 |
