package usecase

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/session"
)

func TestSaveUploadedFilesDefaultsToAttachmentDirAndRenamesConflicts(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	service := Service{Registry: uploadTestRegistry{root: root}}

	out, err := service.SaveUploadedFiles(context.Background(), SaveUploadedFilesInput{
		RootID: "mindfs",
		Files: []UploadFile{
			{
				Name:        "demo.txt",
				ContentType: "text/plain; charset=utf-8",
				Reader:      bytes.NewBufferString("first file"),
			},
			{
				Name:        "demo.txt",
				ContentType: "text/plain",
				Reader:      bytes.NewBufferString("second file"),
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveUploadedFiles returned error: %v", err)
	}
	if len(out.Files) != 2 {
		t.Fatalf("expected 2 saved files, got %d", len(out.Files))
	}

	dateDir := time.Now().Format("2006-01-02")
	wantFirst := filepath.ToSlash(filepath.Join(".mindfs", "upload", dateDir, "demo.txt"))
	wantSecond := filepath.ToSlash(filepath.Join(".mindfs", "upload", dateDir, "demo (1).txt"))
	if out.Files[0].Path != wantFirst {
		t.Fatalf("first upload path = %q, want %q", out.Files[0].Path, wantFirst)
	}
	if out.Files[1].Path != wantSecond {
		t.Fatalf("second upload path = %q, want %q", out.Files[1].Path, wantSecond)
	}
	if out.Files[0].Mime != "text/plain" {
		t.Fatalf("first upload mime = %q, want text/plain", out.Files[0].Mime)
	}
	if out.Files[1].Name != "demo (1).txt" {
		t.Fatalf("second upload name = %q, want %q", out.Files[1].Name, "demo (1).txt")
	}

	assertFileContent(t, filepath.Join(rootDir, filepath.FromSlash(wantFirst)), "first file")
	assertFileContent(t, filepath.Join(rootDir, filepath.FromSlash(wantSecond)), "second file")
}

func TestSaveUploadedFilesUsesExplicitDir(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	service := Service{Registry: uploadTestRegistry{root: root}}

	out, err := service.SaveUploadedFiles(context.Background(), SaveUploadedFilesInput{
		RootID: "mindfs",
		Dir:    "design",
		Files: []UploadFile{
			{
				Name:        "spec.pdf",
				ContentType: "application/pdf",
				Reader:      bytes.NewBufferString("pdf-bytes"),
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveUploadedFiles returned error: %v", err)
	}
	if len(out.Files) != 1 {
		t.Fatalf("expected 1 saved file, got %d", len(out.Files))
	}
	if out.Files[0].Path != "design/spec.pdf" {
		t.Fatalf("saved path = %q, want %q", out.Files[0].Path, "design/spec.pdf")
	}
	assertFileContent(t, filepath.Join(rootDir, "design", "spec.pdf"), "pdf-bytes")
}

func TestFileCandidateProviderSearch(t *testing.T) {
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(rootDir, "design", "18-view-plugin.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "design", "14-json-render-refactoring.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "node_modules", "pkg", "index.js"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".git", "config"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".mindfs", "state.json"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".DS_Store"), "a")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewFileCandidateProvider()
	items, err := provider.Search(context.Background(), root, "", "design")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "design/18-view-plugin.md" {
		t.Fatalf("expected shorter matching path first, got %q", items[0].Name)
	}
	for _, item := range items {
		switch item.Name {
		case "node_modules/pkg/index.js", ".git/config", ".mindfs/state.json", ".DS_Store":
			t.Fatalf("unexpected filtered path in results: %q", item.Name)
		}
	}
}

func TestSkillCandidateProviderSearch(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Home status skill\n---\n")
	mustWriteFile(t, filepath.Join(homeDir, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Shared review skill\n---\n")
	mustWriteFile(t, filepath.Join(rootDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Root status skill\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 unique items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "review" && items[0].Name != "status" {
		t.Fatalf("unexpected first item: %#v", items[0])
	}
	descriptionByName := make(map[string]string, len(items))
	for _, item := range items {
		descriptionByName[item.Name] = item.Description
	}
	if got := descriptionByName["status"]; got != "Home status skill" {
		t.Fatalf("expected first scanned status skill to win, got %q", got)
	}
	if got := descriptionByName["review"]; got != "Shared review skill" {
		t.Fatalf("unexpected review description: %q", got)
	}
}

func TestCommandCandidatesFromStatus(t *testing.T) {
	provider := NewSlashCommandCandidateProvider(func(agentName string) (agent.Status, bool) {
		if agentName != "claude" {
			return agent.Status{}, false
		}
		return agent.Status{
			Name: "claude",
			Commands: []agenttypes.CommandInfo{
				{Name: "review", Description: "Review current changes"},
				{Name: "memory", Description: "Manage memory"},
			},
		}, true
	})
	items, err := provider.Search(context.Background(), rootfs.RootInfo{}, "claude", "re")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 command candidate, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypeSlashCommand {
		t.Fatalf("expected slash command candidate, got %#v", items[0])
	}
	if items[0].Name != "review" {
		t.Fatalf("expected review command, got %#v", items[0])
	}
}

func TestMergeCandidateItemsPreferSlash(t *testing.T) {
	items := mergeCandidateItemsPreferSlash([]CandidateItem{
		{Type: CandidateTypeSlashCommand, Name: "review", Description: "Slash review"},
	}, []CandidateItem{
		{Type: CandidateTypeSkill, Name: "review", Description: "Skill review"},
		{Type: CandidateTypeSkill, Name: "refactor", Description: "Skill refactor"},
	}, "")
	if len(items) != 2 {
		t.Fatalf("expected 2 unique candidates, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypeSlashCommand || items[0].Name != "review" {
		t.Fatalf("expected slash command to win dedupe, got %#v", items[0])
	}
	if items[1].Name != "refactor" {
		t.Fatalf("expected refactor to remain, got %#v", items[1])
	}
}

func TestPromptStoreAppendMovesExistingToLatestAndLimits(t *testing.T) {
	store := &PromptStore{filePath: filepath.Join(t.TempDir(), "prompts.json")}
	for i := 0; i < maxPromptItems; i++ {
		if _, err := store.Append("prompt-" + strconv.Itoa(i)); err != nil {
			t.Fatalf("Append(%d) returned error: %v", i, err)
		}
	}
	items, err := store.Append("prompt-10")
	if err != nil {
		t.Fatalf("Append(existing) returned error: %v", err)
	}
	if len(items) != maxPromptItems {
		t.Fatalf("expected %d prompts after move, got %d", maxPromptItems, len(items))
	}
	if items[len(items)-1] != "prompt-10" {
		t.Fatalf("expected moved prompt at end, got %q", items[len(items)-1])
	}
	items, err = store.Append("prompt-new")
	if err != nil {
		t.Fatalf("Append(new) returned error: %v", err)
	}
	if len(items) != maxPromptItems {
		t.Fatalf("expected %d prompts after limit, got %d", maxPromptItems, len(items))
	}
	for _, item := range items {
		if item == "prompt-0" {
			t.Fatalf("expected oldest prompt to be trimmed, got %#v", items)
		}
	}
	if items[len(items)-1] != "prompt-new" {
		t.Fatalf("expected newest prompt at end, got %q", items[len(items)-1])
	}
}

func TestPromptCandidateProviderSearchReturnsNewestFirst(t *testing.T) {
	store := &PromptStore{filePath: filepath.Join(t.TempDir(), "prompts.json")}
	for _, item := range []string{"first prompt", "second prompt", "another"} {
		if _, err := store.Append(item); err != nil {
			t.Fatalf("Append(%q) returned error: %v", item, err)
		}
	}
	provider := NewPromptCandidateProvider(store)
	items, err := provider.Search(context.Background(), rootfs.RootInfo{}, "", "prompt")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 prompt matches, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypePrompt || items[0].Name != "second prompt" {
		t.Fatalf("expected newest prompt first, got %#v", items[0])
	}
	if items[1].Name != "first prompt" {
		t.Fatalf("expected older prompt second, got %#v", items[1])
	}
}

func TestBuildUserPromptSelectionOnly(t *testing.T) {
	got := buildUserPrompt("hello", ClientContext{})
	if strings.Contains(got, "[USER_SELECTION]") {
		t.Fatalf("did not expect user selection block without selection: %q", got)
	}

	got = buildUserPrompt("hello", ClientContext{
		Selection: &Selection{
			FilePath: "design/README.md",
		},
	})
	if !strings.Contains(got, "[USER_SELECTION]\nfile: design/README.md") {
		t.Fatalf("expected file-only user selection block, got %q", got)
	}

	got = buildUserPrompt("hello", ClientContext{
		Selection: &Selection{
			FilePath:  "design/README.md",
			StartLine: 1,
			EndLine:   3,
			Text:      "abc",
		},
	})
	if !strings.Contains(got, "[USER_SELECTION]\nfile: design/README.md") {
		t.Fatalf("expected user selection block, got %q", got)
	}
}

func TestSessionNameScore(t *testing.T) {
	testCases := []struct {
		name    string
		message string
		want    int
	}{
		{name: "empty", message: "", want: 0},
		{name: "chinese", message: "请帮我排查会话列表刷新问题", want: 13},
		{name: "english token counts once", message: "abcdefghijkl", want: 1},
		{name: "mixed", message: "修复 session list refresh", want: 5},
		{name: "punctuation ignored", message: "fix, bug!", want: 2},
		{name: "digits join token", message: "fix v2 api", want: 3},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sessionNameScore(tc.message); got != tc.want {
				t.Fatalf("sessionNameScore(%q) = %d, want %d", tc.message, got, tc.want)
			}
		})
	}
}

func TestNormalizeSessionNameCandidateOnlyCleans(t *testing.T) {
	input := "  \"这是 一个 很长 的 标题 candidate with trailing punctuation!!!\"  "
	want := "这是 一个 很长 的 标题 candidate with trailing punctuation"
	if got := normalizeSessionNameCandidate(input); got != want {
		t.Fatalf("normalizeSessionNameCandidate(%q) = %q, want %q", input, got, want)
	}
}

func TestSessionNameRunnerRealAgent(t *testing.T) {
	if os.Getenv("MINDFS_RUN_REAL_AGENT") != "1" {
		t.Skip("set MINDFS_RUN_REAL_AGENT=1 to run real agent interaction test")
	}

	cfg, err := agent.LoadConfig("")
	if err != nil {
		t.Skipf("LoadConfig failed: %v", err)
	}

	agentName, ok := selectRunnableAgent(cfg)
	if !ok {
		t.Skip("no runnable configured agent found (set MINDFS_IT_AGENT_NAME)")
	}

	pool := agent.NewPool(cfg)
	defer pool.CloseAll()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	got, err := sessionNameRunner(ctx, pool, t.TempDir(), SuggestSessionNameInput{
		SessionKey:   "real-it-" + time.Now().UTC().Format("20060102-150405"),
		Agent:        agentName,
		FirstMessage: "Please help me investigate why the session list does not refresh immediately after a new session is created.",
	})
	if err != nil {
		t.Fatalf("sessionNameRunner returned error: %v", err)
	}
	if strings.TrimSpace(got) == "" {
		t.Fatal("sessionNameRunner returned empty title")
	}
	if strings.Contains(got, "\n") {
		t.Fatalf("sessionNameRunner returned multi-line title: %q", got)
	}
}

func TestSessionNameRunnerSkipsWithoutAgentOrPool(t *testing.T) {
	testCases := []struct {
		name  string
		input SuggestSessionNameInput
	}{
		{
			name: "missing agent",
			input: SuggestSessionNameInput{
				SessionKey:   "s-1",
				FirstMessage: "hello world session title",
			},
		},
		{
			name: "missing pool",
			input: SuggestSessionNameInput{
				SessionKey:   "s-1",
				Agent:        "codex",
				FirstMessage: "hello world session title",
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sessionNameRunner(context.Background(), nil, "/tmp/root", tc.input)
			if err != nil || got != "" {
				t.Fatalf("sessionNameRunner = (%q, %v), want empty nil", got, err)
			}
		})
	}
}

func TestAppendResponseChunk(t *testing.T) {
	testCases := []struct {
		name     string
		current  string
		lastType string
		chunk    string
		want     string
	}{
		{
			name:     "plain message append",
			current:  "Hello",
			lastType: string(agenttypes.EventTypeMessageChunk),
			chunk:    " world",
			want:     "Hello world",
		},
		{
			name:     "insert separator after thought",
			current:  "First paragraph.",
			lastType: string(agenttypes.EventTypeThoughtChunk),
			chunk:    "Second paragraph.",
			want:     "First paragraph.\n\nSecond paragraph.",
		},
		{
			name:     "insert separator after tool call update",
			current:  "Result summary.",
			lastType: string(agenttypes.EventTypeToolUpdate),
			chunk:    "Follow-up details.",
			want:     "Result summary.\n\nFollow-up details.",
		},
		{
			name:     "keep existing trailing newline",
			current:  "Result summary.\n",
			lastType: string(agenttypes.EventTypeToolCall),
			chunk:    "Follow-up details.",
			want:     "Result summary.\nFollow-up details.",
		},
		{
			name:     "no prefix on empty response",
			current:  "",
			lastType: string(agenttypes.EventTypeToolCall),
			chunk:    "Fresh text.",
			want:     "Fresh text.",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := appendResponseChunk(tc.current, tc.lastType, tc.chunk); got != tc.want {
				t.Fatalf("appendResponseChunk(%q, %q, %q) = %q, want %q", tc.current, tc.lastType, tc.chunk, got, tc.want)
			}
		})
	}
}

func assertFileContent(t *testing.T, path string, want string) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q): %v", path, err)
	}
	if string(payload) != want {
		t.Fatalf("file content = %q, want %q", string(payload), want)
	}
}

func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func selectRunnableAgent(cfg agent.Config) (string, bool) {
	want := strings.TrimSpace(os.Getenv("MINDFS_IT_AGENT_NAME"))
	if want != "" {
		def, ok := cfg.GetAgent(want)
		if !ok {
			return "", false
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			return "", false
		}
		return want, true
	}

	for _, name := range []string{"codex", "claude", "gemini"} {
		def, ok := cfg.GetAgent(name)
		if !ok {
			continue
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			continue
		}
		return name, true
	}
	return "", false
}

type uploadTestRegistry struct {
	root rootfs.RootInfo
}

func (r uploadTestRegistry) GetRoot(rootID string) (rootfs.RootInfo, error) {
	if rootID != r.root.ID {
		return rootfs.RootInfo{}, errors.New("root not found")
	}
	return r.root, nil
}

func (uploadTestRegistry) GetSessionManager(string) (*session.Manager, error) {
	return nil, nil
}

func (uploadTestRegistry) UpsertRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (uploadTestRegistry) RemoveRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (uploadTestRegistry) ListRoots() []rootfs.RootInfo {
	return nil
}

func (uploadTestRegistry) GetAgentPool() *agent.Pool {
	return nil
}

func (uploadTestRegistry) GetPreferences() *preferences.Store {
	return nil
}

func (uploadTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return nil, errors.New("not implemented")
}

func (uploadTestRegistry) GetProber() *agent.Prober {
	return nil
}

func (uploadTestRegistry) GetCandidateRegistry() *CandidateRegistry {
	return nil
}

func (uploadTestRegistry) GetFileWatcher(string, *session.Manager) (*rootfs.SharedFileWatcher, error) {
	return nil, nil
}

func (uploadTestRegistry) ReleaseFileWatcher(string, string) {}
