package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mindfs/server/app"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Shared status/update flags retain their service meaning without a task selector.
func registerTaskOperationFlags(fs *flag.FlagSet, status, update *bool) map[string]*bool {
	operations := map[string]*bool{"status": status, "update": update}
	for _, operation := range []struct{ name, help string }{
		{"graph", "show the task dependency graph"},
		{"context", "read task or task group context"},
		{"messages", "read pending task or task group messages"},
		{"result", "read task delivery results"},
		{"plan", "create a batch of dependent tasks from JSON"},
		{"publish", "publish the task group plan"},
		{"complete", "complete task group acceptance"},
		{"pause", "pause a task group"},
		{"resume", "resume a task group"},
		{"cancel", "cancel a task or task group"},
		{"delete", "delete an unexecuted task"},
		{"next", "advance a task to the next stage"},
		{"prev", "move a task to the previous stage"},
	} {
		operations[operation.name] = fs.Bool(operation.name, false, operation.help)
	}
	return operations
}

func selectedTaskOperation(operations map[string]*bool, taskScope bool) (string, int) {
	action, count := "", 0
	for name, enabled := range operations {
		if !*enabled || (!taskScope && (name == "status" || name == "update")) {
			continue
		}
		action = name
		count++
	}
	return action, count
}

func handleTaskOperation(addr string, tls bool, root, id, action, cursor string) error {
	if cursor != "" && action != "list" {
		return errors.New("-cursor requires -tasks")
	}
	if root == "" && action != "templates" && action != "agents" {
		return errors.New("root id required")
	}
	token, e := app.ReadLocalCLIToken(addr)
	if e != nil {
		return e
	}
	if id != "" && !strings.HasPrefix(action, "group:") {
		if _, e := strconv.Atoi(strings.TrimPrefix(id, "#")); e == nil {
			id, _, e = fetchTaskDetailByNumber(addr, tls, token, root, mustTaskNumber(id))
			if e != nil {
				return e
			}
		}
	}
	method := http.MethodPost
	path := "/api/tasks/" + url.PathEscape(id)
	query := "?root=" + url.QueryEscape(root)
	groupAction := strings.HasPrefix(action, "group:")
	if groupAction {
		operation := strings.TrimPrefix(action, "group:")
		path = "/api/task-groups"
		switch operation {
		case "list":
			method = http.MethodGet
			path += query
		case "create":
		default:
			if id == "" {
				return errors.New("-task-group required")
			}
			path += "/" + url.PathEscape(id)
			switch operation {
			case "graph", "status", "context", "messages":
				method = http.MethodGet
				path += query + "&view=" + operation
			case "plan", "publish", "complete", "pause", "resume", "cancel":
				path += "/" + operation
			default:
				return fmt.Errorf("unsupported group action %q", operation)
			}
		}
	} else {
		switch action {
		case "list":
			method = http.MethodGet
			path = "/api/tasks" + query + "&summary=1&cursor=" + url.QueryEscape(cursor)
		case "agents":
			method = http.MethodGet
			path = "/api/agents"
		case "templates":
			method = http.MethodGet
			path = "/api/task-templates"
		case "create":
			path = "/api/tasks"
		case "status":
			method = http.MethodGet
			path += query
		case "result", "context", "messages":
			method = http.MethodGet
			path += "/read/" + action + query
		case "next", "prev":
			path += "/" + action
		case "update":
			method = http.MethodPatch
		case "delete":
			method = http.MethodDelete
			path += query
		case "to-task", "from-task", "cancel":
			path += "/orchestration/" + action
		default:
			return fmt.Errorf("unsupported action %q", action)
		}
	}
	if !groupAction && id == "" && action != "list" && action != "agents" && action != "templates" && action != "create" {
		return errors.New("-task required")
	}
	body := map[string]any{}
	if method == http.MethodPost || method == http.MethodPatch {
		info, err := os.Stdin.Stat()
		if err != nil {
			return err
		}
		operation := strings.TrimPrefix(action, "group:")
		required := false
		switch operation {
		case "create", "plan", "update", "to-task", "from-task", "complete":
			required = true
		case "cancel":
			required = !groupAction
		}
		body, e = readTaskJSON(os.Stdin, info.Mode()&os.ModeCharDevice != 0, required)
		if e != nil {
			return e
		}
	}
	body["root_id"] = root
	payload, e := json.Marshal(body)
	if e != nil {
		return e
	}
	req, e := http.NewRequest(method, addrToURL(addr, path, tls), bytes.NewReader(payload))
	if e != nil {
		return e
	}
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, e := newHTTPClient(tls, 30*time.Second).Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("task operation failed: %s", httpErrorMessage(resp))
	}
	_, e = io.Copy(os.Stdout, resp.Body)
	if e == nil {
		fmt.Fprintln(os.Stdout)
	}
	return e
}
func mustTaskNumber(id string) int { v, _ := strconv.Atoi(strings.TrimPrefix(id, "#")); return v }

// Queries never call this helper. Interactive commands must not wait for a JSON EOF.
func readTaskJSON(input io.Reader, interactive, required bool) (map[string]any, error) {
	body := map[string]any{}
	const limit = 4 << 20
	var data []byte
	if !interactive {
		var err error
		data, err = io.ReadAll(io.LimitReader(input, limit+1))
		if err != nil {
			return nil, err
		}
		if len(data) > limit {
			return nil, errors.New("JSON input exceeds 4 MiB")
		}
	}
	if len(bytes.TrimSpace(data)) == 0 {
		if required {
			return nil, errors.New("JSON object required on stdin; use a pipe, < request.json, or <<'JSON' heredoc")
		}
		return body, nil
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("invalid JSON on stdin: %w", err)
	}
	if body == nil {
		return nil, errors.New("JSON object required on stdin")
	}
	return body, nil
}
