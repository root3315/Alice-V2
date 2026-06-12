// kfc — 疯狂星期四文案
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type kfcResponse struct {
	Code int `json:"code"`
	Data struct {
		Kfc string `json:"kfc"`
	} `json:"data"`
}

func main() {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://60s.viki.moe/v2/kfc")
	if err != nil {
		fmt.Fprintf(os.Stderr, "API failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result kfcResponse
	if err := json.Unmarshal(body, &result); err != nil || result.Code != 200 || result.Data.Kfc == "" {
		fmt.Fprintln(os.Stderr, "Invalid API response")
		os.Exit(1)
	}

	fmt.Printf("🍗 疯狂星期四 — %s\n", result.Data.Kfc)
}