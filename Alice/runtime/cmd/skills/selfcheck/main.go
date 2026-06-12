// selfcheck — 系统自检
//
// 用法: selfcheck
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL
package main

import (
	"encoding/json"
	"fmt"
	"runtime"
	"time"

	"github.com/LlmKira/Alice/runtime/internal/engine"
)

type SelfcheckResult struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
	GoVersion string `json:"go_version"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Engine    string `json:"engine"`
}

func main() {
	client := engine.NewClient()

	engineStatus := "unavailable"
	if _, err := client.Get("/"); err == nil {
		engineStatus = "ok"
	}

	result := SelfcheckResult{
		Status:    "ok",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		GoVersion: runtime.Version(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Engine:    engineStatus,
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}