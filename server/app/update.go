package app

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"mindfs/server/internal/update"
)

type UpdateOptions struct {
	Version  string
	Args     []string
	Progress io.Writer
}

type UpdateResult struct {
	CurrentVersion string
	LatestVersion  string
	HasUpdate      bool
	Installed      bool
	Message        string
}

func UpdateNow(ctx context.Context, opts UpdateOptions) (UpdateResult, error) {
	executable, err := os.Executable()
	if err != nil {
		return UpdateResult{}, err
	}
	svc := update.NewService("a9gent/mindfs", opts.Version, executable, opts.Args, 10*time.Minute)
	lastMessage := ""
	if opts.Progress != nil {
		svc.AddListener(func(st update.Status) {
			message := strings.TrimSpace(st.Message)
			if message == "" || message == lastMessage {
				return
			}
			switch st.Status {
			case "downloading", "installing", "installed":
				fmt.Fprintln(opts.Progress, message)
				lastMessage = message
			}
		})
	}
	st, err := svc.InstallLatest(ctx)
	result := UpdateResult{
		CurrentVersion: st.CurrentVersion,
		LatestVersion:  st.LatestVersion,
		HasUpdate:      st.HasUpdate,
		Installed:      st.Status == "installed",
		Message:        st.Message,
	}
	if err != nil {
		return result, err
	}
	return result, nil
}
