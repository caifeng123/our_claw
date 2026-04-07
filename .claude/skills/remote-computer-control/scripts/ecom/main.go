package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"computer_use/common"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

const maxGeminiRetries = 2

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

	fmt.Fprintf(os.Stderr, "[ecom] TaskID=%s, images=%d, schemes=%d\n", taskID, len(imagePaths), len(promptList))

	// ── Step 0: Go HTTP — upload product images to CDN ──
	fmt.Fprintf(os.Stderr, "[Step 0] Upload product images to CDN ...\n")
	var inputCDNUrls []string
	for _, localPath := range imagePaths {
		cdnUrl, err := common.UploadToCDN(localPath, cdnInputDir)
		if err != nil {
			common.ExitWithError(fmt.Sprintf("Upload failed (%s): %v", localPath, err), time.Since(start).Seconds())
		}
		inputCDNUrls = append(inputCDNUrls, cdnUrl)
		fmt.Fprintf(os.Stderr, "  uploaded: %s -> %s\n", localPath, cdnUrl)
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

	// ── Step 1: CUA — create directories ──
	fmt.Fprintf(os.Stderr, "[Step 1] Create sandbox directories ...\n")
	steps, err := common.RunTask(ctx, client, fmt.Sprintf(
		`Open PowerShell and run: New-Item -ItemType Directory -Force -Path '%s'; New-Item -ItemType Directory -Force -Path '%s'`,
		inputDir, outputDir,
	), sandbox.ID(), model)
	totalSteps += steps
	if err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start, fmt.Sprintf("Create dirs failed: %v", err))
	}

	// ── Step 2: CUA — download product images ──
	fmt.Fprintf(os.Stderr, "[Step 2] Download product images to sandbox ...\n")
	steps, err = common.RunTask(ctx, client, buildDownloadPrompt(inputCDNUrls, imagePaths, inputDir), sandbox.ID(), model)
	totalSteps += steps
	if err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start, fmt.Sprintf("Download failed: %v", err))
	}

	// ── Step 3: CUA — Gemini generate (multi-tab parallel, 4 sub-tasks) ──
	fmt.Fprintf(os.Stderr, "[Step 3] Gemini image generation (%d schemes, multi-tab) ...\n", len(promptList))

	tabCount := len(promptList)
	submitPrompt := buildBatchSubmitPrompt(inputDir, promptList)
	waitPrompt := buildBatchWaitPrompt(tabCount)
	downloadPrompt := buildBatchDownloadPrompt(tabCount, outputDir)
	cleanupPrompt := buildCleanupTabsPrompt()

	var step3Err error
	for attempt := 0; attempt <= maxGeminiRetries; attempt++ {
		if attempt > 0 {
			fmt.Fprintf(os.Stderr, "[Step 3] Retry #%d ...\n", attempt)
			common.WaitForIdle(ctx, client, sandbox.ID())
		}

		// ── 3a: Batch submit ──
		fmt.Fprintf(os.Stderr, "[Step 3a] Batch submit %d tabs ...\n", tabCount)
		steps, step3Err = common.RunTask(ctx, client, submitPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step3Err != nil {
			fmt.Fprintf(os.Stderr, "[Step 3a] Failed: %v\n", step3Err)
			continue
		}

		// ── 3b: Batch wait ──
		fmt.Fprintf(os.Stderr, "[Step 3b] Wait for all tabs to complete ...\n")
		common.WaitForIdle(ctx, client, sandbox.ID())
		steps, step3Err = common.RunTask(ctx, client, waitPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step3Err != nil {
			fmt.Fprintf(os.Stderr, "[Step 3b] Failed: %v\n", step3Err)
			continue
		}

		// ── 3c: Batch download ──
		fmt.Fprintf(os.Stderr, "[Step 3c] Download from all tabs ...\n")
		common.WaitForIdle(ctx, client, sandbox.ID())
		steps, step3Err = common.RunTask(ctx, client, downloadPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step3Err != nil {
			fmt.Fprintf(os.Stderr, "[Step 3c] Failed: %v, retrying 3c only ...\n", step3Err)
			common.WaitForIdle(ctx, client, sandbox.ID())
			steps, step3Err = common.RunTask(ctx, client, downloadPrompt, sandbox.ID(), model)
			totalSteps += steps
			if step3Err != nil {
				fmt.Fprintf(os.Stderr, "[Step 3c] Retry also failed: %v\n", step3Err)
				continue
			}
		}

		// all sub-tasks succeeded
		break
	}

	// ── 3d: Cleanup tabs (best-effort, don't fail on error) ──
	fmt.Fprintf(os.Stderr, "[Step 3d] Cleanup Gemini tabs ...\n")
	common.WaitForIdle(ctx, client, sandbox.ID())
	steps, cleanupErr := common.RunTask(ctx, client, cleanupPrompt, sandbox.ID(), model)
	totalSteps += steps
	if cleanupErr != nil {
		fmt.Fprintf(os.Stderr, "[Step 3d] Cleanup failed (non-fatal): %v\n", cleanupErr)
	}

	if step3Err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start,
			fmt.Sprintf("Gemini failed (retried %d): %v", maxGeminiRetries, step3Err))
	}

	// ── Step 4: CUA — upload output/ via upload.mjs ──
	fmt.Fprintf(os.Stderr, "[Step 4] Upload generated images to CDN ...\n")
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

	// ── Step 5: Go HTTP — query CDN for output URLs ──
	fmt.Fprintf(os.Stderr, "[Step 5] Query CDN for output URLs ...\n")
	dirResp, err := common.QueryCDNDir(cdnOutputDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[Step 5] Query failed: %v, fallback to screenshot\n", err)
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
		fmt.Fprintf(os.Stderr, "[Done] Generated %d images\n", len(outputURLs))
		common.ExitWithResult(common.Result{
			Success:         true,
			TaskID:          taskID,
			ImageURLs:       inputCDNUrls,
			OutputImageURLs: outputURLs,
			DurationSec:     time.Since(start).Seconds(),
			StepsExecuted:   totalSteps,
		})
	}

	// fallback: CDN query returned empty, screenshot for diagnosis
	fmt.Fprintf(os.Stderr, "[Warn] CDN returned no files, taking screenshot ...\n")
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

func buildDownloadPrompt(cdnURLs []string, originalPaths []string, inputDir string) string {
	var cmds []string
	for i, u := range cdnURLs {
		parts := strings.Split(strings.ReplaceAll(originalPaths[i], `\`, "/"), "/")
		fileName := parts[len(parts)-1]
		cmds = append(cmds, fmt.Sprintf(
			"Invoke-WebRequest -Uri '%s' -OutFile '%s\\%s'", u, inputDir, fileName,
		))
	}
	return fmt.Sprintf("Open PowerShell and run these commands to download product images:\n%s", strings.Join(cmds, "\n"))
}

// ─── Gemini Multi-Tab Prompt Builders ──────────────────────

// buildBatchSubmitPrompt: 3a — 依次在 N 个 Tab 中新建 Gemini 会话并提交，不等结果
func buildBatchSubmitPrompt(inputDir string, promptsList []string) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf(
		`Open Chrome and complete the following tasks across %d tabs. `+
			`For each tab, the process is: navigate to gemini.google.com, click "New chat", `+
			`upload ALL images from '%s', select "Create images" mode, `+
			`type the given prompt, and submit. `+
			`After submitting in each tab, do NOT wait for generation results — `+
			`immediately move on to open the next tab and repeat. `,
		len(promptsList), inputDir,
	))

	for i, p := range promptsList {
		if i == 0 {
			sb.WriteString(fmt.Sprintf(
				`Tab %d: Navigate to gemini.google.com. Click "New chat". `+
					`Upload all images from '%s'. Click "Create images". `+
					`Type this prompt: "%s". Submit and do not wait for results. `,
				i+1, inputDir, p,
			))
		} else {
			sb.WriteString(fmt.Sprintf(
				`Tab %d: Press Ctrl+T to open a new tab. Navigate to gemini.google.com. Click "New chat". `+
					`Upload all images from '%s'. Click "Create images". `+
					`Type this prompt: "%s". Submit and do not wait for results. `,
				i+1, inputDir, p,
			))
		}
	}

	sb.WriteString(fmt.Sprintf(
		`After all %d tabs have been submitted, stop. Do not close any tabs.`,
		len(promptsList),
	))

	return sb.String()
}

// buildBatchWaitPrompt: 3b — 轮询检查所有 Tab 直到全部生成完成
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

// buildBatchDownloadPrompt: 3c — 逐 Tab 下载 Gemini 生成图到统一 output 目录
func buildBatchDownloadPrompt(tabCount int, outputDir string) string {
	return fmt.Sprintf(
		`There are %d Gemini tabs open in Chrome, each with one generated image. `+
			`Switch to each tab one by one and save the Gemini-generated image — `+
			`do NOT save the product images that the user uploaded. `+
			`How to tell them apart: `+
			`user-uploaded images appear in the user message bubble (top of conversation, near user avatar); `+
			`the Gemini-generated image appears in Gemini's response section (below "Show thinking", near the sparkle icon). `+
			`In each tab: right-click the generated image → "Save image as" → `+
			`in the Save As dialog address bar, type: %s → press Enter to navigate there → click Save. `+
			`Do NOT save to Downloads or any other default folder. `+
			`Save the generated image from each of the %d tabs into the same folder: %s `+
			`After finishing all tabs, open PowerShell and run: ls '%s' `+
			`to verify the total saved file count (should be %d files).`,
		tabCount, outputDir, tabCount, outputDir, outputDir, tabCount,
	)
}

// buildCleanupTabsPrompt: 3d — 关闭所有 Gemini Tab
func buildCleanupTabsPrompt() string {
	return `Close all Gemini tabs in Chrome. ` +
		`Press Ctrl+W repeatedly to close each tab until no Gemini tabs remain. ` +
		`If Chrome has no other tabs left, leave one blank tab open so Chrome does not exit entirely.`
}
