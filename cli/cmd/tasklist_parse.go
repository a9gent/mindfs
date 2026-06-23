package main

import (
	"encoding/csv"
	"os"
	"strconv"
	"strings"
)

func parseTasklistImageName(output []byte, pid int) (string, error) {
	text := strings.TrimSpace(string(output))
	if text == "" {
		return "", os.ErrProcessDone
	}
	reader := csv.NewReader(strings.NewReader(text))
	records, err := reader.ReadAll()
	if err != nil {
		return "", os.ErrProcessDone
	}
	wantPID := strconv.Itoa(pid)
	for _, record := range records {
		if len(record) < 2 {
			continue
		}
		name := strings.TrimSpace(record[0])
		gotPID := strings.TrimSpace(record[1])
		if name != "" && gotPID == wantPID {
			return name, nil
		}
	}
	return "", os.ErrProcessDone
}
