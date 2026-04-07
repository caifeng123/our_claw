package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"cf/computer_use/common"
)

func main() {
	start := time.Now()

	// ── CLI 参数 ──
	prompt := flag.String("prompt", "", "目标级任务 Prompt（必填）")
	images := flag.String("images", "", "本地图片路径，多个用逗号分隔（可选，用于替换 Prompt 中的 {IMAGE_URL}）")
	flag.Parse()

	if *prompt == "" {
		common.ExitWithError("--prompt 参数不能为空", 0)
		return
	}

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
			url, err := common.UploadToCDN(p, "task-images")
			if err != nil {
				fmt.Fprintf(os.Stderr, "图片上传失败 (%s): %v\n", p, err)
				continue
			}
			imageURLs = append(imageURLs, url)
		}
		for _, url := range imageURLs {
			taskPrompt = strings.Replace(taskPrompt, "{IMAGE_URL}", url, 1)
		}
	}

	// ── 初始化 CUA 客户端 ──
	client := common.InitCUAClient()
	ctx := context.Background()

	// ── 获取沙箱 ──
	sandbox, err := common.GetAvailableSandbox(ctx, client)
	if err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 等待空闲 ──
	if err := common.WaitForIdle(ctx, client, sandbox.ID()); err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 选择模型 ──
	model, err := common.SelectModel(ctx, client, sandbox.ID())
	if err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
		return
	}

	// ── 执行任务 ──
	steps, err := common.RunTask(ctx, client, taskPrompt, sandbox.ID(), model)
	if err != nil {
		ssPath := common.SaveScreenshot(ctx, sandbox)
		errMsg := err.Error()
		common.ExitWithResult(common.Result{
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
	ssPath := common.SaveScreenshot(ctx, sandbox)

	// ── 输出结果 ──
	common.ExitWithResult(common.Result{
		Success:       true,
		Screenshot:    ssPath,
		ImageURLs:     imageURLs,
		DurationSec:   time.Since(start).Seconds(),
		StepsExecuted: steps,
	})
}
