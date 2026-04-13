# project-name Skill 常见陷阱

## 上下文理解

### 多轮对话的意图依赖
- **场景**: 用户消息是对上一轮问题的回答（如"是的私发给我"）
- **规避方式**: 触发 Skill 前，检查 session history 中最近的 assistant 消息，理解完整对话意图
- **证据**:
  - [2026-04-12] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, Trace 2 的 userIntent "没有图片的全体刷新。是的私发给我" 是对 assistant 两个问题的回答，需要上下文才能正确理解意图

## 工具调用顺序

### 避免在图片分析中途插入其他操作
- **场景**: 模式 A 执行时，图片分析是耗时最长的步骤
- **规避方式**: 图片分析应尽早发起，不要在分析中途插入文件读取等操作
- **证据**:
  - [2026-04-12] session=feishu_oc_f3cfca37c21d4cd841d9a2c3e22d0ec4_omt_1abe3faf8c0f9c9e, Trace 3 先调用 analyze_image（144秒），然后才读取实践文档，整体流程符合规范
