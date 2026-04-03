#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
MIN_GO_VERSION="1.19"
BINARY="$SCRIPT_DIR/task"

# ── Go 环境检测 ──
if ! command -v go &>/dev/null; then
  for candidate in \
    "${GVM_ROOT:-$HOME/.gvm}/gos/go${MIN_GO_VERSION}/bin" \
    "${GOROOT:-/usr/local/go}/bin" \
    "$HOME/go/bin" \
    "/usr/local/go/bin"; do
    [[ -x "$candidate/go" ]] && { export PATH="$candidate:$PATH"; break; }
  done
fi

command -v go &>/dev/null || { echo "Go 未找到，需要 >=${MIN_GO_VERSION}" >&2; exit 1; }

GO_VER=$(go version | grep -oP 'go\K[0-9]+\.[0-9]+')
[[ "$(printf '%s\n' "$MIN_GO_VERSION" "$GO_VER" | sort -V | head -1)" == "$MIN_GO_VERSION" ]] \
  || { echo "Go 版本过低: $GO_VER < $MIN_GO_VERSION" >&2; exit 1; }

# ── 增量依赖检查 ──
cd "$SCRIPT_DIR"
HASH_FILE="$SCRIPT_DIR/.mod_hash"
CURRENT_HASH=$(cat go.mod go.sum 2>/dev/null | md5sum | cut -d' ' -f1)

if [[ ! -f "$HASH_FILE" ]] || [[ "$(cat "$HASH_FILE")" != "$CURRENT_HASH" ]]; then
  go mod tidy || { echo "go mod tidy 失败" >&2; exit 1; }
  echo "$CURRENT_HASH" > "$HASH_FILE"
fi

# ── 增量编译 ──
if [[ ! -f "$BINARY" ]] || [[ "task.go" -nt "$BINARY" ]] || [[ "go.mod" -nt "$BINARY" ]]; then
  go build -o "$BINARY" task.go || { echo "编译失败" >&2; exit 1; }
fi
