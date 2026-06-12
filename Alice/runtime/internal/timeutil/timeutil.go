// Package timeutil provides time utilities for skills.
package timeutil

import (
	"fmt"
	"strconv"
	"time"
)

// FetchTimezoneOffset reads timezoneOffset from Engine API.
// Falls back to UTC+0 if unavailable.
func FetchTimezoneOffset(client TimezoneFetcher) int {
	result, err := client.Get("/config/timezoneOffset")
	if err != nil {
		return 0
	}

	if m, ok := result.(map[string]any); ok {
		if v, exists := m["value"]; exists {
			switch val := v.(type) {
			case float64:
				return int(val)
			case int:
				return val
			case string:
				if i, err := strconv.Atoi(val); err == nil {
					return i
				}
			}
		}
	}
	return 0
}

// TimezoneFetcher is the interface for fetching config.
type TimezoneFetcher interface {
	Get(path string) (any, error)
}

// LocalNow returns a time adjusted for timezone offset.
func LocalNow(offset int) time.Time {
	offsetHours := time.Duration(offset) * time.Hour
	return time.Now().UTC().Add(offsetHours)
}

// ParseYMD parses a YYYY-MM-DD string.
func ParseYMD(s string) (year, month, day int, ok bool) {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return 0, 0, 0, false
	}

	year, err := strconv.Atoi(s[0:4])
	if err != nil {
		return 0, 0, 0, false
	}
	month, err = strconv.Atoi(s[5:7])
	if err != nil {
		return 0, 0, 0, false
	}
	day, err = strconv.Atoi(s[8:10])
	if err != nil {
		return 0, 0, 0, false
	}

	return year, month, day, true
}

// FormatYMD formats year, month, day to YYYY-MM-DD.
func FormatYMD(year, month, day int) string {
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
}

// TimePeriod returns Chinese time period name based on hour.
func TimePeriod(hour int) string {
	switch {
	case hour < 6:
		return "凌晨"
	case hour < 12:
		return "上午"
	case hour < 18:
		return "下午"
	default:
		return "晚上"
	}
}

// FormatTimezone formats offset to UTC+N / UTC-N.
func FormatTimezone(offset int) string {
	return fmt.Sprintf("UTC%+d", offset)
}