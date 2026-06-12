// video — 视频搜索
//
// 用法: video <query> [platform]
// 输出: JSON to stdout
//
// 支持平台：bilibili（默认）
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

type bilibiliItem struct {
	Title    string `json:"title"`
	Author   string `json:"author"`
	BVID     string `json:"bvid"`
	Play     int    `json:"play"`
	Duration string `json:"duration"`
}

type bilibiliResponse struct {
	Code int `json:"code"`
	Data struct {
		Result []struct {
			Title    string `json:"title"`
			Author   string `json:"author"`
			BVID     string `json:"bvid"`
			Play     int    `json:"play"`
			Duration string `json:"duration"`
		} `json:"result"`
	} `json:"data"`
}

type VideoResult struct {
	Title    string `json:"title"`
	Author   string `json:"author"`
	URL      string `json:"url"`
	Play     int    `json:"play"`
	Duration string `json:"duration"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: video <query>")
		os.Exit(1)
	}

	query := os.Args[1]
	client := &http.Client{Timeout: 10 * time.Second}

	apiURL := "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=" +
		url.QueryEscape(query) + "&page=1&page_size=5"

	req, _ := http.NewRequest("GET", apiURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://www.bilibili.com")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result bilibiliResponse
	if err := json.Unmarshal(body, &result); err != nil || result.Code != 0 {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	items := make([]VideoResult, 0, len(result.Data.Result))
	for _, v := range result.Data.Result {
		items = append(items, VideoResult{
			Title:    v.Title,
			Author:   v.Author,
			URL:      "https://www.bilibili.com/video/" + v.BVID,
			Play:     v.Play,
			Duration: v.Duration,
		})
	}

	output, _ := json.Marshal(items)
	fmt.Println(string(output))
}