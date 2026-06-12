// repeat-message — 复读（转发消息到同一聊天）
//
// 用法: repeat-message <msgId> <chatId>
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LlmKira/Alice/runtime/internal/engine"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Usage: repeat-message <msgId> <chatId>")
		os.Exit(1)
	}

	msgId := parseUint(os.Args[1])
	chatId := parseUint(os.Args[2])

	if msgId == 0 || chatId == 0 {
		fmt.Fprintln(os.Stderr, "Invalid msgId or chatId")
		os.Exit(1)
	}

	client := engine.NewClient()
	result, err := client.Post("/telegram/forward", map[string]uint64{
		"msgId":  msgId,
		"chatId": chatId,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Engine API error: %v\n", err)
		os.Exit(1)
	}

	if result == nil {
		fmt.Println(`{"error": "Engine API unavailable"}`)
		os.Exit(1)
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}

func parseUint(s string) uint64 {
	var n uint64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + uint64(c-'0')
	}
	return n
}