package kanban

import (
	"context"
	"testing"
)

func TestAppendReopensCompletedGroup(t *testing.T) {
	for _, batch := range []bool{false, true} {
		for _, status := range []string{"success", "cancelled", "paused"} {
			t.Run(status+map[bool]string{false: "/single", true: "/batch"}[batch], func(t *testing.T) {
				ctx := context.Background()
				s, store, g := groupFixture(t)
				defer s.Close()
				old := groupTask(t, s, g, "existing result")
				old.Task.Status = StatusSuccess
				if err := store.UpdateTask(ctx, old.Task); err != nil {
					t.Fatal(err)
				}
				if _, err := store.db.ExecContext(ctx, `UPDATE task_groups SET status=?,published=1 WHERE id=?`, status, g.ID); err != nil {
					t.Fatal(err)
				}
				before, err := store.getGroup(ctx, g.ID)
				if err != nil {
					t.Fatal(err)
				}
				create := func(template string) error {
					input := CreateTaskInput{RootID: g.RootID, GroupID: g.ID, TaskTemplateID: template, Input: "new work", DependsOn: []string{old.Task.ID}}
					if batch {
						_, err := s.CreateGroupTasks(ctx, g.RootID, g.ID, []ChildPlanItem{{Ref: "new", CreateTaskInput: input}})
						return err
					}
					_, err := s.CreateTask(ctx, input)
					return err
				}
				if err := create("missing-template"); err == nil {
					t.Fatal("invalid append succeeded")
				}
				after, _ := store.getGroup(ctx, g.ID)
				if after.Status != before.Status || after.PlanVersion != before.PlanVersion {
					t.Fatal("failed append changed group")
				}
				err = create(old.Task.TaskTemplateID)
				if status == "cancelled" {
					if err == nil {
						t.Fatal("cancelled group accepted new work")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				graph, err := s.groupGraph(ctx, store, g.ID)
				want := status
				if status == "success" {
					want = "active"
				}
				if err != nil || graph.Group.Status != want || !graph.Group.Published || graph.Group.PlanVersion != before.PlanVersion+1 || len(graph.Tasks) != 2 {
					t.Fatalf("incorrect reopened group: %+v %v", graph, err)
				}
				for _, task := range graph.Tasks {
					if task.Task.ID == old.Task.ID {
						if task.Task.Status != StatusSuccess {
							t.Fatal("existing task reopened")
						}
					} else if task.Task.Published {
						t.Fatal("new work published without explicit publication")
					}
				}
			})
		}
	}
}
