// luck — 今日运势
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type luckResponse struct {
	Code int `json:"code"`
	Data struct {
		LuckDesc string `json:"luck_desc"`
		LuckRank int    `json:"luck_rank"`
		LuckTip  string `json:"luck_tip"`
	} `json:"data"`
}

func main() {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://60s.viki.moe/v2/luck")
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result luckResponse
	if err := json.Unmarshal(body, &result); err != nil || result.Code != 200 {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	fmt.Printf("🎯 今日运势 — %s（%d/30）\n", result.Data.LuckDesc, result.Data.LuckRank)
	fmt.Println(result.Data.LuckTip)
}