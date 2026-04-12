# 电商主图生成陷阱
### 用户意图可能依赖 session history 上下文
- **场景**: 用户发送的 userIntent 语义不完整（如"是的给手表生成"、"继续"等）
- **规避方式**: 当 userIntent 不完整时，需要加载 session history 获取上下文，理解用户的真实意图
- **证据**:
  - [2026-04-07] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 2 的 userIntent 是 "电商主图，是的给手表生成"，意图不完整，需要结合上下文理解

### 沙箱并发冲突导致"等待 Planner 空闲超时"
- **场景**: 同一沙箱同时执行多个任务
- **规避方式**: 沙箱同一时间只能处理一个任务。当收到"等待 Planner 空闲超时（>2m0s）"错误时，告知用户稍等几分钟后重试，或实现任务队列机制
- **证据**:
  - [2026-04-08] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 5 多次收到 "等待 Planner 空闲超时（>2m0s）" 错误，原因是沙箱正在执行其他任务

### 依赖上下文的用户意图需要 session history
- **场景**: 用户发送"再给我生成4张不一样的"这类依赖上下文的意图
- **规避方式**: 当 userIntent 包含"再"、"不一样"、"继续"等上下文依赖词时，需要加载 session history 获取之前的产品信息和生成记录
- **证据**:
  - [2026-04-08] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 2 的 userIntent 是 "再给我生成4张 不一样的"，需要结合之前生成的三丽鸥手表图片理解意图

### Gemini 内容政策禁止生成未成年人图片
- **场景**: 用户请求生成"小孩"、"儿童"、"未成年人"佩戴产品的人物图片
- **规避方式**: 主动告知用户 Gemini 内容政策限制，推荐替代方案：年轻成人模特（18-25岁）、手腕特写（不展示面部）、产品摆拍图
- **证据**:
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 4 请求"东南亚小孩戴着产品开心"，Gemini 拒绝并返回内容政策限制错误，耗时 43 分钟后失败
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 2 请求"东南亚小孩戴着产品开心"，Gemini 拒绝并返回内容政策限制错误，耗时约 43 分钟

### task 二进制不支持 --screenshot-dir 参数
- **场景**: 调用 task 二进制时误用 `--screenshot-dir` 参数
- **规避方式**: task 二进制仅支持 `--prompt` 和 `--images` 参数，截图路径由 `$PROJECT_ROOT/data/temp` 固定配置，无需手动指定
- **证据**:
  - [2026-04-10] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 5 开播任务第一次调用使用了 `--screenshot-dir` 参数导致 "flag provided but not defined" 错误，移除该参数后成功
