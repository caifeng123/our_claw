#!/usr/bin/env python3
"""
holiday_engine.py — 东南亚五国节日筛选引擎

数据分离：
- 节日源数据：<skill_dir>/data/holidays_YYYY.json（入 git，随 skill 分发）
- 运行时数据：<project_root>/data/project-name/（products/ + cache/，不入 git）

用法：
  python holiday_engine.py [--days 30] [--force] [--date YYYY-MM-DD]
                           [--holidays-dir <节日数据目录>]
                           [--runtime-dir <运行时数据目录>]

自动定位逻辑：
  1. holidays-dir 默认 = 脚本自身所在目录的上级 /data/（即 skill/data/）
  2. runtime-dir  默认 = find_project_root() / data / project-name/
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
import argparse


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so paths
    stay consistent regardless of where the script is invoked from.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def resolve_holidays_dir(explicit: str = None) -> Path:
    """节日源数据目录：默认 = 脚本自身上级的 data/"""
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parent.parent / "data"


def resolve_runtime_dir(explicit: str = None) -> Path:
    """运行时数据目录：默认 = <project_root>/data/project-name/"""
    if explicit:
        return Path(explicit)
    return find_project_root() / "data" / "project-name"


def load_holiday_data(holidays_dir: Path, year: int) -> dict:
    path = holidays_dir / f"holidays_{year}.json"
    if not path.exists():
        print(f"[WARNING] 节日数据文件不存在: {path}", file=sys.stderr)
        return {"markets": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_last_holidays(runtime_dir: Path) -> dict:
    path = runtime_dir / "cache" / "last_holidays.json"
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def filter_holidays_in_window(holidays: list, start: str, end: str) -> list:
    start_date = datetime.strptime(start, "%Y-%m-%d").date()
    end_date = datetime.strptime(end, "%Y-%m-%d").date()
    result = []
    for h in holidays:
        h_date_str = h.get("date", "")
        if "~" in h_date_str:
            range_start_str, range_end_str = h_date_str.split("~")
            try:
                h_start = datetime.strptime(range_start_str.strip(), "%Y-%m-%d").date()
                h_end = datetime.strptime(range_end_str.strip(), "%Y-%m-%d").date()
            except ValueError:
                continue
            if h_start <= end_date and h_end >= start_date:
                result.append(h)
        else:
            try:
                h_date = datetime.strptime(h_date_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if start_date <= h_date <= end_date:
                result.append(h)
    return result


def sort_holidays(holidays: list) -> list:
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    def sort_key(h):
        p = priority_order.get(h.get("priority", "P2"), 9)
        d = h.get("date", "9999-12-31").split("~")[0]
        return (p, d)
    return sorted(holidays, key=sort_key)


def diff_holidays(current: list, previous: list) -> dict:
    def holiday_key(h):
        return (h.get("name", ""), h.get("date", ""))
    current_set = {holiday_key(h) for h in current}
    previous_set = {holiday_key(h) for h in previous}
    added = current_set - previous_set
    removed = previous_set - current_set
    added_names = [name for name, _ in added]
    removed_names = [name for name, _ in removed]
    changed = len(added) > 0 or len(removed) > 0
    summary_parts = []
    if added_names:
        summary_parts.append(f"新增: {', '.join(added_names)}")
    if removed_names:
        summary_parts.append(f"移除: {', '.join(removed_names)}")
    return {
        "changed": changed,
        "diff_summary": "; ".join(summary_parts) if summary_parts else "无变化"
    }


def main():
    parser = argparse.ArgumentParser(description="东南亚五国节日筛选引擎")
    parser.add_argument("--holidays-dir", default=None,
                        help="节日源数据目录（默认: <skill>/data/）")
    parser.add_argument("--runtime-dir", default=None,
                        help="运行时数据目录（默认: <project_root>/data/project-name/）")
    parser.add_argument("--data-dir", default=None,
                        help="兼容旧参数：同时设置 holidays-dir 和 runtime-dir")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--date", default=None)
    args = parser.parse_args()

    # 兼容旧的 --data-dir 参数（同时包含节日数据和运行时数据）
    if args.data_dir:
        holidays_dir = Path(args.data_dir)
        runtime_dir = Path(args.data_dir)
    else:
        holidays_dir = resolve_holidays_dir(args.holidays_dir)
        runtime_dir = resolve_runtime_dir(args.runtime_dir)

    print(f"[INFO] 节日数据: {holidays_dir}", file=sys.stderr)
    print(f"[INFO] 运行时数据: {runtime_dir}", file=sys.stderr)

    # 确保运行时目录存在
    (runtime_dir / "cache").mkdir(parents=True, exist_ok=True)
    (runtime_dir / "products").mkdir(parents=True, exist_ok=True)

    # 1. 时间窗口
    if args.date:
        today = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        today = datetime.now().date()
    window_end = today + timedelta(days=args.days)
    window_start_str = today.strftime("%Y-%m-%d")
    window_end_str = window_end.strftime("%Y-%m-%d")
    print(f"[INFO] 时间窗口: {window_start_str} → {window_end_str} ({args.days}天)", file=sys.stderr)

    # 2. 加载节日数据
    year = today.year
    holiday_data = load_holiday_data(holidays_dir, year)
    if window_end.year != year:
        next_year_data = load_holiday_data(holidays_dir, window_end.year)
        for market, holidays in next_year_data.get("markets", {}).items():
            if market in holiday_data.get("markets", {}):
                holiday_data["markets"][market].extend(holidays)
            else:
                holiday_data.setdefault("markets", {})[market] = holidays

    # 3. 加载上次缓存
    last_holidays = load_last_holidays(runtime_dir)

    # 4. 筛选 + 差异检测
    markets = ["SG", "MY", "TH", "PH", "VN"]
    result = {
        "window_start": window_start_str,
        "window_end": window_end_str,
        "window_days": args.days,
        "holidays_dir": str(holidays_dir),
        "runtime_dir": str(runtime_dir),
        "markets": {},
        "skipped_markets": [],
        "all_changed": args.force,
        "force_refresh": args.force
    }

    any_changed = False
    all_sorted = {}  # 用于写 cache（包含所有市场）

    for market in markets:
        all_holidays = holiday_data.get("markets", {}).get(market, [])
        filtered = filter_holidays_in_window(all_holidays, window_start_str, window_end_str)
        sorted_holidays = sort_holidays(filtered)
        all_sorted[market] = sorted_holidays

        if args.force:
            diff = {"changed": True, "diff_summary": "强制刷新"}
        elif last_holidays:
            prev_market = last_holidays.get("markets", {}).get(market, {})
            prev_holidays = prev_market.get("holidays", prev_market) if isinstance(prev_market, dict) else prev_market
            if isinstance(prev_holidays, list):
                diff = diff_holidays(sorted_holidays, prev_holidays)
            else:
                diff = {"changed": True, "diff_summary": "无历史数据"}
        else:
            diff = {"changed": True, "diff_summary": "首次运行"}

        if not diff["changed"]:
            # 无变化 → 不输出到 stdout，只记录跳过
            result["skipped_markets"].append(market)
            print(f"[INFO] {market}：节日无变化，跳过", file=sys.stderr)
            continue

        any_changed = True

        holiday_keywords = []
        for h in sorted_holidays:
            if h.get("keywords_local"):
                holiday_keywords.extend(h["keywords_local"])
            else:
                holiday_keywords.append(h.get("name", ""))

        result["markets"][market] = {
            "holidays": sorted_holidays,
            "holiday_count": len(sorted_holidays),
            "holiday_keywords": holiday_keywords,
            "diff_summary": diff["diff_summary"]
        }

    if not args.force:
        result["all_changed"] = any_changed

    print(json.dumps(result["markets"], ensure_ascii=False, indent=2))

    # ---- 自动写入 cache（包含所有市场，不管是否变化）----
    cache_path = runtime_dir / "cache" / "last_holidays.json"
    cache_data = {"window_start": window_start_str, "window_end": window_end_str, "markets": {}}
    for m, holidays in all_sorted.items():
        cache_data["markets"][m] = {"holidays": holidays}
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f, ensure_ascii=False, indent=2)
    print(f"[INFO] 缓存已写入: {cache_path}", file=sys.stderr)

    changed_markets = list(result["markets"].keys())
    total = sum(m["holiday_count"] for m in result["markets"].values())
    print(f"[INFO] 共筛出 {total} 个节日（仅含有变化的市场），{len(changed_markets)} 个市场需更新: {', '.join(changed_markets) if changed_markets else '无'}", file=sys.stderr)
    if result["skipped_markets"]:
        print(f"[INFO] 跳过无变化的市场: {', '.join(result['skipped_markets'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
