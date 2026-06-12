// hitokoto — 随机一言
//
// 用法: hitokoto
// 输出: 格式化文本 to stdout
//
// 后端：60s.viki.moe（开源聚合 API，无需 API key）
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type hitokotoResponse struct {
	Code int `json:"code"`
	Data struct {
		Hitokoto string `json:"hitokoto"`
	} `json:"data"`
}

func main() {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get("https://60s.viki.moe/v2/hitokoto")
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "API failed: %d\n", resp.StatusCode)
		os.Exit(1)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Read failed: %v\n", err)
		os.Exit(1)
	}

	var result hitokotoResponse
	if err := json.Unmarshal(body, &result); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	if result.Code != 200 || result.Data.Hitokoto == "" {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	fmt.Printf("✨ 一言 — \"%s\"\n", result.Data.Hitokoto)
}