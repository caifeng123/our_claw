# 电商主图生成最佳实践

### TaskOutput.status="error" 不代表任务失败，需检查 exit_code 和输出内容
- **场景**: ecom 二进制执行完成后，TaskOutput 返回 status="error" 的情况
- **推荐做法**: 不依赖 TaskOutput.status 判断任务成败，而是检查 exit_code（0 表示成功）和输出 JSON 中的 `success` 字段
- **证据**:
  - [2026-04-07] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 1 和 Trace 3 的 TaskOutput.status 都是 "error"，但 exit_code=0，输出 JSON 中 `success:true`，实际任务成功完成

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
