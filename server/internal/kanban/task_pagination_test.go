package kanban

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"mindfs/server/internal/fs"
)

func TestTasksCreatedCursorPagination(t *testing.T) {
	ctx := context.Background()
	store, err := NewTaskStore(fs.RootInfo{ID: "root", RootPath: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	base := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)
	create := func(id string, number int, created time.Time) {
		t.Helper()
		_, err := store.CreateTask(ctx,
			Task{ID: id, TaskNumber: number, RootID: "root", CreatedAt: created, UpdatedAt: base.Add(time.Duration(100-number) * time.Hour)},
			StageRun{ID: "run-" + id, TaskID: id, CreatedAt: created, UpdatedAt: created},
			TaskEvent{ID: "event-" + id, TaskID: id, CreatedAt: created})
		if err != nil {
			t.Fatal(err)
		}
	}
	// Repeated timestamps and different fractional precision cross the page boundary.
	for i := 0; i < 45; i++ {
		// Numbers deliberately run opposite to creation order.
		create(fmt.Sprintf("task-%02d", i), 45-i, base.Add(time.Duration(i/3)*100*time.Millisecond))
	}
	opts := ListTasksOptions{CreatedDesc: true, Limit: 20}
	seen := []string{}
	for page := 0; page < 3; page++ {
		items, err := store.ListTasks(ctx, opts)
		if err != nil {
			t.Fatal(err)
		}
		want := 20
		if page == 2 {
			want = 5
		}
		if len(items) != want {
			t.Fatalf("page %d: got %d tasks, want %d", page, len(items), want)
		}
		for _, task := range items {
			seen = append(seen, task.ID)
		}
		last := items[len(items)-1]
		opts.CursorTaskNumber = last.TaskNumber
		if page == 0 {
			// New tasks must not shift later pages.
			create("new-task", 46, base.Add(time.Hour))
		}
	}
	for i, id := range seen {
		if want := fmt.Sprintf("task-%02d", 44-i); id != want {
			t.Fatalf("position %d: got %s, want %s", i, id, want)
		}
	}
	items, err := store.ListTasks(ctx, opts)
	if err != nil || len(items) != 0 {
		t.Fatalf("last page: %v, %v", items, err)
	}
	if _, err := store.db.ExecContext(ctx, "DELETE FROM tasks WHERE task_number = ?", opts.CursorTaskNumber); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ListTasks(ctx, opts); err == nil || !strings.Contains(err.Error(), "cursor task not found") {
		t.Fatalf("deleted cursor task: %v", err)
	}
}
