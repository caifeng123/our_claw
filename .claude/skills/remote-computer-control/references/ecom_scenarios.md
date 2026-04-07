# 电商主图生成场景

## 触发指令
- "做白底主图"、"白底电商图"、"产品图做主图"、"电商主图"、"帮我做电商主图"

## 前置条件
- 用户必须提供至少一张产品图片
- 如未提供图片，**必须向用户索要**，不可跳过

## 执行流程

### 1. 收集产品图
确认用户已附带产品图片（本地路径）。如未提供，提示用户上传。

### 2. Agent 生成英文 Gemini Prompt
根据用户描述，生成英文的 Gemini 生图 Prompt。模板参考：

```
Based on this product image, generate a professional e-commerce product photo with pure white background (#FFFFFF). The product should be centered, well-lit with soft studio lighting, and occupy approximately 80% of the frame. Maintain the original product details, colors, and proportions. Output as high-resolution PNG.
```

如果用户有额外要求（多角度、特定构图、风格偏好），在模板基础上追加。

### 3. 环境初始化
```bash
bash $SKILL_DIR/scripts/start.sh
```

### 4. 调用 ecom 二进制
```bash
$SKILL_DIR/scripts/build/ecom --images "img1.png,img2.png" --prompt "English prompt here"
```

### 5. 解析输出 JSON

```json
{
  "success": true,
  "task_id": "a1b2c3d4",
  "output_image_urls": ["https://..."],
  "duration_sec": 120.5,
  "steps_executed": 25
}
```

| 条件 | 处理方式 |
|------|---------|
| `success=true` + `output_image_urls` 非空 | 展示生成的电商主图给用户 |
| `success=true` + `output_image_urls` 为空 | 用 Read 工具查看 `screenshot`，告知用户 CDN 可能未同步，稍后重试 |
| `success=false` | 报告 `error` 内容，附带截图供用户诊断 |

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 产品图上传 CDN 失败 | 检查网络，通知用户上传失败 |
| Gemini 生图失败（已自动重试 2 次） | 发送截图给用户，建议调整 Prompt 后重试 |
| upload.mjs 上传失败 | 检查沙箱 Node.js 环境，通知用户 |
| CDN 查询无文件 | 看截图判断 output/ 是否有文件生成 |
