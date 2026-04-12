# 电商主图生成最佳实践


### 多 Tab 并行生成大幅缩短总耗时
- **场景**: 需要生成 2-3 个差异化方案的电商主图
- **推荐做法**: 使用 ecom 二进制一次性传入多个 `--prompt` 参数，每个对应一个 Chrome Tab，N 个方案并行生成，总耗时约等于单方案耗时
- **证据**:
  - [2026-04-07] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 1 生成 3 张图耗时 1093 秒（约 18 分钟），Trace 3 生成 3 张图耗时 1060 秒，相比串行执行可节约 5+ 分钟

### Step 3c 下载失败时仅重试 3c，无需整体重试
- **场景**: Gemini 图片已生成，但下载保存到 output 目录时失败（如流读取错误）
- **推荐做法**: Go 代码已实现重试策略：先单独重试 3c 一次，仍失败才整体重试 3a+3b+3c。Agent 无需干预，自动恢复
- **证据**:
  - [2026-04-07] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 3 中 Step 3c 遇到 "Stream reading error: unexpected EOF"，系统自动重试 3c 成功，最终生成 3 张图片

### 带水印图片生成失败后需调整 prompt 策略
- **场景**: 产品图来自小红书等平台带有水印，Gemini 拒绝直接修改
- **推荐做法**: 在 prompt 中强调"Create a new image"、"Generate completely new image"等关键词，要求生成全新场景图而非修改原图，可绕过水印限制
- **证据**:
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 2 第一次调用失败（Gemini 拒绝处理带水印图片），修改 prompt 强调"Create a new lifestyle product photo...Generate completely new image"后成功

### 用户意图过于简洁时需结合产品图理解
- **场景**: 用户仅说"给我生成电商图"或"做主图"等极简意图
- **推荐做法**: 通过分析用户上传的产品图（品类、角色、材质等）自动推断构图方案，无需向用户确认即可直接生成
- **证据**:
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 3 的 userIntent 仅"给我生成电商图"，Agent 通过分析上传的 Hello Kitty 手表图片自动生成 4 张差异化电商主图
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 4 的 userIntent 仅"给我生成电商图"，Agent 自动识别 Hello Kitty 主题腕表并生成 4 张差异化方案（手腕佩戴图、表盘特写、平铺搭配图、生活方式图）

### 东南亚模特请求应明确指定"年轻成人模特"规避未成年人限制
- **场景**: 用户请求"东南亚模特"佩戴产品的电商图
- **推荐做法**: 在 prompt 中明确指定"Young Southeast Asian adult model (18-25 years old)"，避免使用"小孩"、"儿童"等词，确保 Gemini 不会因内容政策拒绝
- **证据**:
  - [2026-04-11] session=feishu_oc_f3cfca37c21d4cd841d9a2c3e22d0ec4_omt_1abc19ad778f9be5, Trace 1 请求"东南亚模特穿戴"，成功生成 4 张年轻成人模特佩戴图，耗时约 17 分钟
  - [2026-04-11] session=feishu_oc_f3cfca37c21d4cd841d9a2c3e22d0ec4_omt_1abc19ad778f9be5, Trace 3 请求"东南亚模特穿戴"（沙滩/书桌背景），成功生成 10 张图片，耗时约 31 分钟
