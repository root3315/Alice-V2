// music — 音乐搜索
//
// 用法: music <query>
// 环境变量: MUSIC_API_BASE — NeteaseCloudMusicApi base URL
// 输出: JSON to stdout
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type ncmSearchSong struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Artist []struct {
		Name string `json:"name"`
	} `json:"artists"`
	Album struct {
		Name string `json:"name"`
	} `json:"album"`
}

type ncmSearchResponse struct {
	Result struct {
		Songs []ncmSearchSong `json:"songs"`
	} `json:"result"`
}

type MusicResult struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Artist string `json:"artist"`
	Album  string `json:"album"`
	URL    string `json:"url,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: music <query>")
		os.Exit(1)
	}

	baseURL := os.Getenv("MUSIC_API_BASE")
	if baseURL == "" {
		fmt.Fprintln(os.Stderr, "MUSIC_API_BASE env var required")
		os.Exit(1)
	}
	baseURL = strings.TrimSuffix(baseURL, "/")

	query := os.Args[1]
	client := &http.Client{Timeout: 10 * time.Second}

	// Search
	searchURL := baseURL + "/search?keywords=" + url.QueryEscape(query) + "&limit=5&type=1"
	resp, err := client.Get(searchURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Search failed: %v\n", err)
		os.Exit(1)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	var searchResult ncmSearchResponse
	if err := json.Unmarshal(body, &searchResult); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid search response")
		os.Exit(1)
	}

	items := make([]MusicResult, 0, len(searchResult.Result.Songs))
	for _, song := range searchResult.Result.Songs {
		artist := ""
		if len(song.Artist) > 0 {
			artist = song.Artist[0].Name
		}
		items = append(items, MusicResult{
			ID:     song.ID,
			Name:   song.Name,
			Artist: artist,
			Album:  song.Album.Name,
		})
	}

	output, _ := json.Marshal(items)
	fmt.Println(string(output))
}