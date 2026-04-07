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

func main() {
	start := time.Now()
	totalSteps := 0

	// ── CLI ──
	prompt := flag.String("prompt", "", "Gemini gen-image prompt (English, required)")
	images := flag.String("images", "", "Local product image paths, comma separated (required)")
	flag.Parse()

	if *prompt == "" {
		common.ExitWithError("--prompt is required", 0)
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

	fmt.Fprintf(os.Stderr, "[ecom] TaskID=%s, images=%d\n", taskID, len(imagePaths))

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

	// ── Step 3: CUA — Gemini generate (with retry) ──
	fmt.Fprintf(os.Stderr, "[Step 3] Gemini image generation ...\n")
	geminiPrompt := buildGeminiPrompt(*prompt, inputDir, outputDir)
	var step3Err error
	for attempt := 0; attempt <= maxGeminiRetries; attempt++ {
		if attempt > 0 {
			fmt.Fprintf(os.Stderr, "[Step 3] Retry #%d ...\n", attempt)
			common.WaitForIdle(ctx, client, sandbox.ID())
		}
		steps, step3Err = common.RunTask(ctx, client, geminiPrompt, sandbox.ID(), model)
		totalSteps += steps
		if step3Err == nil {
			break
		}
		fmt.Fprintf(os.Stderr, "[Step 3] Failed: %v\n", step3Err)
	}
	if step3Err != nil {
		exitWithDiag(ctx, sandbox, taskID, inputCDNUrls, totalSteps, start,
			fmt.Sprintf("Gemini failed (retried %d): %v", maxGeminiRetries, step3Err))
	}

	// ── Step 4: CUA — upload output/ via upload.mjs ──
	fmt.Fprintf(os.Stderr, "[Step 4] Upload generated images to CDN ...\n")
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

func buildGeminiPrompt(userPrompt string, inputDir string, outputDir string) string {
	return fmt.Sprintf(
		`Open Chrome and navigate to gemini.google.com. `+
			`First, click the "Create image" option to enter image creation mode. `+
			`Then click the file upload button (attachment/image icon) to upload images. `+
			`In the file picker dialog, navigate to the folder '%s' and select all image files inside it. `+
			`After the images are uploaded and attached, type this prompt in the input field: "%s". `+
			`Submit the prompt and wait for Gemini to finish generating the images. `+
			`Once generation is complete, for each generated image, right-click on it and choose "Save image as", `+
			`then navigate to '%s' and save it there. Repeat for all generated images.`,
		inputDir, userPrompt, outputDir,
	)
}
