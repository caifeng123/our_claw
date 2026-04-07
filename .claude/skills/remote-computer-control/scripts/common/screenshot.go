package common

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

// SaveScreenshot 截取远程沙箱屏幕并保存为 PNG
// 返回保存路径，失败返回空字符串
func SaveScreenshot(ctx context.Context, sandbox *lumi_cua_sdk.Sandbox) string {
	screenshotDir := filepath.Join(FindProjectRoot(), "data", "temp")
	if err := os.MkdirAll(screenshotDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "创建截图目录失败: %v\n", err)
		return ""
	}
	path := filepath.Join(screenshotDir, "final_screenshot.png")

	shot, err := sandbox.Screenshot(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "获取截图失败: %v\n", err)
		return ""
	}

	raw := shot.Base64Image
	if idx := strings.Index(raw, ","); idx != -1 {
		raw = raw[idx+1:]
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Base64 解码失败: %v\n", err)
		return ""
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "保存截图失败: %v\n", err)
		return ""
	}
	return path
}
