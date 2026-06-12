// weather — 天气查询
//
// 用法: weather <city>
// 输出: JSON to stdout
//
// 接入 Open-Meteo API（免费、无 API key）
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

var wmoCodes = map[int]struct {
	Emoji string
	Desc  string
}{
	0:  {"☀️", "晴"},
	1:  {"🌤️", "大部分晴"},
	2:  {"⛅", "多云"},
	3:  {"☁️", "阴"},
	45: {"🌫️", "雾"},
	48: {"🌫️", "冻雾"},
	51: {"🌦️", "小毛毛雨"},
	53: {"🌦️", "毛毛雨"},
	55: {"🌦️", "大毛毛雨"},
	61: {"🌧️", "小雨"},
	63: {"🌧️", "中雨"},
	65: {"🌧️", "大雨"},
	71: {"🌨️", "小雪"},
	73: {"🌨️", "中雪"},
	75: {"❄️", "大雪"},
	80: {"🌦️", "阵雨"},
	82: {"⛈️", "暴雨"},
	95: {"⛈️", "雷暴"},
}

type geocodingResponse struct {
	Results []struct {
		Lat      float64 `json:"latitude"`
		Lon      float64 `json:"longitude"`
		Name     string  `json:"name"`
		Country  string  `json:"country"`
		Timezone string  `json:"timezone"`
	} `json:"results"`
}

type weatherResponse struct {
	Current struct {
		Temp         float64 `json:"temperature_2m"`
		RelativeHum  int     `json:"relative_humidity_2m"`
		WeatherCode  int     `json:"weather_code"`
		WindSpeed    float64 `json:"wind_speed_10m"`
	} `json:"current"`
}

type WeatherResult struct {
	City        string  `json:"city"`
	Country     string  `json:"country"`
	Temp        float64 `json:"temp"`
	Humidity    int     `json:"humidity"`
	WindSpeed   float64 `json:"wind_speed"`
	WeatherCode int     `json:"weather_code"`
	WeatherDesc string  `json:"weather_desc"`
	WeatherEmoji string `json:"weather_emoji"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: weather <city>")
		os.Exit(1)
	}

	city := os.Args[1]
	client := &http.Client{Timeout: 10 * time.Second}

	// Step 1: Geocoding
	geoURL := "https://geocoding-api.open-meteo.com/v1/search?name=" + url.QueryEscape(city) + "&count=1&language=zh&format=json"
	geoResp, err := client.Get(geoURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Geocoding failed: %v\n", err)
		os.Exit(1)
	}
	geoBody, _ := io.ReadAll(geoResp.Body)
	geoResp.Body.Close()

	var geo geocodingResponse
	if err := json.Unmarshal(geoBody, &geo); err != nil || len(geo.Results) == 0 {
		fmt.Fprintln(os.Stderr, "City not found")
		os.Exit(1)
	}

	// Step 2: Weather
	loc := geo.Results[0]
	weatherURL := fmt.Sprintf(
		"https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=%s",
		loc.Lat, loc.Lon, url.QueryEscape(loc.Timezone),
	)
	weatherResp, err := client.Get(weatherURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Weather API failed: %v\n", err)
		os.Exit(1)
	}
	weatherBody, _ := io.ReadAll(weatherResp.Body)
	weatherResp.Body.Close()

	var weather weatherResponse
	if err := json.Unmarshal(weatherBody, &weather); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid weather response")
		os.Exit(1)
	}

	// Decode WMO code
	emoji, desc := "🌡️", fmt.Sprintf("天气代码 %d", weather.Current.WeatherCode)
	if wmo, ok := wmoCodes[weather.Current.WeatherCode]; ok {
		emoji, desc = wmo.Emoji, wmo.Desc
	}

	result := WeatherResult{
		City:         loc.Name,
		Country:      loc.Country,
		Temp:         weather.Current.Temp,
		Humidity:     weather.Current.RelativeHum,
		WindSpeed:    weather.Current.WindSpeed,
		WeatherCode:  weather.Current.WeatherCode,
		WeatherDesc:  desc,
		WeatherEmoji: emoji,
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}