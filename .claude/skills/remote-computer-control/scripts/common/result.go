package common

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ─── JSON 输出结构 ──────────────────────────────────────────

type Result struct {
	Success         bool     `json:"success"`
	TaskID          string   `json:"task_id,omitempty"`
	Screenshot      string   `json:"screenshot,omitempty"`
	ImageURLs       []string `json:"image_urls,omitempty"`
	OutputImageURLs []string `json:"output_image_urls,omitempty"`
	DurationSec     float64  `json:"duration_sec"`
	StepsExecuted   int      `json:"steps_executed"`
	Error           *string  `json:"error"`
}

func ExitWithResult(r Result) {
	json.NewEncoder(os.Stdout).Encode(r)
	if !r.Success {
		os.Exit(1)
	}
	os.Exit(0)
}

func ExitWithError(msg string, duration float64) {
	ExitWithResult(Result{
		Success:     false,
		DurationSec: duration,
		Error:       &msg,
	})
}

// ─── 环境变量工具 ─────────────────────────────────────────

func EnvOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func EnvRequired(key string) string {
	v := os.Getenv(key)
	if v == "" {
		fmt.Fprintf(os.Stderr, "缺少必需的环境变量: %s\n", key)
		os.Exit(1)
	}
	return v
}

// ─── 项目根目录查找 ──────────────────────────────────────

func FindProjectRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if info, err := os.Stat(filepath.Join(dir, ".claude")); err == nil && info.IsDir() {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	cwd, _ := os.Getwd()
	return cwd
}

// ─── TaskID 生成 ─────────────────────────────────────────

func GenerateTaskID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}
