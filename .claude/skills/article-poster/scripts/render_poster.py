#!/usr/bin/env python3
"""
render_poster.py — All-in-one poster renderer.

Reads data/temp/posters/poster_data.json, outputs data/temp/posters/[poster_name].png.
All paths resolved relative to project root (walks up looking for .claude/).

Usage:
  python3 {SKILL_PATH}/scripts/render_poster.py [poster_name].png [--ratio medium] [--scale 2]
"""

import argparse
import json
import sys
from pathlib import Path

RATIO_SIZES = {
    "narrow":  (1080, None),
    "medium":  (1200, None),
    "wide":    (1600, None),
}

REQUIRED_FIELDS = ["source", "category", "title", "subtitle", "sections"]
REQUIRED_SECTION_FIELDS = ["number", "color", "title", "cards"]
VALID_COLORS = {"brown", "olive", "terracotta", "teal", "amber", "sage", "slate", "rose"}
VALID_CARD_TYPES = {
    "text", "highlight", "tags", "compare", "bullets", "callout",
    "metric", "quote", "table", "bar", "timeline", "flow",
}


def find_project_root() -> Path:
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def validate_data(data):
    errors = []
    for field in REQUIRED_FIELDS:
        if field not in data:
            errors.append(f"Missing required top-level field: '{field}'")
    if "sections" in data:
        if not isinstance(data["sections"], list) or len(data["sections"]) == 0:
            errors.append("'sections' must be a non-empty array")
        else:
            for i, section in enumerate(data["sections"]):
                prefix = f"sections[{i}]"
                for field in REQUIRED_SECTION_FIELDS:
                    if field not in section:
                        errors.append(f"{prefix}: missing required field '{field}'")
                if section.get("color") and section["color"] not in VALID_COLORS:
                    errors.append(f"{prefix}: invalid color '{section['color']}', must be one of {VALID_COLORS}")
                if "cards" in section:
                    if not isinstance(section["cards"], list):
                        errors.append(f"{prefix}: 'cards' must be an array")
                    else:
                        for j, card in enumerate(section["cards"]):
                            card_prefix = f"{prefix}.cards[{j}]"
                            if "type" not in card:
                                errors.append(f"{card_prefix}: missing 'type'")
                            elif card["type"] not in VALID_CARD_TYPES:
                                errors.append(f"{card_prefix}: invalid type '{card['type']}', must be one of {sorted(VALID_CARD_TYPES)}")
    if "layout" in data and data["layout"] not in ("single", "double"):
        errors.append(f"Invalid layout '{data['layout']}', must be 'single' or 'double'")
    if errors:
        raise ValueError("JSON validation failed:\n  - " + "\n  - ".join(errors))


def main():
    parser = argparse.ArgumentParser(
        description="Render article poster to PNG",
        usage="render_poster.py <name>.png [--ratio medium] [--scale 2]",
    )
    parser.add_argument("output", help="Output PNG filename (e.g. my-poster.png)")
    parser.add_argument("--ratio", default="medium", choices=RATIO_SIZES.keys(), help="Width preset (default: medium)")
    parser.add_argument("--scale", type=int, default=2, choices=[1, 2, 3], help="Device scale factor (default: 2)")
    args = parser.parse_args()

    # --- Resolve all paths ---
    project_root = find_project_root()
    poster_dir = project_root / "data" / "temp" / "posters"
    poster_dir.mkdir(parents=True, exist_ok=True)

    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    template_path = skill_dir / "template.html"
    data_path = poster_dir / "poster_data.json"
    output_path = poster_dir / args.output

    if not template_path.exists():
        print(f"ERROR: template.html not found at {template_path}", file=sys.stderr)
        sys.exit(1)

    if not data_path.exists():
        print(f"ERROR: poster_data.json not found at {data_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[render_poster] Project root: {project_root}")
    print(f"[render_poster] Data file:    {data_path}")
    print(f"[render_poster] Output file:  {output_path}")

    # --- Read and validate data ---
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    try:
        validate_data(data)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # --- Read template and inject JSON ---
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    json_str = json.dumps(data, ensure_ascii=False)
    html = html.replace("__POSTER_DATA__", json_str)

    base_href = template_path.parent.resolve().as_uri() + "/"
    html = html.replace("<head>", f"<head>\n<base href=\"{base_href}\">", 1)

    # --- Write temp HTML ---
    tmp_html = output_path.with_suffix(".tmp.html")
    with open(tmp_html, "w", encoding="utf-8") as f:
        f.write(html)

    # --- Screenshot with Playwright ---
    width, _ = RATIO_SIZES[args.ratio]
    playwright_available = True

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        playwright_available = False

    if playwright_available:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(
                    viewport={"width": width, "height": 800},
                    device_scale_factor=args.scale,
                )
                page.goto(f"file://{tmp_html.resolve()}", wait_until="networkidle")
                page.wait_for_timeout(1500)

                content_height = page.evaluate("document.getElementById('poster').scrollHeight + 40")
                page.set_viewport_size({"width": width, "height": content_height})
                page.wait_for_timeout(300)

                page.screenshot(path=str(output_path), full_page=False, type="png")
                browser.close()

            print(f"OK: {output_path} ({width}x{content_height} @{args.scale}x)")
        finally:
            if tmp_html.exists():
                tmp_html.unlink()
    else:
        fallback_html = output_path.with_suffix(".html")
        tmp_html.rename(fallback_html)
        print(f"WARNING: Playwright not installed. HTML saved to: {fallback_html}", file=sys.stderr)
        print(f"To install: pip install playwright && playwright install chromium", file=sys.stderr)


if __name__ == "__main__":
    main()
