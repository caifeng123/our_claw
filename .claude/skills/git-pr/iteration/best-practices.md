# 最佳实践

### 自动网络故障切换机制
- **场景**: 当HTTPS协议连接GitHub失败时，自动切换到SSH协议
- **推荐做法**: 在git push失败后，检查网络连接，如果HTTPS超时但SSH可用，自动开启代理模式
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 当HTTPS push失败后，自动执行`proxy-on`并成功推送
