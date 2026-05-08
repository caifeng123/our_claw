---
name: feishu-search
version: 1.0.3
description: "飞书云空间统一搜索:搜飞书文档(docx/doc)、Wiki、电子表格(sheet)、多维表格(bitable)、文件夹、附件等云空间对象。当用户说'帮我找一下飞书里的xxx文档/表格/Wiki''搜飞书文档''最近我编辑过的xxx''张三创建的xxx''某个群里分享过的xxx''按标题精确找xxx'等资源发现类需求时触发。本 skill 只负责定位资源(返回标题/URL/token),不负责对象内部读写。"
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli drive +search --help"
---

# feishu-search — 飞书云空间统一搜索

封装 `lark-cli drive +search`(底层 Search v2 接口 `POST /open-apis/search/v2/doc_wiki/search`),把自然语言搜索请求一步映射成命令。

## 1. 何时使用

用户的诉求是"**在飞书里把一个云空间对象找出来**"就用本 skill,涵盖:

- 搜飞书文档(docx/doc)、Wiki、电子表格、多维表格(Base)、幻灯片、文件夹、上传的文件
- "我创建的"、"我编辑过的"、"我评论过的"、"我打开过的"、"最近 N 天的"
- "标题里包含 X"、"评论里提到 X"、"某个群里分享过的 X"、"某人创建/分享的 X"
- 给一段关键词或精确标题,要把它定位到对应文档

> **唯一入口**:用户要搜索任何云空间对象,统一走 `drive +search`。本 skill 不覆盖其他搜索命令。

## 2. 不应使用本 skill 的情况

- 用户已经给了具体 URL / token,要做对象内部读写 → 不属于搜索
- 搜聊天消息、邮件、日程、联系人 → 不属于云空间搜索
- "列出某文件夹下所有文件"这种**遍历**动作 → 用 `lark-cli drive files list`,不是搜索
- 把本地 Excel/CSV/.base 导入成 Base/多维表格 → 用 `lark-cli drive +import --type bitable`

## 3. 必读前置

执行任何搜索命令前,**先读这两个 reference**:

1. [`references/feishu-search-quickstart.md`](references/feishu-search-quickstart.md) — 自然语言 → 命令映射、所有 flag 速查、示例
2. [`references/feishu-search-troubleshoot.md`](references/feishu-search-troubleshoot.md) — 认证 / 权限 / 参数错误处理

## 4. 核心命令

```bash
lark-cli drive +search --query "<关键词>" [扁平 flag...]
```

- 该命令以**用户身份**统一搜索云空间对象(`--as user` 是默认值,不需要显式传)
- 关键词必须放在 `--query` 后,**不要**写成位置参数 `lark-cli drive +search 方案`(`+search` 不接受位置参数,会被静默忽略)
- 所有过滤条件**扁平为独立 flag**(`--mine` / `--edited-since` / `--doc-types` / `--folder-tokens` 等),不要手写 `--filter '{...}'` JSON
- `--query` 可以是空字符串或省略,表示纯靠 filter 浏览(合法)
- 默认只返回第一页;`has_more=true` 且用户明确要继续翻才翻,单轮翻页上限 5 页
- 调试 / 干跑用 `--dry-run`(只打印拼出来的 request,不发出去);客户端二次过滤可以叠 `-q/--jq '<jq 表达式>'`

## 5. 决策树

```
用户说出搜索需求
   │
   ├─ 1) 拆解关键词    → --query "<keyword>"(支持 intitle: / "" / OR / -)
   ├─ 2) 拆解身份维度  → --mine | --creator-ids ou_x | --sharer-ids ou_x
   ├─ 3) 拆解时间维度  → --edited-* | --commented-* | --opened-* | --created-*
   ├─ 4) 拆解作用域    → --doc-types | --folder-tokens | --space-ids | --chat-ids
   ├─ 5) 拆解输出偏好  → --format(json/pretty/table/ndjson/csv) | --page-size | --sort | --jq
   │
   ├─ 6) 实体补全检查
   │     ├─ 提到"某人"非自己 → 先 lark-cli contact +search-user 查 open_id
   │     └─ 提到"某个群"     → 先获取 chat_id
   │
   ├─ 7) 互斥校验
   │     ├─ --mine 和 --creator-ids 不能同时
   │     └─ --folder-tokens 和 --space-ids 不能同时
   │
   ├─ 8) 执行命令,捕获 stderr
   │     ├─ 命令拼不准时先 --dry-run 看一眼实际 request
   │     ├─ 若 stderr 有 hour-snap notice            → 在回复里附带说明
   │     ├─ 若 stderr 有 opened-* 90 天 slice notice → 先呈现 slice 1,问用户是否继续
   │     └─ 若 exit code 非 0                         → 跳到 troubleshoot 处理
   │
   └─ 9) 呈现结果
         ├─ 返回 title / url / type / open_time(ISO)/ creator
         ├─ 用 markdown 链接列出
         └─ has_more=true 时显式提示"还有更多,要继续吗"
```

## 6. 必守的硬约束

1. **关键词永远 `--query`**,不要位置参数
2. **时间表达分两类**:
   - 模糊相对("最近半年"/"最近 30 天") → 直接 `1m`/`30d`/`7d` 等相对值
   - 明确日历表达("上个月"/"今年 3 月") → **必须算成 `YYYY-MM-DD` 绝对边界**(CLI 里 `m` 固定 30 天、`y` 固定 365 天,跟日历会差几天)
3. **`--mine` 优先于 `--creator-ids` 自查**:用户说"我创建的"直接 `--mine`,不要先查自己的 open_id。`--mine` 内部从当前登录用户身份(`runtime.UserOpenId()`)解析 open_id,取不到会直接报错(让用户运行 `lark-cli auth login`)
4. **不在客户端二次精确过滤**:`--query` 的 `intitle:"完整标题"` / `""` / `-` / `OR` 高级语法已能覆盖大部分场景,先把过滤下推服务端
5. **`total` 字段不准**:服务端文档明确说仅供参考。需要精确总数时,按实际拉到的 `results` 长度去重累加,不要把 `total` 当结果数承诺
6. **不要把搜索当对象内部查询**:命中后就停,不要在 `drive +search` 上反复做内容比对
7. **`--sort` 只暴露服务端正式支持的 5 个值**:`default` / `edit_time` / `edit_time_asc` / `open_time` / `create_time`。其他值(如 `create_time_asc` / `entity_create_time_*`)协议已废弃或暂不支持,CLI 会直接拒掉

## 7. 安全 / 合规

- 搜索本身是**只读**操作
- 不输出 `appSecret` / `accessToken` 到终端
- 返回结果里的 `creator` / `sharer` open_id 视为内部标识,不做反向传播到外部系统
- 当用户搜索的关键词疑似涉及凭证/敏感信息时,提醒用户改用更安全的方式分享

## 8. 参考实现命令

```bash
# 关键词检索
lark-cli drive +search --query "Q1 复盘"

# 我编辑过的最近一周表格
lark-cli drive +search --query "" --edited-since 7d --doc-types sheet --format pretty

# 张三上个月创建的 docx(精确日历月)
lark-cli contact +search-user --queries "张三" --format json
lark-cli drive +search --query "" \
  --creator-ids ou_zhangsan_real_id \
  --doc-types docx \
  --created-since 2026-04-01 --created-until 2026-05-01

# 标题精确等于"2026 Q1 OKR"
lark-cli drive +search --query 'intitle:"2026 Q1 OKR"' --format json

# 翻页
lark-cli drive +search --query "OKR" --format json
lark-cli drive +search --query "OKR" --format json --page-token '<上一次返回的 page_token>'
```

更多场景到 [`references/feishu-search-quickstart.md`](references/feishu-search-quickstart.md) 查表。

## 9. 权限

| 操作 | 所需 scope |
|---|---|
| 搜索云空间对象(文档 / Wiki / 表格等资源发现) | `search:docs:read` |

## 调用实践
必须阅读以下内容：
- 最佳实践(iteration/best-practices.md): 最佳实践
- 最差实践(iteration/pitfalls.md): 注意避免的错误实践
