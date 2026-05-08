# feishu-search 故障排查与认证

本文件覆盖 `feishu-search` skill 常见的报错与处理流程。**遇到任何非预期 exit 的命令,先到这里查表**。

## 1. 认证相关

### 1.1 错误:"No user logged in" / "auth required"

#### 触发条件
- 第一次跑 `lark-cli drive +search`,从未执行过 `auth login`
- token 文件被删 / 过期
- `LARKSUITE_CLI_CONFIG_DIR` / `LARKSUITE_CLI_DATA_DIR` 指向了空目录

#### 处理流程(Agent)

1. **不要直接报错给用户**,先发起授权:
   ```bash
   lark-cli auth login --scope "search:docs:read"
   ```
   该命令会输出一段授权链接,等用户在浏览器完成
2. **从输出里提取** `verification_uri_complete` 字段(JSON 模式)或 URL 文本
3. **把链接发给用户**,引导其在浏览器打开授权
4. 用户完成后命令自动返回,**重新执行原搜索命令**

### 1.2 `--mine` 报错 "no user open_id"

`--mine` 内部从当前登录用户的 open_id(`runtime.UserOpenId()`)解析 creator;如果取不到会直接报错。引导用户运行 `lark-cli auth login` 完成授权后重试。

## 2. 权限相关

### 2.1 缺少 `search:docs:read` scope

错误片段:
```json
{ "error": { "type": "permission_violations", "permission_violations": [...], "console_url": "...", "hint": "..." } }
```

#### 处理
```bash
lark-cli auth login --scope "search:docs:read"
```
然后从输出抓授权链接发给用户。多次 login 的 scope 是**累积**的,不会覆盖已有的 scope。

### 2.2 错误码 `99992351`(open_id 超出应用通讯录可见范围)

#### 触发场景
`--creator-ids ou_xxx` / `--sharer-ids ou_xxx` 里传了某个 open_id,该用户**不在当前应用的通讯录可见范围**里,服务端拒绝识别。

> **注意**:这和 `search:docs:read` scope **不是一回事**——前者是"应用能看见哪些人",后者是"应用能调用哪个接口"。

#### 处理
- 让管理员在飞书开发者后台 → 应用 → 通讯录可见性,把这些 open_id 加进去
- 或者把超出范围的 open_id 从参数里去掉,先用能看到的人搜

## 3. 参数 / 互斥校验错误

| 错误信息 | 原因 | 修复 |
|---|---|---|
| `--mine and --creator-ids are mutually exclusive` | 两个身份 flag 都传了 | 二选一。"我和某人都创建的"用 `--creator-ids ou_me,ou_other` |
| `--folder-tokens and --space-ids are mutually exclusive` | 同时限定了文件夹和 wiki 空间 | 二选一,二者作用对象不同 |
| `invalid value for --page-size` | 不在 `1-20` 区间或非数字 | 改成 `1-20` 的整数;help 里默认 `15` |
| `invalid value for --doc-types` | 用了不在白名单的类型词 | 见 quickstart §4 的允许值表 |
| `invalid value for --sort` | 用了 `create_time_asc` / `entity_create_time_*` 等已废弃枚举 | 仅用 `default` / `edit_time` / `edit_time_asc` / `open_time` / `create_time` |

## 4. 时间窗口告警(非错误,但需要响应)

### 4.1 `my_edit_time` / `my_comment_time` 小时 snap 通知

**stderr 出现**:
```text
notice: my_edit_time has hour-level granularity server-side;
        start 2026-04-22 16:23:00 → 2026-04-22 16:00:00
        end   2026-04-22 16:28:00 → 2026-04-22 17:00:00
```

这是正常的对齐通知。Agent 在回复用户时**附一句**:"时间已对齐到整点(服务端按小时聚合)"。不需要重跑。

### 4.2 `--opened-*` 90 天裁剪通知

**stderr 出现**:
```text
notice: --opened-* window spans 240 days (~8 months), exceeds the server-side 3-month (90-day) limit.
        this query was narrowed to the most recent slice; 3 slices total:
          [slice 1/3 current] --opened-since ... --opened-until ...
          [slice 2/3]         --opened-since ... --opened-until ...
          [slice 3/3]         --opened-since ... --opened-until ...
        pagination: paginate within a slice via --page-token using that slice's --opened-since / --opened-until values verbatim ...
```

Agent 流程:
1. 呈现 slice 1 的结果
2. 显式告知用户"我先返回了最近 90 天的结果,如果你需要更早的,我可以继续拉 slice 2/3"
3. 用户同意后,**用 notice 里 slice 2 的 `--opened-since`/`--opened-until` 具体时间值,丢掉 `--page-token`**,重新发请求
4. 单 slice 内的翻页:用同一组 slice 时间值 + `--page-token`
5. **绝对不要继续传相对值如 `--opened-since 8m`**,会和 `page_token` 漂移导致结果静默错乱

### 4.3 `--opened-*` 跨度 > 365 天

直接 validation 错。让用户缩小范围(`--opened-since 1y` 之内),或指引拆分多次查询(每次 ≤ 90 天)。

## 5. 结果空 / 不符合预期

| 现象 | 排查 |
|---|---|
| 结果为空,但用户确信有文档 | 1) 确认已 `lark-cli auth login` 完成授权<br>2) 确认登录用户在该文档/空间有权限<br>3) 看是否加了过严的 `--doc-types`,先去掉重试<br>4) 看 `--query` 是否被高级语法误解析(如未配对的 `"`) |
| 标题精确匹配丢失结果 | 改用 `--query 'intitle:"完整标题"'` 而不是 `--only-title` + 关键词。`--only-title` 是"只在标题字段搜",不等于"标题精确等于" |
| `total` 显示 100 但 `results` 只有 15 | 正常。`total` 字段官方说明不准,只看 `results` + `has_more` |
| 分页结果有重复 | 服务端搜索分页有时会有重复;客户端展示时按 `url` / `token` 去重 |
| 高亮标签 `<h>` `<hb>` 出现在标题里 | 客户端展示前剥离这些标签;不要把 `title_highlighted` 直接当标题 |
| `--mine` 不生效 | 检查是否同时传了 `--creator-ids`(互斥);或 `runtime.UserOpenId()` 取不到——重新 `lark-cli auth login` |

## 6. 调试技巧

```bash
# 1. 看当前身份
lark-cli auth status --verify

# 2. 看 search 命令完整 help(确认本机 cli 版本支持哪些 flag)
lark-cli drive +search --help

# 3. 看接口 schema(只读 API,不会改任何东西)
lark-cli schema search.v2.doc_wiki.search --format json

# 4. 用 pretty 格式跑一次最小搜索,确认链路通
lark-cli drive +search --query "test" --page-size 1 --format pretty

# 5. 拼不准参数时干跑——只打印 request,不真的发请求
lark-cli drive +search --query "OKR" --mine --edited-since 7d --dry-run

# 6. 客户端再过滤一层(只保留标题和 url)
lark-cli drive +search --query "OKR" --jq '.results[] | {title, url}'
```

## 7. 安全规则速记

- 搜索是只读操作
- 不要把 `appSecret` / `accessToken` 输出到回复或日志
- 用户搜索关键词疑似含密钥/token 字符串时,提示用户改走更安全渠道
- 返回结果中的 open_id / chat_id / file_token 视为内部标识,**不要把完整列表反向传播到外部系统**(对接外部 webhook / 邮件 / 第三方 API 时尤其注意)
