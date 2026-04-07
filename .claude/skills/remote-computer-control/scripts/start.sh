#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
MIN_GO_VERSION="1.19"
BUILD_DIR="$SCRIPT_DIR/build"

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

# ── 创建 build 目录 ──
mkdir -p "$BUILD_DIR"

# ── 自动扫描所有含 main.go 的子目录，增量编译 ──
for entry in "$SCRIPT_DIR"/*/main.go; do
  [ -f "$entry" ] || continue

  dir=$(dirname "$entry")
  name=$(basename "$dir")

  # 跳过 common（纯库，无 main）和 build
  [[ "$name" == "common" || "$name" == "build" ]] && continue

  binary="$BUILD_DIR/$name"

  need_build=false
  if [[ ! -f "$binary" ]]; then
    need_build=true
  else
    # 检查：子目录源文件 或 common/ 任何 .go 或 go.mod 比二进制新 → 重编译
    newest=$(find "$dir" "$SCRIPT_DIR/common" -name '*.go' -newer "$binary" 2>/dev/null | head -1)
    [[ -n "$newest" ]] && need_build=true
    [[ "go.mod" -nt "$binary" ]] && need_build=true
  fi

  if $need_build; then
    echo "编译 $name ..." >&2
    go build -o "$binary" "./$name/" || { echo "编译 $name 失败" >&2; exit 1; }
    echo "  → $binary" >&2
  else
    echo "$name 无变更，跳过编译" >&2
  fi
done

echo "编译完成" >&2
