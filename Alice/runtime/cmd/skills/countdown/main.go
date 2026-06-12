// countdown — 倒计时
//
// 用法: countdown <date>
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL（读取时区）
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/LlmKira/Alice/runtime/internal/engine"
	"github.com/LlmKira/Alice/runtime/internal/timeutil"
)

type CountdownResult struct {
	TargetDate string `json:"target_date"`
	DaysLeft   int    `json:"days_left"`
	Message    string `json:"message"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: countdown <YYYY-MM-DD>")
		os.Exit(1)
	}

	dateStr := os.Args[1]
	year, month, day, ok := timeutil.ParseYMD(dateStr)
	if !ok {
		fmt.Fprintln(os.Stderr, "Invalid date format, use YYYY-MM-DD")
		os.Exit(1)
	}

	// 获取时区偏移
	client := engine.NewClient()
	offset := timeutil.FetchTimezoneOffset(client)

	// 当前本地时间
	now := timeutil.LocalNow(offset)
	target := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)

	days := int(target.Sub(now).Hours() / 24)
	if days < 0 {
		days = -days
	}

	message := fmt.Sprintf("距离 %s 还有 %d 天", dateStr, days)
	if days == 0 {
		message = "就是今天！"
	}

	result := CountdownResult{
		TargetDate: dateStr,
		DaysLeft:   days,
		Message:    message,
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}