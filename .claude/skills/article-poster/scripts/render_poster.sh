#!/usr/bin/env bash
# render_poster.sh — Wrapper script that resolves project root
# and passes correct paths to render.py.
#
# Usage:
#   bash .claude/skills/article-poster/scripts/render_poster.sh \
#     --data poster_data.json --output poster.png [--ratio medium] [--scale 2]
#
# The script will:
#   1. Find the project root (directory containing .claude/)
#   2. Ensure <project_root>/data/temp/posters/ exists
#   3. Resolve --data and --output relative to that directory
#   4. Call render.py with the correct template path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# --- Find project root by walking up looking for .claude/ ---
find_project_root() {
    local dir="$PWD"
    while [ "$dir" != "/" ]; do
        if [ -d "$dir/.claude" ]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    # Fallback to cwd
    echo "$PWD"
}

PROJECT_ROOT="$(find_project_root)"
POSTER_DIR="${PROJECT_ROOT}/data/temp/posters"

mkdir -p "$POSTER_DIR"

# --- Parse args, resolve relative paths to POSTER_DIR ---
ARGS=()
NEXT_IS_DATA=false
NEXT_IS_OUTPUT=false

for arg in "$@"; do
    if $NEXT_IS_DATA; then
        # If not absolute, resolve relative to POSTER_DIR
        if [[ "$arg" != /* ]]; then
            arg="${POSTER_DIR}/${arg}"
        fi
        NEXT_IS_DATA=false
    elif $NEXT_IS_OUTPUT; then
        if [[ "$arg" != /* ]]; then
            arg="${POSTER_DIR}/${arg}"
        fi
        NEXT_IS_OUTPUT=false
    fi

    if [[ "$arg" == "--data" ]]; then
        NEXT_IS_DATA=true
    elif [[ "$arg" == "--output" ]]; then
        NEXT_IS_OUTPUT=true
    fi

    ARGS+=("$arg")
done

echo "[render_poster] Project root: $PROJECT_ROOT"
echo "[render_poster] Poster dir:   $POSTER_DIR"
echo "[render_poster] Skill dir:    $SKILL_DIR"

exec python3 "${SKILL_DIR}/render.py" "${ARGS[@]}"
