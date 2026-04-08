---
name: remote-computer-control
description: "远程计算机控制技能。当用户需要在远程桌面上执行操作时触发。支持场景：(1) 开播管理（'开播了'、'开始直播'、'开播'）(2) 下播管理（'下播'、'关掉浏览器'、'结束直播'）(3) 电商图生成（'做主图'、'电商主图'、'产品图'）(4) 通用远程桌面操作（打开应用、浏览网页、文件操作等）。底层通过 Lumi CUA SDK 驱动远程沙箱执行。"
---

# Remote Computer Control

通过 Lumi CUA（Computer Use Agent）SDK 驱动远程 Windows 沙箱，执行用户指定的桌面操作任务。

## 项目结构

```
remote-computer-control/
├── SKILL.md                         # 本文件 — 技能定义与执行规范
├── references/
│   ├── live_scenarios.md            # 直播场景专用流程（开播/下播）
│   ├── ecom_scenarios.md            # 电商主图生成场景
│   └── ecom_style_guide.md          # 电商主图构图策略指南（Sanrio 品类）
└── scripts/
    ├── common/                      # 公共库
    │   ├── cua.go                   #   CUA 初始化、沙箱管理、任务执行
    │   ├── screenshot.go            #   截图保存
    │   ├── cdn.go                   #   CDN 上传 + 查询 + URL 拼接
    │   └── result.go                #   Result 结构、输出、环境变量工具
    ├── task/
    │   └── main.go                  # 通用远程控制
    ├── ecom/
    │   └── main.go                  # 电商主图生成
    ├── build/                       # 编译产物目录（gitignore）
    ├── start.sh                     # 自动扫描 + 增量编译
    ├── go.mod
    └── go.sum
```

---

## 路由决策

收到用户请求后，**先判断意图类别再执行**：

| 意图 | 触发词示例 | 路由目标 |
|------|-----------|---------|
| 开播 | "开播了"、"开始直播"、"开播" | → 读取 `references/live_scenarios.md` 的「开播管理」章节 |
| 下播 | "下播"、"关掉浏览器"、"结束直播" | → 读取 `references/live_scenarios.md` 的「下播管理」章节 |
| 电商主图 | "做主图"、"电商主图"、"产品图做主图"、"帮我做电商图" | → 读取 `references/ecom_scenarios.md` 和 `references/ecom_style_guide.md` |
| 通用控制 | 其他远程操作请求 | → 进入下方「标准执行流程」 |

---

## 标准执行流程

### 1. 环境初始化

```bash
bash $SKILL_DIR/scripts/start.sh
```

自动扫描 `scripts/` 下所有含 `main.go` 的子目录，增量编译到 `scripts/build/`。

### 2. 编写目标级 Prompt 并执行

**核心原则：写目标，不写操作步骤。**

CUA Planner 自身具备将目标拆解为鼠标/键盘操作的能力，Claude 只需描述"最终要达到什么状态"，不要写"点击哪里、输入什么"这种操作级指令。

#### Prompt 编写规则

| 规则 | 说明 |
|------|------|
| **目标导向** | 描述期望的最终状态，而非操作步骤。CUA Planner 会自行规划具体操作 |
| **禁止截图指令** | Prompt 中不允许出现"截图"、"screenshot"字样。截图由 Go 二进制自动完成 |
| **图片使用占位符** | 需要传递图片到远程沙箱的位置写 `{IMAGE_URL}`，由 `--images` 参数传入 CDN URL 替换 |
| **关键约束前置** | 如有特定要求（语言、区域、版本），在 Prompt 开头明确说明 |

#### 示例

**好的 Prompt（目标级）：**
```
打开 Chrome 浏览器，访问 GitHub，搜索 "OpenClaw" 仓库并进入第一个搜索结果的仓库页面。
```

**差的 Prompt（操作级 ❌）：**
```
1: 点击桌面Chrome图标
2: 在地址栏输入 https://github.com
...
```

### 3. 调用 Go 二进制执行

```bash
# 通用场景
$SKILL_DIR/scripts/build/task --prompt "目标级Prompt"

# 含图片时追加 --images 参数
$SKILL_DIR/scripts/build/task --prompt "Prompt含{IMAGE_URL}" --images "/path/to/image.png"
```

**输出 JSON 到 stdout：**
```json
{
  "success": true,
  "screenshot": "data/temp/final_screenshot.png",
  "image_urls": ["https://cdn.example.com/uploaded.png"],
  "duration_sec": 45.2,
  "steps_executed": 8,
  "error": null
}
```

### 4. 结果验证 — 用 Read 工具看截图

**直接用 `Read` 工具读取截图文件，Claude 原生多模态能力即可看到画面内容。**

验证逻辑：

| JSON `success` | 截图判断 | 处理 |
|---|---|---|
| `false` | 不需要看截图 | 执行出错（沙箱故障/超时），直接向用户报告 `error` 内容 |
| `true` | **必须看截图** | `success:true` 仅代表"执行完成没崩溃"，不代表目标达成 |

**当 `success: true` 时，对比截图与用户原始意图：**

- **截图符合用户意图** → 进入步骤 5 发送截图
- **截图不符合用户意图** → 分析偏差原因，优化 Prompt 重试（回到步骤 2，≤3 次）
- **判定无法完成** → 发送截图 + 文字说明原因

### 5. 发送截图给用户

```
send_image({ file_path: "<screenshot_path>", alt_text: "远程桌面截图" })
```

---

## 异常处理

| 场景 | 处理方式 |
|------|---------|
| `success: false` + `error` 非空 | 直接向用户报告错误原因，不截图验证 |
| 沙箱不存在 / 连接失败 | 通知用户"远程沙箱不可用"，建议检查沙箱状态 |
| Planner 服务繁忙 | Go 二进制内部自动等待轮询，超时后 JSON 返回错误 |
| 任务执行超时（>600s） | JSON 返回 `success:false`，向用户报告超时 |
| 需要登录凭证 | 发送截图给用户，请求用户提供登录信息，获取后继续 |
| 图片 CDN 上传失败 | 使用不含图片的 Prompt 继续执行，告知用户图片未传入 |
| `start.sh` / Go 编译失败 | 检查 Go 环境，报告具体错误 |

---

## 性能与限制

- **并发限制**：同一沙箱同时只能执行一个任务
- **远程 OS**：当前仅支持 Windows 沙箱（通过 Lumi CUA ECS 管理）
- **截图验证**：Claude 直接读截图判断，零额外延迟
- **超时配置**：单任务默认 600s，空闲等待默认 120s，均可通过环境变量覆盖

## 调用实践
必须阅读以下内容：
- 最佳实践(iteration/best-practices.md): 最佳实践
- 最差实践(iteration/pitfalls.md): 注意避免的错误实践
