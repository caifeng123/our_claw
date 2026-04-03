package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

// ─── 配置 ─────────────────────────────────────────────────

const (
	defaultManagerURL = "https://iaas-cua-devbox-ecs-manager-v2.byted.org/mgr"
	defaultPlannerURL = "https://iaas-cua-devbox-planner-agent.byted.org/planner"

	taskTimeoutSeconds = 300
	idlePollInterval   = 5 * time.Second
	maxIdleWaitTime    = 90 * time.Second
)

// ─── JSON 输出结构 ──────────────────────────────────────────

type Result struct {
	Success       bool     `json:"success"`
	Screenshot    string   `json:"screenshot"`
	ImageURLs     []string `json:"image_urls,omitempty"`
	DurationSec   float64  `json:"duration_sec"`
	StepsExecuted int      `json:"steps_executed"`
	Error         *string  `json:"error"`
}

func exitWithResult(r Result) {
	json.NewEncoder(os.Stdout).Encode(r)
	if !r.Success {
		os.Exit(1)
	}
}

func exitWithError(msg string, duration float64) {
	exitWithResult(Result{
		Success:     false,
		DurationSec: duration,
		Error:       &msg,
	})
}

// ─── 环境变量 ─────────────────────────────────────────────

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envRequired(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("缺少必需的环境变量: %s", key)
	}
	return v
}

// ─── CDN 上传（仅用于向远程沙箱传递图片） ─────────────────────

func uploadToCDN(filePath string) (string, error) {
	cdnURL := os.Getenv("CDN_UPLOAD_URL")
	if cdnURL == "" {
		return "", fmt.Errorf("CDN_UPLOAD_URL 环境变量未设置")
	}

	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("打开文件失败: %v", err)
	}
	defer file.Close()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return "", fmt.Errorf("创建表单失败: %v", err)
	}
	if _, err = io.Copy(part, file); err != nil {
		return "", fmt.Errorf("复制文件数据失败: %v", err)
	}
	writer.Close()

	resp, err := http.Post(cdnURL, writer.FormDataContentType(), &buf)
	if err != nil {
		return "", fmt.Errorf("上传请求失败: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("上传失败 (HTTP %d): %s", resp.StatusCode, body)
	}

	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("解析上传响应失败: %v", err)
	}
	return result.URL, nil
}

func main() {
	start := time.Now()

	// ── CLI 参数 ──
	prompt := flag.String("prompt", "", "目标级任务 Prompt（必填）")
	images := flag.String("images", "", "本地图片路径，多个用逗号分隔（可选，用于替换 Prompt 中的 {IMAGE_URL}）")
	screenshotDir := flag.String("screenshot-dir", ".", "截图保存目录")
	flag.Parse()

	if *prompt == "" {
		exitWithError("--prompt 参数不能为空", 0)
		return
	}

	// ── 环境变量 ──
	managerURL := envOrDefault("LUMI_MANAGER_URL", defaultManagerURL)
	plannerURL := envOrDefault("LUMI_PLANNER_URL", defaultPlannerURL)
	apiKey := envRequired("LUMI_API_KEY")

	// ── 处理图片：上传 CDN 并替换占位符 ──
	taskPrompt := *prompt
	var imageURLs []string

	if *images != "" {
		paths := strings.Split(*images, ",")
		for _, p := range paths {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			url, err := uploadToCDN(p)
			if err != nil {
				fmt.Fprintf(os.Stderr, "图片上传失败 (%s): %v\n", p, err)
				continue
			}
			imageURLs = append(imageURLs, url)
		}
		// 按顺序替换 {IMAGE_URL}
		for _, url := range imageURLs {
			taskPrompt = strings.Replace(taskPrompt, "{IMAGE_URL}", url, 1)
		}
	}

	// ── 初始化 CUA 客户端 ──
	client := lumi_cua_sdk.NewLumiCuaClient(managerURL, plannerURL, apiKey)
	ctx := context.Background()

	// ── 获取沙箱 ──
	sandbox, err := getAvailableSandbox(ctx, client)
	if err != nil {
		exitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 等待空闲 ──
	if err := waitForIdle(ctx, client, sandbox.ID()); err != nil {
		exitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 选择模型 ──
	model, err := selectModel(ctx, client, sandbox.ID())
	if err != nil {
		exitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 执行任务 ──
	steps, err := runTask(ctx, client, taskPrompt, sandbox.ID(), model)
	if err != nil {
		// 执行出错，仍尝试保存截图
		ssPath := saveScreenshot(ctx, sandbox, *screenshotDir)
		errMsg := err.Error()
		exitWithResult(Result{
			Success:       false,
			Screenshot:    ssPath,
			ImageURLs:     imageURLs,
			DurationSec:   time.Since(start).Seconds(),
			StepsExecuted: steps,
			Error:         &errMsg,
		})
		return
	}

	// ── 保存截图 ──
	ssPath := saveScreenshot(ctx, sandbox, *screenshotDir)

	// ── 输出结果 ──
	exitWithResult(Result{
		Success:       true,
		Screenshot:    ssPath,
		ImageURLs:     imageURLs,
		DurationSec:   time.Since(start).Seconds(),
		StepsExecuted: steps,
	})
}

// ─── 沙箱管理 ─────────────────────────────────────────────

func getAvailableSandbox(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient) (*lumi_cua_sdk.Sandbox, error) {
	sandboxes, err := client.ListSandboxes(ctx)
	if err != nil {
		return nil, fmt.Errorf("获取沙箱列表失败: %v", err)
	}
	if len(sandboxes) == 0 {
		return nil, fmt.Errorf("没有可用的沙箱，请先创建一个远程沙箱")
	}
	return sandboxes[0], nil
}

func waitForIdle(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) error {
	startTime := time.Now()
	for {
		isIdle, err := client.CheckIdle(ctx, sandboxID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "检查空闲状态失败: %v\n", err)
		}
		if isIdle {
			return nil
		}
		if time.Since(startTime) > maxIdleWaitTime {
			return fmt.Errorf("等待 Planner 空闲超时（>%v）", maxIdleWaitTime)
		}
		time.Sleep(idlePollInterval)
	}
}

func selectModel(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) (string, error) {
	models, err := client.ListModels(ctx, sandboxID)
	if err != nil {
		return "", fmt.Errorf("获取模型列表失败: %v", err)
	}
	if len(models) == 0 {
		return "", fmt.Errorf("没有可用的模型")
	}
	return models[0].Name, nil
}

// ─── 任务执行 ─────────────────────────────────────────────

func runTask(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, taskPrompt, sandboxID, model string) (int, error) {
	messageChan, err := client.RunTask(ctx, taskPrompt, sandboxID, model, "", "enabled", taskTimeoutSeconds)
	if err != nil {
		if taskBusyErr, ok := err.(*lumi_cua_sdk.TaskBusyError); ok {
			return 0, fmt.Errorf("沙箱繁忙: %v", taskBusyErr)
		}
		return 0, fmt.Errorf("启动任务失败: %v", err)
	}

	steps := 0
	for message := range messageChan {
		steps++
		// 进度输出到 stderr，不影响 stdout JSON
		fmt.Fprintf(os.Stderr, "[步骤 %d] %s | %s\n", steps, message.Action, message.Summary)

		switch message.Action {
		case "error":
			return steps, fmt.Errorf("执行出错（步骤 %d）: %s", steps, message.Summary)
		case "timeout":
			return steps, fmt.Errorf("任务超时（%ds）", taskTimeoutSeconds)
		}
	}
	return steps, nil
}

// ─── 截图保存 ─────────────────────────────────────────────

func saveScreenshot(ctx context.Context, sandbox *lumi_cua_sdk.Sandbox, dir string) string {
	if err := os.MkdirAll(dir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "创建截图目录失败: %v\n", err)
		return ""
	}
	path := filepath.Join(dir, "final_screenshot.png")

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
