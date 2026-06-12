// calendar — 日历/农历/节气/节假日
//
// 用法: calendar [YYYY-MM-DD]
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL（读取时区）
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/6tail/lunar-go/calendar"
	"github.com/LlmKira/Alice/runtime/internal/engine"
	"github.com/LlmKira/Alice/runtime/internal/timeutil"
)

type CalendarResult struct {
	Gregorian      string   `json:"gregorian"`
	Weekday        string   `json:"weekday"`
	Lunar          string   `json:"lunar"`
	SolarTerm      string   `json:"solar_term,omitempty"`
	Holidays       []string `json:"holidays"`
	TodayInHistory string   `json:"today_in_history,omitempty"`
}

var weekdays = []string{"星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"}

// 简化的历史事件（可后续扩展）
var todayInHistory = map[string]string{
	"01-01": "1912年 中华民国成立",
	"01-09": "2007年 初代 iPhone 发布",
	"01-15": "2001年 维基百科上线",
	"01-27": "1756年 莫扎特诞生",
	"02-14": "西方情人节",
	"03-08": "国际妇女节",
	"04-01": "西方愚人节",
	"04-02": "1805年 安徒生诞生",
	"05-01": "国际劳动节",
	"06-01": "国际儿童节",
	"07-01": "中国共产党建党",
	"08-01": "中国人民解放军建军",
	"09-10": "中国教师节",
	"10-01": "中华人民共和国国庆",
	"12-25": "西方圣诞节",
}

func main() {
	// 解析日期参数
	var year, month, day int
	if len(os.Args) > 1 {
		var ok bool
		year, month, day, ok = timeutil.ParseYMD(os.Args[1])
		if !ok {
			fmt.Fprintln(os.Stderr, "Invalid date format, use YYYY-MM-DD")
			os.Exit(1)
		}
	} else {
		// 获取时区偏移
		client := engine.NewClient()
		offset := timeutil.FetchTimezoneOffset(client)
		now := timeutil.LocalNow(offset)
		year, month, day = now.Year(), int(now.Month()), now.Day()
	}

	// 使用 lunar-go 计算农历
	solar := calendar.NewSolarFromYmd(year, month, day)
	lunar := solar.GetLunar()

	// 获取节气
	solarTerm := ""
	term := lunar.GetJieQi()
	if term != "" {
		solarTerm = term
	}

	// 获取节假日
	holidays := []string{}
	festivals := lunar.GetFestivals()
	for f := festivals.Front(); f != nil; f = f.Next() {
		holidays = append(holidays, f.Value.(string))
	}
	solarFestivals := solar.GetFestivals()
	for f := solarFestivals.Front(); f != nil; f = f.Next() {
		holidays = append(holidays, f.Value.(string))
	}

	// 历史上的今天
	md := fmt.Sprintf("%02d-%02d", month, day)
	history := todayInHistory[md]

	// 农历字符串
	lunarStr := fmt.Sprintf("农历%s%s%s",
		lunar.GetYearInGanZhi(),
		lunar.GetYearShengXiao(),
		lunar.GetMonthInChinese()+lunar.GetDayInChinese(),
	)

	result := CalendarResult{
		Gregorian:      fmt.Sprintf("%04d-%02d-%02d", year, month, day),
		Weekday:        weekdays[time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).Weekday()],
		Lunar:          lunarStr,
		SolarTerm:      solarTerm,
		Holidays:       holidays,
		TodayInHistory: history,
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}