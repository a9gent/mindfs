package usecase

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mindfs/server/internal/session"

	_ "modernc.org/sqlite"
)

const commandHistoryDBPath = "commands/history.db"

type CommandSuggestion struct {
	Command        string
	Cwd            string
	Shell          string
	RootID         string
	LastExitCode   int
	LastDurationMs int64
	LastUsedAt     time.Time
}

func UpsertCommandSuggestion(manager *session.Manager, item CommandSuggestion) error {
	if manager == nil {
		return nil
	}
	command := strings.TrimSpace(item.Command)
	if command == "" {
		return nil
	}
	db, err := openCommandHistoryDB(manager)
	if err != nil {
		return err
	}
	defer db.Close()
	lastUsedAt := item.LastUsedAt
	if lastUsedAt.IsZero() {
		lastUsedAt = time.Now().UTC()
	}
	_, err = db.Exec(`
INSERT INTO command_suggestions (
	command, cwd, shell, root_id, use_count, success_count, last_exit_code, last_duration_ms, last_used_at
) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
ON CONFLICT(command, cwd, shell, root_id) DO UPDATE SET
	use_count = use_count + 1,
	success_count = success_count + 1,
	last_exit_code = excluded.last_exit_code,
	last_duration_ms = excluded.last_duration_ms,
	last_used_at = excluded.last_used_at
`, command, strings.TrimSpace(item.Cwd), strings.TrimSpace(item.Shell), strings.TrimSpace(item.RootID), item.LastExitCode, item.LastDurationMs, lastUsedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func SearchCommandSuggestions(ctx context.Context, manager *session.Manager, rootID, query string, limit int) ([]CandidateItem, error) {
	if manager == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = maxCandidateItems
	}
	db, err := openCommandHistoryDB(manager)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	q := strings.ToLower(strings.TrimSpace(query))
	rows, err := db.QueryContext(ctx, `
SELECT command, cwd, shell, use_count, success_count, last_duration_ms, last_used_at
FROM command_suggestions
WHERE root_id = ?
ORDER BY last_used_at DESC, use_count DESC
LIMIT 200
`, strings.TrimSpace(rootID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]CandidateItem, 0, limit)
	for rows.Next() {
		var command, cwd, shell, lastUsedAt string
		var useCount, successCount int
		var durationMs int64
		if err := rows.Scan(&command, &cwd, &shell, &useCount, &successCount, &durationMs, &lastUsedAt); err != nil {
			return nil, err
		}
		if q != "" && !matchesCandidateName(command, q) {
			continue
		}
		desc := strings.TrimSpace(cwd)
		if desc == "" {
			desc = "."
		}
		if shell != "" {
			desc += " · " + filepath.Base(shell)
		}
		if useCount > 0 {
			desc += " · " + strconvItoa(useCount) + " 次使用"
		}
		items = append(items, CandidateItem{Type: CandidateTypeCommand, Name: command, Description: desc})
		if len(items) >= limit {
			break
		}
	}
	return items, rows.Err()
}

func SearchCommandCandidates(ctx context.Context, manager *session.Manager, rootID, query string, limit int, shellSpec ShellHistorySpec) ([]CandidateItem, error) {
	if limit <= 0 {
		limit = maxCandidateItems
	}
	mindfsItems, err := SearchCommandSuggestions(ctx, manager, rootID, query, limit)
	if err != nil {
		return nil, err
	}
	items := make([]CandidateItem, 0, limit)
	seen := make(map[string]struct{}, limit)
	appendUnique := func(list []CandidateItem) {
		for _, item := range list {
			if len(items) >= limit {
				return
			}
			normalized := normalizeCandidateName(item.Name)
			if normalized == "" {
				continue
			}
			if _, ok := seen[normalized]; ok {
				continue
			}
			seen[normalized] = struct{}{}
			items = append(items, item)
		}
	}
	appendUnique(mindfsItems)
	if len(items) < limit {
		appendUnique(SearchSystemShellHistory(ctx, shellSpec, query, limit-len(items)))
	}
	return items, nil
}

func openCommandHistoryDB(manager *session.Manager) (*sql.DB, error) {
	metaDir := manager.MetaDir()
	if strings.TrimSpace(metaDir) == "" {
		var err error
		metaDir, err = manager.Root().EnsureMetaDir()
		if err != nil {
			return nil, err
		}
	}
	dbFile := filepath.Join(metaDir, filepath.FromSlash(commandHistoryDBPath))
	if err := os.MkdirAll(filepath.Dir(dbFile), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
CREATE TABLE IF NOT EXISTS command_suggestions (
	command TEXT NOT NULL,
	cwd TEXT NOT NULL,
	shell TEXT NOT NULL,
	root_id TEXT NOT NULL,
	use_count INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	last_exit_code INTEGER,
	last_duration_ms INTEGER,
	last_used_at TEXT NOT NULL,
	PRIMARY KEY(command, cwd, shell, root_id)
);`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func strconvItoa(v int) string {
	if v == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	n := v
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[i:])
}
