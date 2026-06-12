// trending — 热搜/热榜查询
//
// 用法: trending [platform]
// 输出: JSON to stdout
//
// 支持平台：weibo/zhihu/douyin/bilibili/baidu
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type TrendItem struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

type apiResponse struct {
	Code int `json:"code"`
	Data []struct {
		Title       string `json:"title"`
		Link        string `json:"link"`
		URL         string `json:"url"`
		HotValue    any    `json:"hot_value"`
		HotValueDesc string `json:"hot_value_desc"`
	} `json:"data"`
}

var platforms = map[string]string{
	"weibo":    "/v2/weibo",
	"zhihu":    "/v2/zhihu",
	"douyin":   "/v2/douyin",
	"bilibili": "/v2/bili",
	"baidu":    "/v2/baidu/hot",
	"toutiao":  "/v2/toutiao",
	"rednote":  "/v2/rednote",
}

func main() {
	platform := "weibo"
	if len(os.Args) > 1 {
		platform = os.Args[1]
	}

	route, ok := platforms[platform]
	if !ok {
		fmt.Fprintf(os.Stderr, "Unknown platform: %s\nSupported: weibo, zhihu, douyin, bilibili, baidu\n", platform)
		os.Exit(1)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://60s.viki.moe" + route)
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result apiResponse
	if err := json.Unmarshal(body, &result); err != nil || result.Code != 200 {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	items := make([]TrendItem, 0, len(result.Data))
	for _, d := range result.Data {
		url := d.Link
		if url == "" {
			url = d.URL
		}
		snippet := ""
		switch v := d.HotValue.(type) {
		case float64:
			snippet = fmt.Sprintf("热度 %.0f", v)
		case string:
			snippet = v
		}
		if d.HotValueDesc != "" {
			snippet = d.HotValueDesc
		}
		items = append(items, TrendItem{
			Title:   d.Title,
			URL:     url,
			Snippet: snippet,
		})
	}

	output, _ := json.Marshal(items)
	fmt.Println(string(output))
}