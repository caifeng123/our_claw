# feishu-search 快速参考(quickstart)

> 本文件是 `feishu-search` skill 的执行手册。读完本页应能 1:1 把任意自然语言搜索请求映射成命令。

## 1. 命令骨架

```bash
lark-cli drive +search \
  --query "<关键词,可空字符串>" \
  [身份 flag] [时间 flag] [作用域 flag] [输出 flag]
```

> **底层是 Search v2 接口**:`POST /open-apis/search/v2/doc_wiki/search`,以**用户身份**统一搜索云空间对象。本 skill 不直接拼 JSON,只用扁平 flag。

> **关键约束**:`+search` 不接受位置参数。`lark-cli drive +search 方案` 会被静默忽略;关键词必须通过 `--query` 传入。

## 2. 自然语言 → 命令映射

| 用户原话 | 命令 |
|---|---|
| "找一下飞书里关于'季度复盘'的文档" | `lark-cli drive +search --query "季度复盘"` |
| "搜标题里带'OKR'的飞书文档" | `lark-cli drive +search --query 'intitle:OKR'` |
| "找标题精确叫'2026 Q1 OKR'的文档" | `lark-cli drive +search --query 'intitle:"2026 Q1 OKR"'` |
| "搜'方案 OR 草稿'" | `lark-cli drive +search --query '方案 OR 草稿'` |
| "搜'方案'但排除'草稿'" | `lark-cli drive +search --query '方案 -草稿'` |
| "我创建的所有文档" | `lark-cli drive +search --query "" --mine` |
| "我创建的最近一个月的 docx" | `lark-cli drive +search --query "" --mine --doc-types docx --created-since 1m` |
| "最近一周我编辑过的文档" | `lark-cli drive +search --query "" --edited-since 7d` |
| "最近一个月我编辑过 + 评论过的" | `lark-cli drive +search --query "" --edited-since 1m --commented-since 1m` |
| "最近一周我打开过的表格" | `lark-cli drive +search --query "" --opened-since 7d --doc-types sheet` |
| "我评论过的最近 3 个月的 docx" | `lark-cli drive +search --query "" --commented-since 3m --doc-types docx` |
| "我 30~60 天前创建的"(粗略上个月) | `lark-cli drive +search --query "" --mine --created-since 2m --created-until 1m` |
| "我 2026 年 3 月创建的"(精确日历月) | `lark-cli drive +search --query "" --mine --created-since 2026-03-01 --created-until 2026-04-01` |
| "张三创建的飞书文档" | 先 `lark-cli contact +search-user --queries 张三` 拿 `ou_xxx`<br>再 `lark-cli drive +search --query "" --creator-ids ou_xxx` |
| "张三和李四创建的" | `--creator-ids ou_a,ou_b` |
| "在 fld_abc 文件夹下搜'方案'" | `lark-cli drive +search --query 方案 --folder-tokens fld_abc` |
| "在'研发知识空间'下搜'规范'" | 先拿 `space_id`,再 `--space-ids space_xxx` |
| "群 oc_xxx 里分享过的'方案'" | `lark-cli drive +search --query 方案 --chat-ids oc_xxx` |
| "李四分享过的复盘" | `--sharer-ids ou_lisi` |
| "只搜标题包含'周报'" | `lark-cli drive +search --query 周报 --only-title` |
| "搜评论里提到'延期原因'的文档" | `lark-cli drive +search --query 延期原因 --only-comment` |
| "按编辑时间降序" | 加 `--sort edit_time` |
| "按创建时间降序" | 加 `--sort create_time` |
| "拉原始 JSON 不要修饰" | `--format json`(默认) |
| "给我整齐看看" | `--format pretty` |

## 3. Flag 全表

### 3.1 核心
| Flag | 说明 |
|---|---|
| `--query <text>` | 关键词;支持服务端高级语法:`intitle:`、`""`(精确短语)、`OR`、`-`(排除)。空字符串 `""` 或省略 = 纯靠 filter 浏览(合法) |
| `--page-size <n>` | 范围 `1-20`,默认 `15` |
| `--page-token <token>` | 上一次响应的 `page_token`,用于翻页 |
| `--format` | `json`(默认) / `pretty` / `table` / `ndjson` / `csv` |
| `--as <user\|bot>` | 身份类型,默认 `user`。**搜索基本上只用 `user`**;bot 看不到用户私域文档,切 bot 没意义 |
| `-q, --jq <expr>` | 客户端 jq 表达式,对返回 JSON 二次过滤(只在 `--format json` 下有效) |
| `--dry-run` | 只打印拼出来的 request,**不发出去**。调试拼参时优先用 |

### 3.2 身份(creator 维度)
| Flag | 映射 | 说明 |
|---|---|---|
| `--mine` | `creator_ids = [当前 user open_id]` | 一键"我创建的";内部从 `runtime.UserOpenId()` 取,取不到直接报错(让用户 `lark-cli auth login`)。**与 `--creator-ids` 互斥** |
| `--creator-ids ou_a,ou_b` | `creator_ids = [...]` | open_id 列表,逗号分隔。**与 `--mine` 互斥** |

### 3.3 时间维度(每个维度一对 since/until)
| Flag | 服务端字段 | 是否小时聚合 |
|---|---|---|
| `--edited-since` / `--edited-until` | `my_edit_time` | ✅ start floor 到整点 / end ceil 到整点;CLI 自动 snap 并 stderr 打 notice |
| `--commented-since` / `--commented-until` | `my_comment_time` | ✅ 同上 |
| `--opened-since` / `--opened-until` | `open_time` | ❌ 原样透传;**注意服务端 3 个月(90 天)窗口限制**,见 §6 |
| `--created-since` / `--created-until` | `create_time`(文档创建时间,跟"我"无关) | ❌ |

### 3.4 作用域
| Flag | 映射 | 互斥 |
|---|---|---|
| `--doc-types docx,sheet,bitable,...` | `doc_types`(逗号分隔) | 允许值见 §4 |
| `--folder-tokens fld_a,fld_b` | `folder_tokens`(只发 doc_filter) | **与 `--space-ids` 互斥** |
| `--space-ids sp_x,sp_y` | `space_ids`(只发 wiki_filter) | **与 `--folder-tokens` 互斥** |
| `--chat-ids oc_x` | `chat_ids`(逗号分隔) | — |
| `--sharer-ids ou_x` | `sharer_ids`(逗号分隔,open_id) | — |

### 3.5 其他
| Flag | 映射 | 备注 |
|---|---|---|
| `--only-title` | `only_title: true` | bool;限定搜索范围到标题 |
| `--only-comment` | `only_comment: true` | bool;限定到评论区 |
| `--sort <value>` | `sort_type`(转大写枚举) | 允许值:`default` / `edit_time` / `edit_time_asc` / `open_time` / `create_time`。其他值(如 `create_time_asc` / `entity_create_time_*`)协议已废弃或暂不支持,CLI 会被 cobra enum 校验拒掉 |

## 4. `--doc-types` 允许值

| 值 | 含义 |
|---|---|
| `doc` | 旧版云文档 |
| `sheet` | 电子表格 |
| `bitable` | 多维表格(Base) |
| `mindnote` | 思维导图 |
| `file` | 通用上传文件 |
| `wiki` | 知识库节点 |
| `docx` | 新版云文档 |
| `folder` | 文件夹 |
| `catalog` | 目录 |
| `slides` | 幻灯片 |
| `shortcut` | 快捷方式 |

> 用户口头说"文档"时不要默认补 `docx,doc`——"文档"在中文里常常泛指云空间任意对象。**只有用户明确指定类型词**(表格/Base/Wiki/PPT/思维导图等)才用 `--doc-types` 缩小。

## 5. 时间值格式速查

`--*-since` / `--*-until` 共用以下格式:

| 输入 | 含义 |
|---|---|
| `7d` / `30d` | N 天前的当前时刻 |
| `1m` | 30 天前(**固定 30 天,不是日历月**) |
| `3m` / `6m` | 90 / 180 天前 |
| `1y` | 365 天前 |
| `2026-04-01` | 本地时区 00:00:00 |
| `2026-04-01 10:00:00` 或 `2026-04-01T10:00:00` | 本地时区具体时刻 |
| `2026-04-01T10:00:00+08:00` | RFC3339 带时区 |
| `1743523200`(≥ 10 位纯数字) | Unix 秒,直接透传 |

> `m` 绑定 month(30 天),不支持 minute——因为 `my_edit_time` / `my_comment_time` 在服务端是小时聚合,分钟粒度没意义。

## 6. `--opened-*` 90 天窗口裁剪

服务端对 `open_time` 过滤每次请求**最多支持 3 个月(90 天)窗口**,CLI 在发请求前会检查 `--opened-since` 到有效 `--opened-until`(没传则取 `now`)的跨度并自动裁剪。其他三个时间维度(`--edited-*` / `--commented-*` / `--created-*`)**不受影响**。

| 跨度 | 行为 |
|---|---|
| ≤ 90 天 | 原样透传 |
| 91 ~ 365 天 | **自动裁剪**到"最近一个 90 天 slice",stderr 打一条 notice 列出所有剩余 slice 的 `--opened-since` / `--opened-until` 参数值 |
| > 365 天 | 直接报 validation 错,要求缩小范围或自行拆分多次查询 |

Notice 示例:

```text
notice: --opened-* window spans 240 days (~8 months), exceeds the server-side 3-month (90-day) limit.
        this query was narrowed to the most recent slice; 3 slices total:
          [slice 1/3 current] --opened-since 2026-01-24T21:54:02+08:00 --opened-until 2026-04-24T21:54:02+08:00
          [slice 2/3]         --opened-since 2025-10-26T21:54:02+08:00 --opened-until 2026-01-24T21:54:02+08:00
          [slice 3/3]         --opened-since 2025-08-27T21:54:02+08:00 --opened-until 2025-10-26T21:54:02+08:00
        pagination: paginate within a slice via --page-token using that slice's --opened-since / --opened-until values verbatim (NOT the original relative time like '1y' / '8m' — relative times re-resolve against time.Now() and would mismatch the page_token); switch to the next slice's --opened-* flags only after has_more=false, and do not carry --page-token across slices.
```

### Agent 收到 notice 时的处理顺序

1. **跑 slice 1**(已自动裁剪到这个窗口),把结果呈现给用户
2. **当前 slice 内翻页**:`has_more=true` 时,把 `--opened-since` / `--opened-until` 改为 notice 里 `[slice 1/N current]` 给的**具体时间值**(**不要继续用相对值如 `1y`/`8m`**——CLI 每次调用都按 `time.Now()` 重算窗口,相对值 + `--page-token` 会让 page_token 绑到漂移的窗口上、结果静默失真),加 `--page-token` 翻
3. **当前 slice 翻完**(`has_more=false`)再切到下一个 slice:用 notice 里 `[slice 2/N]` 的 `--opened-*` 值,**`--page-token` 不带**,其他 flag(`--query`、`--doc-types`、`--page-size`、`--sort`……)保持原样
4. 依次递推
5. 用户只对最近一段感兴趣时,跳过 step 3 之后,不做无谓 API 调用

> **`--page-token` 只在单 slice 上下文内有效**,跨 slice 会失效;切 slice 时不要把上一个 slice 的 `page_token` 带过去。

### 注意事项

- `--sort` 在**单 slice 内部**正确;跨 slice 的全局 sort(例如"过去一年我打开过的,按 edit_time desc 排")不被 CLI 保证,需要 agent 自行拉完多个 slice 后在客户端 re-sort 再呈现
- 裁剪只改 request 发出去的 `open_time` 范围,`--query` / 其他 filter 不动
- 最后一个(最老的)slice 常常不足 90 天,这是正常截断

## 7. 小时聚合提示(my_edit_time / my_comment_time)

服务端对这两个字段按整点聚合,亚小时输入会 snap 到整点:

```text
start: floor 到整点   16:23:45 → 16:00:00
end:   ceil  到整点   16:23:45 → 17:00:00
```

发生对齐时,**stderr 会打一条 notice**(stdout JSON 不受影响):

```text
notice: my_edit_time has hour-level granularity server-side;
        start 2026-04-22 16:23:00 → 2026-04-22 16:00:00
        end   2026-04-22 16:28:00 → 2026-04-22 17:00:00
```

呈现给用户时附一句"已对齐到整点(服务端按小时聚合)"即可,不需要重跑。

## 8. 输出结构

### 8.1 `--format json`(默认)

```json
{
  "total": 123,
  "has_more": true,
  "page_token": "AAAA...",
  "results": [
    {
      "result_meta": { "doc_types": "DOCX", "open_time": 1743523200, "open_time_iso": "2025-04-01T16:00:00+08:00" },
      "title": "2026 Q1 OKR",
      "title_highlighted": "2026 Q1 <h>OKR</h>",
      "url": "https://xxx.feishu.cn/docx/doxxxxx",
      "owner_id": "ou_xxx",
      "summary": "...",
      "summary_highlighted": "..."
    }
  ]
}
```

- 所有 `*_time` 字段会**递归补一个 `*_time_iso`**,优先呈现 ISO 形式
- `title_highlighted` / `summary_highlighted` 含 `<h>` / `<hb>` 高亮标签,**直接呈现给用户前先剥离**(否则会出现奇怪标签)
- `total` 仅供参考,**不要承诺为精确总数**(官方明确说明 total 不准)

### 8.2 其他 `--format`

| 值 | 适用场景 |
|---|---|
| `pretty` | 4 列 table:`type \| title \| edit_time \| url`,人类阅读友好 |
| `table` | 紧凑表格输出,终端列对齐 |
| `ndjson` | 每行一个 JSON 对象,适合管道喂给下游脚本 |
| `csv` | 表头 + 行,适合落表/导入 sheet |

### 8.3 客户端 jq 过滤

```bash
# 只看标题和 URL
lark-cli drive +search --query OKR --jq '.results[] | {title, url}'

# 过滤 docx 类型
lark-cli drive +search --query OKR --jq '.results | map(select(.result_meta.doc_types == "DOCX"))'
```

> `--jq` 在 `--format json` 下生效;能下推服务端的过滤(`--doc-types`、`--mine` 等)优先下推,不要全靠客户端 jq。

### 8.4 `--dry-run`

加 `--dry-run` 后命令**只打印拼出的 request**(method、URL、body),不真的发请求。命令拼不准、不知道 flag 翻译成什么 JSON 时优先 `--dry-run` 看一眼。

## 9. 分页策略(强约束)

- 默认只跑一页,把第一页结果 + `has_more` + 下一页命令一起呈现给用户
- 用户明确说"全部 / 全量 / 继续翻 / 完整列表"才继续翻页
- **单轮翻页上限 5 页**(按 `--page-size 20` 约 100 条),到上限报告进度后让用户决定
- 翻页时所有非 page-token flag 保持原样,只新增 `--page-token <值>`

## 10. 推荐结果呈现模板

```markdown
找到 N 条与 "<query>" 相关的飞书云空间对象(第 X 页,还有更多: yes/no):

1. **[2026 Q1 OKR](url)** — docx · 编辑于 2026-04-20 · 创建者:某某
2. **[Q1 复盘表](url)** — sheet · 编辑于 2026-04-22
3. ...

> 还有更多结果,需要继续翻页吗?
> 下一页命令:`lark-cli drive +search --query "..." --page-token "AAAA..."`
```
