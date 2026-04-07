package common

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultCDNUploadURL = "https://ife.bytedance.net/cdn/upload"
	DefaultCDNQueryURL  = "https://ife.bytedance.net/cdn/getCurrentDir"
	DefaultCDNBaseURL   = "https://lf3-static.bytednsdoc.com/obj/eden-cn/"
	DefaultCDNRegion    = "CN"
	DefaultCDNEmail     = "caifeng.nice@bytedance.com"
)

// UploadToCDN 上传单个文件到 CDN
func UploadToCDN(filePath string, dir string) (string, error) {
	cdnURL := EnvOrDefault("CDN_UPLOAD_URL", DefaultCDNUploadURL)
	region := EnvOrDefault("CDN_REGION", DefaultCDNRegion)
	email := EnvOrDefault("CDN_EMAIL", DefaultCDNEmail)

	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("open file failed: %v", err)
	}
	defer file.Close()

	filename := fmt.Sprintf("%d_%s", time.Now().Unix(), filepath.Base(filePath))

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	writer.WriteField("dir", dir)
	writer.WriteField("region", region)
	writer.WriteField("email", email)

	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return "", fmt.Errorf("create form failed: %v", err)
	}
	if _, err = io.Copy(part, file); err != nil {
		return "", fmt.Errorf("copy file data failed: %v", err)
	}
	writer.Close()

	resp, err := http.Post(cdnURL, writer.FormDataContentType(), &buf)
	if err != nil {
		return "", fmt.Errorf("upload request failed: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upload failed (HTTP %d): %s", resp.StatusCode, body)
	}

	var result struct {
		CdnUrl string `json:"cdnUrl"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("parse upload response failed: %v", err)
	}
	if result.CdnUrl == "" {
		return "", fmt.Errorf("CDN returned no URL: %s", body)
	}

	cdnUrl := result.CdnUrl
	if !strings.HasPrefix(cdnUrl, "http") {
		cdnUrl = "https://" + cdnUrl
	}
	return cdnUrl, nil
}

// CDNDirResponse getCurrentDir 接口返回结构
type CDNDirResponse struct {
	Dir     string   `json:"dir"`
	Files   []string `json:"files"`
	SubDirs []string `json:"subDirs"`
}

// QueryCDNDir 查询 CDN 目录下的文件列表
// dir: 上传时使用的 dir（如 images/a1b2c3d4/output），不需要加前缀
// 接口根据 email 自动解析用户空间前缀
// 返回的 Dir 字段包含完整路径（含前缀），可直接用于拼接 URL
func QueryCDNDir(dir string) (*CDNDirResponse, error) {
	queryURL := EnvOrDefault("CDN_QUERY_URL", DefaultCDNQueryURL)
	region := EnvOrDefault("CDN_REGION", DefaultCDNRegion)
	email := EnvOrDefault("CDN_EMAIL", DefaultCDNEmail)

	reqURL := fmt.Sprintf("%s?dir=%s&region=%s&email=%s",
		queryURL,
		url.QueryEscape(dir),
		url.QueryEscape(region),
		url.QueryEscape(email),
	)

	resp, err := http.Get(reqURL)
	if err != nil {
		return nil, fmt.Errorf("query CDN dir failed: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("query failed (HTTP %d): %s", resp.StatusCode, body)
	}

	var result CDNDirResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse query response failed: %v", err)
	}
	return &result, nil
}

// BuildCDNUrls 根据 QueryCDNDir 返回的 Dir 和 Files 拼接完整 CDN URL
func BuildCDNUrls(dirResp *CDNDirResponse) []string {
	baseURL := EnvOrDefault("CDN_BASE_URL", DefaultCDNBaseURL)
	urls := make([]string, 0, len(dirResp.Files))
	for _, f := range dirResp.Files {
		urls = append(urls, baseURL+dirResp.Dir+"/"+f)
	}
	return urls
}
