# 注意避免的错误实践

### HTTPS协议网络超时问题
- **场景**: 在特定网络环境下，HTTPS连接GitHub可能超时
- **规避方式**: 实现协议自动切换机制，HTTPS失败时尝试SSH
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 两次HTTPS push都失败：`fatal: unable to access 'https://github.com/caifeng123/our_claw.git/': Failed to connect to github.com port 443: Connection timed out`

### 分支同步导致的PR创建失败
- **场景**: 当本地分支已推送到远程且与master无差异时，gh pr create会失败
- **规避方式**: 在创建PR前检查分支差异，或创建新分支
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, `gh pr create`失败：`GraphQL: No commits between master and feat/article-poster-skill`

### 缺少网络故障的优雅降级
- **场景**: 网络连接问题导致整个流程中断
- **规避方式**: 实现网络检测和备用方案，如保存本地提交信息供后续使用
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 网络超时导致push失败，需要手动干预切换协议
