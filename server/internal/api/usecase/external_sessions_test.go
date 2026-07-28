package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/session"
)

func TestExternalSessionDeltaAfterCtxSeqSkipsCopiedPrefix(t *testing.T) {
	exchanges := []agenttypes.ImportedExchange{
		{Role: "user", Content: "u1"},
		{Role: "agent", Content: "a1"},
		{Role: "user", Content: "u2"},
		{Role: "agent", Content: "a2"},
	}
	delta := externalSessionDeltaAfterCtxSeq(exchanges, 2)
	if len(delta) != 2 {
		t.Fatalf("len(delta) = %d, want 2", len(delta))
	}
	if delta[0].Content != "u2" || delta[1].Content != "a2" {
		t.Fatalf("delta = %#v", delta)
	}
}

func TestExternalSessionDeltaAfterCtxSeqReturnsEmptyWhenFullySynced(t *testing.T) {
	exchanges := []agenttypes.ImportedExchange{
		{Role: "user", Content: "u1"},
		{Role: "agent", Content: "a1"},
	}
	if delta := externalSessionDeltaAfterCtxSeq(exchanges, 2); len(delta) != 0 {
		t.Fatalf("delta = %#v, want empty", delta)
	}
}

func TestSyncExternalSessionDeltaFastDoesNotApplyCtxSeqToFilteredImport(t *testing.T) {
	root := fs.NewRootInfo("root", "Root", t.TempDir())
	manager := session.NewManager(root)
	created, err := manager.Create(context.Background(), session.CreateInput{
		Type:  session.TypeChat,
		Agent: "codex",
		Name:  "Imported",
	})
	if err != nil {
		t.Fatal(err)
	}
	lastTimestamp := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)
	if err := manager.AddExchangeForAgentAt(context.Background(), created, "user", "old", "codex", "", "", "", lastTimestamp); err != nil {
		t.Fatal(err)
	}
	current, err := manager.Get(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.UpdateAgentState(context.Background(), current, "codex", 10, "external-1"); err != nil {
		t.Fatal(err)
	}
	importer := &syncDeltaTestImporter{
		exchanges: []agenttypes.ImportedExchange{
			{Role: "user", Content: "new user", Timestamp: lastTimestamp.Add(time.Minute)},
			{Role: "agent", Content: "new agent", Timestamp: lastTimestamp.Add(2 * time.Minute)},
		},
	}
	svc := &Service{Registry: &syncDeltaTestRegistry{
		root:     root,
		manager:  manager,
		importer: importer,
	}}
	out, err := svc.SyncExternalSessionDelta(context.Background(), SyncExternalSessionDeltaInput{
		RootID: root.ID,
		Key:    created.Key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.ImportedCount != 2 {
		t.Fatalf("ImportedCount = %d, want 2", out.ImportedCount)
	}
	if importer.input.AfterTimestamp.IsZero() {
		t.Fatal("AfterTimestamp is zero, want fast sync to pass last timestamp")
	}
	latest, err := manager.Get(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(latest.Exchanges) != 3 {
		t.Fatalf("len(exchanges) = %d, want 3", len(latest.Exchanges))
	}
	if got := latest.Exchanges[1].Content; got != "new user" {
		t.Fatalf("exchange[1] = %q, want new user", got)
	}
	if got := latest.Exchanges[2].Content; got != "new agent" {
		t.Fatalf("exchange[2] = %q, want new agent", got)
	}
}

func TestImportExternalSessionOnlyPersistsSelectedAuxKinds(t *testing.T) {
	root := fs.NewRootInfo("root", "Root", t.TempDir())
	manager := session.NewManager(root)
	importer := &syncDeltaTestImporter{
		exchanges: []agenttypes.ImportedExchange{
			{Role: "user", Content: "inspect"},
			{
				Role:    "agent",
				Content: "done",
				Aux: []agenttypes.ImportedExchangeAux{{
					Line: 0,
					ToolCall: &agenttypes.ToolCall{
						CallID:  "read-1",
						Title:   "read README",
						Status:  "complete",
						Kind:    agenttypes.ToolKindRead,
						RawType: "tool_use",
						Meta:    map[string]any{"output": "contents"},
					},
				}, {
					Line: 0,
					ToolCall: &agenttypes.ToolCall{
						CallID: "execute-1",
						Title:  "go test ./...",
						Status: "complete",
						Kind:   agenttypes.ToolKindExecute,
					},
				}, {
					Line: 0,
					ToolCall: &agenttypes.ToolCall{
						CallID: "edit-1",
						Title:  "main.go",
						Status: "complete",
						Kind:   agenttypes.ToolKindEdit,
					},
				}, {
					Line: 0,
					ToolCall: &agenttypes.ToolCall{
						CallID: "plan-1",
						Title:  "update plan",
						Status: "complete",
						Kind:   agenttypes.ToolKindThink,
					},
				}, {
					Line: 0,
					ToolCall: &agenttypes.ToolCall{
						CallID: "ask-1",
						Title:  "ask user",
						Status: "complete",
						Kind:   agenttypes.ToolKindAskUser,
					},
				}},
			},
		},
	}
	svc := &Service{Registry: &syncDeltaTestRegistry{
		root:     root,
		manager:  manager,
		importer: importer,
	}}

	out, err := svc.ImportExternalSession(context.Background(), ImportExternalSessionInput{
		RootID:         root.ID,
		Agent:          "codex",
		AgentSessionID: "external-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	executeCall, err := manager.GetFullToolCall(context.Background(), out.SessionKey, "execute-1")
	if err != nil {
		t.Fatal(err)
	}
	if executeCall.Kind != agenttypes.ToolKindExecute {
		t.Fatalf("execute tool call = %#v", executeCall)
	}
	editCall, err := manager.GetFullToolCall(context.Background(), out.SessionKey, "edit-1")
	if err != nil {
		t.Fatal(err)
	}
	if editCall.Kind != agenttypes.ToolKindEdit {
		t.Fatalf("edit tool call = %#v", editCall)
	}
	planCall, err := manager.GetFullToolCall(context.Background(), out.SessionKey, "plan-1")
	if err != nil {
		t.Fatal(err)
	}
	if planCall.Kind != agenttypes.ToolKindThink {
		t.Fatalf("plan tool call = %#v", planCall)
	}
	askCall, err := manager.GetFullToolCall(context.Background(), out.SessionKey, "ask-1")
	if err != nil {
		t.Fatal(err)
	}
	if askCall.Kind != agenttypes.ToolKindAskUser {
		t.Fatalf("ask-user tool call = %#v", askCall)
	}
	if _, err := manager.GetFullToolCall(context.Background(), out.SessionKey, "read-1"); err == nil {
		t.Fatal("read tool call was persisted, want it filtered")
	}
}

func TestImportExternalSessionCreatesNativeSubagentSession(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "Root", t.TempDir())
	manager := session.NewManager(root)
	importer := &syncDeltaTestImporter{
		exchanges: []agenttypes.ImportedExchange{{Role: "user", Content: "delegate"}},
		subagents: []agenttypes.ImportedSubagentSession{{
			AgentSessionID:   "child-agent-1",
			ParentToolCallID: "spawn-1",
			Title:            "Investigate tests",
			Exchanges: []agenttypes.ImportedExchange{
				{Role: "user", Content: "inspect tests"},
				{Role: "agent", Content: "done"},
			},
		}},
	}
	svc := &Service{Registry: &syncDeltaTestRegistry{root: root, manager: manager, importer: importer}}
	out, err := svc.ImportExternalSession(ctx, ImportExternalSessionInput{
		RootID: root.ID, Agent: "codex", AgentSessionID: "parent-agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := manager.FindAgentBindingByAgentSession(ctx, "codex", "child-agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil {
		t.Fatal("subagent binding not created")
	}
	child, err := manager.Get(ctx, binding.SessionKey, 0)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentSessionKey != out.SessionKey || child.ParentToolCallID != "spawn-1" {
		t.Fatalf("subagent parent = (%q, %q), want (%q, spawn-1)", child.ParentSessionKey, child.ParentToolCallID, out.SessionKey)
	}
	if child.Name != "Investigate tests" || len(child.Exchanges) != 2 {
		t.Fatalf("subagent = %#v", child)
	}
}

func TestImportExternalSessionPersistsPlanAux(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "Root", t.TempDir())
	manager := session.NewManager(root)
	importer := &syncDeltaTestImporter{
		exchanges: []agenttypes.ImportedExchange{{
			Role: "agent",
			Aux: []agenttypes.ImportedExchangeAux{{
				Plan: &agenttypes.PlanUpdate{Content: "# Plan\n\n- Step"},
			}},
		}},
	}
	svc := &Service{Registry: &syncDeltaTestRegistry{root: root, manager: manager, importer: importer}}
	out, err := svc.ImportExternalSession(ctx, ImportExternalSessionInput{
		RootID: root.ID, Agent: "codex", AgentSessionID: "external-plan",
	})
	if err != nil {
		t.Fatal(err)
	}
	aux, err := manager.GetExchangeAux(ctx, out.SessionKey, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(aux[1]) != 1 || aux[1][0].Plan == nil || aux[1][0].Plan.Content != "# Plan\n\n- Step" {
		t.Fatalf("persisted aux = %#v", aux)
	}
}

type syncDeltaTestImporter struct {
	input     agenttypes.ImportExternalSessionInput
	exchanges []agenttypes.ImportedExchange
	subagents []agenttypes.ImportedSubagentSession
}

func (i *syncDeltaTestImporter) AgentName() string { return "codex" }

func (i *syncDeltaTestImporter) ListExternalSessions(context.Context, agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	return agenttypes.ListExternalSessionsResult{}, nil
}

func (i *syncDeltaTestImporter) ImportExternalSession(_ context.Context, in agenttypes.ImportExternalSessionInput) (agenttypes.ImportedExternalSession, error) {
	i.input = in
	return agenttypes.ImportedExternalSession{
		Agent:          i.AgentName(),
		AgentSessionID: in.AgentSessionID,
		Cwd:            in.RootPath,
		Exchanges:      i.exchanges,
		Subagents:      i.subagents,
	}, nil
}

type syncDeltaTestRegistry struct {
	root     fs.RootInfo
	manager  *session.Manager
	importer agenttypes.ExternalSessionImporter
}

func (r *syncDeltaTestRegistry) GetRoot(rootID string) (fs.RootInfo, error) {
	if rootID != r.root.ID {
		return fs.RootInfo{}, errors.New("root not found")
	}
	return r.root, nil
}

func (r *syncDeltaTestRegistry) GetSessionManager(string) (*session.Manager, error) {
	return r.manager, nil
}

func (r *syncDeltaTestRegistry) UpsertRoot(string) (fs.RootInfo, error) {
	return fs.RootInfo{}, errors.New("not implemented")
}

func (r *syncDeltaTestRegistry) RemoveRoot(string) (fs.RootInfo, error) {
	return fs.RootInfo{}, errors.New("not implemented")
}

func (r *syncDeltaTestRegistry) RenameRoot(string, string, string) (fs.RootInfo, error) {
	return fs.RootInfo{}, errors.New("not implemented")
}

func (r *syncDeltaTestRegistry) ListRoots() []fs.RootInfo { return nil }

func (r *syncDeltaTestRegistry) GetAgentPool() *agent.Pool { return nil }

func (r *syncDeltaTestRegistry) GetPreferences() *preferences.Store { return nil }

func (r *syncDeltaTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return r.importer, nil
}

func (r *syncDeltaTestRegistry) GetProber() *agent.Prober { return nil }

func (r *syncDeltaTestRegistry) GetCandidateRegistry() *CandidateRegistry { return nil }

func (r *syncDeltaTestRegistry) GetFileWatcher(string, *session.Manager) (*fs.SharedFileWatcher, error) {
	return nil, nil
}

func (r *syncDeltaTestRegistry) ReleaseFileWatcher(string, string) {}
