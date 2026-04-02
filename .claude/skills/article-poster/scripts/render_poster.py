#!/usr/bin/env python3
"""
render_poster.py — Project-root-aware wrapper for render.py.

Resolves the project root by walking up from cwd looking for .claude/,
ensures <project_root>/data/temp/posters/ exists, and invokes render.py
with correct paths.

Usage:
  python3 .claude/skills/article-poster/scripts/render_poster.py \
    --data poster_data.json --output poster.png [--ratio medium] [--scale 2]

Relative --data and --output paths are resolved to <project_root>/data/temp/posters/.
"""

import os
import subprocess
import sys
from pathlib import Path


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so the command file
    we create ends up where claude -p will look for it.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def main():
    project_root = find_project_root()
    poster_dir = project_root / "data" / "temp" / "posters"
    poster_dir.mkdir(parents=True, exist_ok=True)

    # Skill directory: this script lives in scripts/, skill is one level up
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    render_py = skill_dir / "render.py"

    if not render_py.exists():
        print(f"ERROR: render.py not found at {render_py}", file=sys.stderr)
        sys.exit(1)

    # Process args: resolve relative --data and --output to poster_dir
    args = sys.argv[1:]
    resolved_args = []
    i = 0
    while i < len(args):
        resolved_args.append(args[i])
        if args[i] in ("--data", "--output") and i + 1 < len(args):
            i += 1
            path = Path(args[i])
            if not path.is_absolute():
                path = poster_dir / path
            resolved_args.append(str(path))
        i += 1

    print(f"[render_poster] Project root: {project_root}")
    print(f"[render_poster] Poster dir:   {poster_dir}")
    print(f"[render_poster] Skill dir:    {skill_dir}")

    cmd = [sys.executable, str(render_py)] + resolved_args
    result = subprocess.run(cmd)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
