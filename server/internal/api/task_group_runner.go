package api

import (
	"context"
	"errors"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/kanban"
)

func (s *AppContext) ValidateGroupSession(ctx context.Context, root, key string) error {
	uc := &usecase.Service{Registry: s}
	sess, e := uc.GetSession(ctx, usecase.GetSessionInput{RootID: root, Key: key})
	if e != nil {
		return e
	}
	if sess == nil {
		return errors.New("parent session not found")
	}
	if sess.Type != "chat" {
		return errors.New("source must be a chat session")
	}
	return nil
}
func (s *AppContext) GroupSessionBusy(root, key string) bool {
	return usecase.SessionTurnActive(root, key)
}
func (s *AppContext) RunGroupTurn(ctx context.Context, g kanban.TaskGroup, prompt string) error {
	uc := &usecase.Service{Registry: s}
	sess, e := uc.GetSession(ctx, usecase.GetSessionInput{RootID: g.RootID, Key: g.SessionKey})
	if e != nil {
		return e
	}
	if sess == nil {
		return errors.New("parent session not found")
	}
	agentName := "codex"
	for i := len(sess.Exchanges) - 1; i >= 0; i-- {
		if sess.Exchanges[i].Agent != "" {
			agentName = sess.Exchanges[i].Agent
			break
		}
	}
	return s.RunAgentStage(ctx, kanban.AgentStageExecution{RootID: g.RootID, Stage: kanban.StageTemplate{Agent: agentName, Model: sess.Model, PlanMode: sess.PlanMode}, Run: kanban.StageRun{SessionKey: g.SessionKey}, Prompt: prompt})
}
func (s *AppContext) GroupUpdated(g kanban.TaskGroup) {
	s.GetSessionStreamHub().BroadcastAll(WSResponse{Type: "task-group.updated", Payload: map[string]any{"root_id": g.RootID, "group": g}})
}

func (s *AppContext) DeleteSessionTaskGroups(ctx context.Context, root string, keys []string) ([]string, error) {
	svc, err := s.GetKanbanService()
	if err != nil {
		return nil, err
	}
	return svc.DeleteSessionGroups(ctx, root, keys)
}
