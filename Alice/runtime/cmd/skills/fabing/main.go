// fabing — 发病文学
//
// 用法: fabing <name>
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

type fabingResponse struct {
	Code int `json:"code"`
	Data struct {
		Saying string `json:"saying"`
	} `json:"data"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: fabing <name>")
		os.Exit(1)
	}

	name := url.QueryEscape(os.Args[1])
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get("https://60s.viki.moe/v2/fabing?name=" + name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result fabingResponse
	if err := json.Unmarshal(body, &result); err != nil || result.Code != 200 || result.Data.Saying == "" {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	fmt.Printf("💘 发病文学 — %s\n", result.Data.Saying)
}