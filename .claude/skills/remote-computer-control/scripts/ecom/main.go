package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"computer_use/common"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

const maxGeminiRetries = 2

// productFidelityPrefix 产品保真指令，自动拼接到每个 Gemini prompt 前面
const productFidelityPrefix = `Keep the product from the uploaded photo exactly as-is: ` +
	`preserve its exact shape, proportions, colors, character design, and every surface detail. ` +
	`Do NOT redraw, simplify, stylize, or alter the product in any way. ` +
	`Only change the background, lighting, and surrounding scene elements. ` +
	`The product must look identical to the uploaded reference photo. `

// ─── 日志（只写文件，不输出到 stderr） ──────────────────────

var logFile *os.File

func initLog() {
	logDir := filepath.Join(common.FindProjectRoot(), "data", "temp")
	os.MkdirAll(logDir, 0755)
	f, err := os.OpenFile(filepath.Join(logDir, "ecom.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		// 日志文件打不开不是致命错误，静默跳过
		return
	}
	logFile = f
}

// logf 只写日志文件，不输出到 stderr，避免 Agent 看到中间态
func logf(format string, args ...interface{}) {
	if logFile != nil {
		fmt.Fprintf(logFile, format, args...)
	}
}

// ─── 自定义 flag 类型：支持多次 --prompt ───────────────────

type stringSlice []string

func (s *stringSlice) String() string { return strings.Join(*s, ", ") }
func (s *stringSlice) Set(val string) error {
	*s = append(*s, val)
	return nil
}

func main() {
	start := time.Now()
	totalSteps := 0

	initLog()
	if logFile != nil {
		defer logFile.Close()
	}

	// 注入 logf 到 common 包，让 CUA 步骤日志也只写文件
	common.Logger = logf

	// ── CLI ──
	var promptList stringSlice
	flag.Var(&promptList, "prompt", "Gemini prompt (repeatable, one per tab)")
	images := flag.String("images", "", "Local product image paths, comma separated (required)")
	flag.Parse()

	if len(promptList) == 0 {
		common.ExitWithError("at least one --prompt is required", 0)
	}
	if *images == "" {
		common.ExitWithError("--images is required", 0)
	}

	var imagePaths []string
	for _, p := range strings.Split(*images, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			imagePaths = append(imagePaths, p)
		}
	}
	if len(imagePaths) == 0 {
		common.ExitWithError("no valid image paths found", 0)
	}

	// ── TaskID + paths ──
	taskID := common.GenerateTaskID()
	sandboxBase := fmt.Sprintf(`C:\Users\ecs\Desktop\temp\%s`, taskID)
	inputDir := sandboxBase + `\input`
	outputDir := sandboxBase + `\output`
	cdnInputDir := fmt.Sprintf("images/%s/input", taskID)
	cdnOutputDir := fmt.Sprintf("images/%s/output", taskID)

	logf("[ecom] TaskID=%s, images=%d, schemes=%d\n", taskID, len(imagePaths), len(promptList))

	// ── Step 0: Go HTTP — upload product images to CDN ──
	logf("[Step 0] Upload product images to CDN ...\n")
	var inputCDNUrls []string
	for _, localPath := range imagePaths {
		cdnUrl, err := common.UploadToCDN(localPath, cdnInputDir)
		if err != nil {
			common.ExitWithError(fmt.Sprintf("Upload failed (%s): %v", localPath, err), time.Since(start).Seconds())
		}
		inputCDNUrls = append(inputCDNUrls, cdnUrl)
		logf("  uploaded: %s -> %s\n", localPath, cdnUrl)
	}

	// ── CUA init ──
	client := common.InitCUAClient()
	ctx := context.Background()

	sandbox, err := common.GetAvailableSandbox(ctx, client)
	if err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
	}
	if err := common.WaitForIdle(ctx, client, sandbox.ID()); err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
	}
	model, err := common.SelectModel(ctx, client, sandbox.ID())
	if err != nil {
		common.ExitWithError(err.Error(), time.Since(start).Seconds())
	}

	// ── Step 1: CUA — 调用 ecom_init.ps1（建目录 + 下载图片 + 设置Chrome下载路径 + 开 Gemini Tab） ──
	logf("[Step 1] Run ecom_init.ps1 (dirs + download + chrome prefs + open %d tabs) ...\n", len(promptList))
	initPrompt := fmt.Sprintf(
		`Open PowerShell and run: C:\Users\ecs\Desktop\tools\ecom_init.ps1 -TaskId '%s' -TabCount %d`,
		taskID, len(promptList),
	)
	steps, err := common.RunTask(ctx, client, initPrompt, sandbox.ID(), model)
	totalSteps += steps
	if err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start, fmt.Sprintf("Init script failed: %v", err))
	}

	// ── Step 2: CUA — Gemini 生图（4 个子任务） ──
	logf("[Step 2] Gemini image generation (%d schemes, multi-tab) ...\n", len(promptList))

	tabCount := len(promptList)
	submitPrompt := buildBatchSubmitPrompt(inputDir, promptList)
	waitPrompt := buildBatchWaitPrompt(tabCount)
	downloadPrompt := buildBatchDownloadPrompt(tabCount, outputDir)
	cleanupPrompt := buildCleanupTabsPrompt()

	var step2Err error
	for attempt := 0; attempt <= maxGeminiRetries; attempt++ {
		if attempt > 0 {
			logf("[Step 2] Retry #%d ...\n", attempt)
			common.WaitForIdle(ctx, client, sandbox.ID())
		}

		// ── 2a: Batch submit ──
		logf("[Step 2a] Batch submit %d tabs ...\n", tabCount)
		steps, step2Err = common.RunTask(ctx, client, submitPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step2Err != nil {
			logf("[Step 2a] Failed: %v\n", step2Err)
			continue
		}

		// ── 2b: Batch wait ──
		logf("[Step 2b] Wait for all tabs to complete ...\n")
		common.WaitForIdle(ctx, client, sandbox.ID())
		steps, step2Err = common.RunTask(ctx, client, waitPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step2Err != nil {
			logf("[Step 2b] Failed: %v\n", step2Err)
			continue
		}

		// ── 2c: Batch download (via hover download button, files go directly to output) ──
		logf("[Step 2c] Download from all tabs (hover button → output dir) ...\n")
		common.WaitForIdle(ctx, client, sandbox.ID())
		steps, step2Err = common.RunTask(ctx, client, downloadPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step2Err != nil {
			logf("[Step 2c] Failed: %v, retrying 2c only ...\n", step2Err)
			common.WaitForIdle(ctx, client, sandbox.ID())
			steps, step2Err = common.RunTask(ctx, client, downloadPrompt, sandbox.ID(), model)
			totalSteps += steps
			if step2Err != nil {
				logf("[Step 2c] Retry also failed: %v\n", step2Err)
				continue
			}
		}

		break
	}

	// ── 2d: Cleanup tabs (best-effort) ──
	logf("[Step 2d] Cleanup Gemini tabs ...\n")
	common.WaitForIdle(ctx, client, sandbox.ID())
	steps, cleanupErr := common.RunTask(ctx, client, cleanupPrompt, sandbox.ID(), model)
	totalSteps += steps
	if cleanupErr != nil {
		logf("[Step 2d] Cleanup failed (non-fatal): %v\n", cleanupErr)
	}

	if step2Err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start,
			fmt.Sprintf("Gemini failed (retried %d): %v", maxGeminiRetries, step2Err))
	}

	// ── Step 3: CUA — upload output/ via upload.mjs ──
	logf("[Step 3] Upload generated images to CDN ...\n")
	common.WaitForIdle(ctx, client, sandbox.ID())
	steps, err = common.RunTask(ctx, client, fmt.Sprintf(
		`Open PowerShell and run: node C:\Users\ecs\Desktop\tools\upload.mjs --dir %s %s`,
		cdnOutputDir, outputDir,
	), sandbox.ID(), model)
	totalSteps += steps
	if err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start,
			fmt.Sprintf("Upload output failed: %v", err))
	}

	// ── Step 4: Go HTTP — query CDN for output URLs ──
	logf("[Step 4] Query CDN for output URLs ...\n")
	dirResp, err := common.QueryCDNDir(cdnOutputDir)
	if err != nil {
		logf("[Step 4] Query failed: %v, fallback to screenshot\n", err)
		ssPath := common.SaveScreenshot(ctx, sandbox)
		common.ExitWithResult(common.Result{
			Success:       true,
			TaskID:        taskID,
			Screenshot:    ssPath,
			ImageURLs:     inputCDNUrls,
			DurationSec:   time.Since(start).Seconds(),
			StepsExecuted: totalSteps,
		})
	}

	outputURLs := common.BuildCDNUrls(dirResp)

	if len(outputURLs) > 0 {
		logf("[Done] Generated %d images\n", len(outputURLs))
		common.ExitWithResult(common.Result{
			Success:         true,
			TaskID:          taskID,
			ImageURLs:       inputCDNUrls,
			OutputImageURLs: outputURLs,
			DurationSec:     time.Since(start).Seconds(),
			StepsExecuted:   totalSteps,
		})
	}

	logf("[Warn] CDN returned no files, taking screenshot ...\n")
	ssPath := common.SaveScreenshot(ctx, sandbox)
	common.ExitWithResult(common.Result{
		Success:       true,
		TaskID:        taskID,
		Screenshot:    ssPath,
		ImageURLs:     inputCDNUrls,
		DurationSec:   time.Since(start).Seconds(),
		StepsExecuted: totalSteps,
	})
}

// ─── Helpers ───────────────────────────────────────────────

func exitWithDiag(ctx context.Context, sandbox *lumi_cua_sdk.Sandbox, taskID string, inputURLs []string, steps int, start time.Time, errMsg string) {
	ssPath := common.SaveScreenshot(ctx, sandbox)
	common.ExitWithResult(common.Result{
		Success:       false,
		TaskID:        taskID,
		Screenshot:    ssPath,
		ImageURLs:     inputURLs,
		DurationSec:   time.Since(start).Seconds(),
		StepsExecuted: steps,
		Error:         &errMsg,
	})
}

// ─── Gemini Multi-Tab Prompt Builders ──────────────────────

// buildBatchSubmitPrompt: 2a — N 个 Gemini Tab 已打开，逐 Tab 上传图片 + 提交 prompt
func buildBatchSubmitPrompt(inputDir string, promptsList []string) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf(
		`There are %d Gemini tabs already open in Chrome. `+
			`For each tab, you need to upload ALL product images, `+
			`select "Create images" mode, type the given prompt, and submit. `+
			`When uploading images: click the attachment/image upload button, `+
			`then in the file picker dialog, type '%s' in the address bar and press Enter to navigate there, `+
			`then select all files (Ctrl+A) and confirm. `+
			`After submitting in each tab, do NOT wait for generation results — `+
			`immediately switch to the next tab (Ctrl+Tab) and repeat. `,
		len(promptsList), inputDir,
	))

	for i, p := range promptsList {
		sb.WriteString(fmt.Sprintf(
			`Tab %d: Click the attachment/image upload button. `+
				`In the file picker dialog, type '%s' in the address bar and press Enter, then select all files (Ctrl+A) and confirm. `+
				`Click "Create images". `+
				`Type this prompt: "%s%s". Submit and do not wait for results. `+
				`Switch to the next tab with Ctrl+Tab. `,
			i+1, inputDir, productFidelityPrefix, p,
		))
	}

	sb.WriteString("After all tabs have been submitted, stop.")

	return sb.String()
}

// buildBatchWaitPrompt: 2b — 轮询检查所有 Tab 直到全部生成完成
func buildBatchWaitPrompt(tabCount int) string {
	return fmt.Sprintf(
		`There are %d Gemini tabs open in Chrome, each with a submitted image generation request. `+
			`Each tab will generate exactly one image. `+
			`Switch to each tab one by one (use Ctrl+Tab to cycle through tabs) and check if generation is complete. `+
			`In each tab, scroll down to see if a generated image has appeared below the "Show thinking" section. `+
			`If a tab is still generating (loading indicator visible), move on to the next tab and come back later. `+
			`Keep cycling through all %d tabs until every tab shows a completed generated image. `+
			`Once all tabs have finished generating, stop.`,
		tabCount, tabCount,
	)
}

// buildBatchDownloadPrompt: 2c — 逐 Tab 用 hover 下载按钮下载生成图（高清原图）
// Chrome 默认下载路径已由 ecom_init.ps1 设置为 output 目录，文件直接落到 output
func buildBatchDownloadPrompt(tabCount int, outputDir string) string {
	return fmt.Sprintf(
		`There are %d Gemini tabs open in Chrome, each with one generated image. `+
			`For each tab, download the generated image in Gemini's response area `+
			`(below "Show thinking", near the sparkle icon). `+
			`To download: `+
			`1) Hover over the generated image, move to the top-right corner of the image, `+
			`a download button with a downward arrow icon will appear. `+
			`Wait until the tooltip shows "Download". `+
			`2) Click the download button. `+
			`If the button disappears, hover the image again. `+
			`Use Ctrl+Tab to switch between tabs and repeat for all %d tabs. `+
			`After all downloads, open PowerShell and run: ls '%s' `+
			`to verify there are %d image files.`,
		tabCount, tabCount, outputDir, tabCount,
	)
}

// buildCleanupTabsPrompt: 2d — 关闭所有 Gemini Tab
func buildCleanupTabsPrompt() string {
	return `Close all Gemini tabs in Chrome. ` +
		`Press Ctrl+W repeatedly to close each tab until no Gemini tabs remain. ` +
		`If Chrome has no other tabs left, leave one blank tab open so Chrome does not exit entirely.`
}
