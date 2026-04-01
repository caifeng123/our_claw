---
name: article-poster
description: Generate a beautifully designed infographic poster from an article URL or text content. Trigger when user says "article poster", "文章海报", "infographic", "信息图", "make a poster", "生成海报", "visual summary", or requests to convert an article/blog into a shareable image. NOT for generic poster design.
---

# Article Poster

Converts an article (URL or pasted text) into a beautifully designed infographic poster image.

## How It Works

1. **Read the article** — Fetch URL via `link_analyze` or use provided text
2. **Summarize into JSON** — Output a compact JSON data structure (see schema below)
3. **Render & screenshot** — Run `render.py` which injects JSON into `template.html` and screenshots to PNG

This design minimizes token cost: the HTML/CSS template is a static asset (~0 generation tokens). You only generate the JSON content.

## Step 1: Read the Article

- If given a URL: use `link_analyze` to retrieve content
- If given textual or image content: use it directly
- Read and deeply understand the article before summarizing

## Step 2: Save Poster Data as JSON

Write the poster data to `data/temp/posters/poster_data.json` using the Write tool. Do NOT generate a Python script — just write the JSON file directly.

> **IMPORTANT**: Do NOT create a `gen_poster.py` or any intermediate HTML generation script. render.py handles template injection internally. Your only job is to write `poster_data.json`.

Follow this schema **exactly**:

```json
{
  "source": "ANTHROPIC ENGINEERING",
  "category": "HARNESS DESIGN",
  "title": "Harness 设计：突破 Agent 编码前沿的关键架构",
  "subtitle": "Anthropic 用一套受 GAN 启发的多智能体架构……",
  "layout": "single",
  "sections": [
    {
      "number": 1,
      "color": "brown",
      "title": "关键指标",
      "cards": [
        {
          "type": "metric",
          "items": [
            { "value": "3x", "label": "性能提升" },
            { "value": "$200", "label": "单次成本", "desc": "V1 架构下的平均花费" },
            { "value": "6h", "label": "生成耗时" }
          ]
        }
      ]
    },
    {
      "number": 2,
      "color": "olive",
      "title": "核心观点",
      "cards": [
        {
          "type": "quote",
          "text": "核心不是更聪明的单 Agent，而是如何为强模型设计正确的 harness。",
          "author": "Anthropic Engineering Team"
        }
      ]
    },
    {
      "number": 3,
      "color": "teal",
      "title": "框架性能对比",
      "cards": [
        {
          "type": "bar",
          "items": [
            { "label": "Harness V2", "value": 95, "display": "95%" },
            { "label": "Harness V1", "value": 72, "display": "72%" },
            { "label": "Single Agent", "value": 45, "display": "45%" }
          ]
        }
      ]
    },
    {
      "number": 4,
      "color": "amber",
      "title": "规格参数",
      "cards": [
        {
          "type": "table",
          "headers": ["维度", "V1", "V2"],
          "rows": [
            ["耗时", "~6 小时", "~1.5 小时"],
            ["成本", "$200", "$50"],
            ["评估器", "前置", "后置"]
          ]
        }
      ]
    },
    {
      "number": 5,
      "color": "terracotta",
      "title": "架构演进",
      "cards": [
        {
          "type": "timeline",
          "items": [
            { "time": "2024 Q1", "title": "V1 发布", "desc": "三智能体重型架构" },
            { "time": "2024 Q3", "title": "Claude 4.6", "desc": "模型能力跃升，评估器后置" },
            { "time": "2025 Q1", "title": "V2 精简版", "desc": "去掉 Sprint，成本降至 1/4" }
          ]
        }
      ]
    },
    {
      "number": 6,
      "color": "sage",
      "title": "处理流程",
      "cards": [
        {
          "type": "flow",
          "items": [
            { "label": "Planner", "desc": "需求扩展为规格" },
            { "label": "Generator", "desc": "按 Sprint 实现" },
            { "label": "Evaluator", "desc": "Playwright 测试" },
            { "label": "Output", "desc": "交付产物" }
          ]
        }
      ]
    }
  ]
}
```

### JSON Schema Rules

**`layout`** (optional) — Layout mode:
- `"single"`: Single column layout (default)
- `"double"`: Two column layout (odd sections left, even sections right)

**`sections[]`** — Any number of sections based on content needs. Each section has:
- `number`: Display number (1-based)
- `color`: One of `brown`, `olive`, `terracotta`, `teal`, `amber`, `sage`, `slate`, `rose`
- `title`: Section heading (concise, < 20 chars ideal)
- `cards[]`: Array of cards. Card types:

#### Text & Emphasis Cards

| type | fields | description |
|------|--------|-------------|
| `text` | `heading`, `body` | Simple card with title + paragraph |
| `highlight` | `heading`, `body` | Card with colored left border accent |
| `callout` | `label`, `body` | Highlighted callout box with label badge |
| `quote` | `text`, `author?` | Blockquote with large quotation mark and optional author |

#### List & Comparison Cards

| type | fields | description |
|------|--------|-------------|
| `bullets` | `items[]` | Bullet list (supports `**bold:**` prefix) |
| `tags` | `items[{tag, text}]` | Labeled tag + description list |
| `compare` | `left{heading,body}`, `right{heading,body}` | Side-by-side comparison boxes |
| `table` | `headers[]`, `rows[string[]]` | Data table with header row |

#### Data Visualization Cards

| type | fields | description |
|------|--------|-------------|
| `metric` | `items[{value, label, desc?}]` | Large number KPI display (e.g., "3x", "$200", "99.9%") |
| `bar` | `items[{label, value, display?}]` | Horizontal bar chart; `value` is numeric, `display` is the label shown on bar |

#### Structure & Flow Cards

| type | fields | description |
|------|--------|-------------|
| `timeline` | `items[{time?, title, desc?}]` | Vertical timeline with dots and connector line |
| `flow` | `items[{label, desc?}]` | Horizontal flow chart with arrow connectors |

### Content Guidelines

- **Language**: Match the user's language. Default Chinese for Chinese users.
- **Conciseness**: Each `body` should be 1-3 sentences. This is a poster, not a blog.
- **Bold keywords**: Use `**keyword**` for emphasis in body text.
- **Section count**: Use as many sections as needed to cover the content effectively (typically 3-10).
- **Card type selection**: Choose the most expressive card type for each piece of content:
  - Has key numbers → `metric`
  - Has data to compare → `bar` or `table`
  - Has a memorable quote → `quote`
  - Has sequential steps → `flow`
  - Has chronological events → `timeline`
- **Layout**: Choose "single" for focused content or "double" for side-by-side comparison.
- **Chinese punctuation**: Use full-width punctuation for Chinese content (，、。：！？""）.

### Width Selection

Choose width based on layout:
- **narrow** (1080px): Single column, mobile-friendly
- **medium** (1200px): Single or double column, balanced (DEFAULT)
- **wide** (1600px): Double column, desktop-optimized

Height adjusts automatically based on content.

## Step 3: Render to PNG

The `render.py` script and `template.html` are in the same directory. Run with:

```bash
SKILL_DIR="$(dirname "$(readlink -f "$0")")"  # or the known skill install path
cd data/temp/posters && \
python3 "${SKILL_DIR}/render.py" \
  --data poster_data.json \
  --output poster.png \
  --ratio medium
```

> `render.py` auto-detects `template.html` relative to itself — no need to specify `--template`.
>
> **Valid flags**:
> - `--data` (JSON file path, required)
> - `--output` (PNG output path, required)
> - `--ratio` (`narrow` | `medium` | `wide`, default: medium)
> - `--scale` (`1` | `2` | `3`, device scale factor for Retina, default: 2)

If Playwright is not installed, `render.py` will automatically save a `poster.html` file instead and print instructions. Present this file to the user for manual screenshot.

## send poster
return poster image.Use markdown format.for example:
![poster](data/temp/posters/poster.png)

## 调用实践
必须阅读以下内容：
- 最佳实践(iteration/best-practices.md): 最佳实践
- 最差实践(iteration/pitfalls.md): 注意避免的错误实践
