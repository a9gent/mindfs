package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

func loadPoolTestConfig(t *testing.T) Config {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("runtime.Caller failed")
	}
	cfgPath := filepath.Join(filepath.Dir(thisFile), "testdata", "agents.json")
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadConfig(%s) failed: %v", cfgPath, err)
	}
	return cfg
}

func TestPoolGetOrCreateRequiresSessionKey(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "session key required") {
		t.Fatalf("expected session key required error, got: %v", err)
	}
}

func TestPoolGetOrCreateUnknownAgent(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-1",
		AgentName:  "unknown-agent",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "agent not configured") {
		t.Fatalf("expected agent not configured error, got: %v", err)
	}
}

func TestPoolGetOrCreateUsesAgentsJSONConfig(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	def, ok := cfg.GetAgent("gemini")
	if !ok {
		t.Fatalf("expected gemini in test agents.json")
	}
	def.Command = "this-command-should-not-exist-for-tests"
	for i := range cfg.Agents {
		if cfg.Agents[i].Name == "gemini" {
			cfg.Agents[i] = def
		}
	}

	pool := NewPool(cfg)
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-2",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil {
		t.Fatalf("expected start error from non-existent command")
	}
	if !strings.Contains(err.Error(), "this-command-should-not-exist-for-tests") {
		t.Fatalf("expected overridden command in error, got: %v", err)
	}
}

func TestPoolCloseAndCloseAll(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	pool.sessions["s-3"] = &sessionEntry{
		agentName:  "test-agent",
		sessionKey: "s-3",
		session:    nil,
	}

	pool.Close("s-3")
	if _, ok := pool.sessions["s-3"]; ok {
		t.Fatalf("expected session removed after Close")
	}

	pool.CloseAll()
	if len(pool.sessions) != 0 {
		t.Fatalf("expected sessions cleared by CloseAll")
	}
}

func TestPoolGetOrCreateAfterCloseAll(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	pool.CloseAll()

	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-closed",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "agent pool closed") {
		t.Fatalf("expected agent pool closed error, got: %v", err)
	}
}

func TestPoolConfigReturnsLoadedConfig(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	pool := NewPool(cfg)

	got := pool.Config()
	if _, ok := got.GetAgent("gemini"); !ok {
		t.Fatalf("expected gemini in pool config")
	}
}

func TestPoolUpdateConfigAppliesRuntimeEnvWithoutFreezingHostedFields(t *testing.T) {
	local := Config{
		Agents: []Definition{
			{Name: "codex", Command: "local-codex", Brief: "local brief", Env: map[string]string{"LOCAL": "1"}},
		},
	}
	hostedV1 := Config{
		Agents: []Definition{
			{Name: "codex", Command: "hosted-codex", Brief: "hosted brief v1"},
			{Name: "hosted-only", Command: "hosted-only", Brief: "hosted only v1"},
		},
	}
	pool := NewPool(MergeHostedConfig(hostedV1, local))
	if err := pool.SetAgentEnv("codex", map[string]string{"RUNTIME": "1"}); err != nil {
		t.Fatalf("SetAgentEnv: %v", err)
	}

	hostedV2 := Config{
		Agents: []Definition{
			{Name: "codex", Command: "hosted-codex-v2", Brief: "hosted brief v2"},
			{Name: "hosted-only", Command: "hosted-only-v2", Brief: "hosted only v2"},
		},
	}
	effective := pool.UpdateConfig(MergeHostedConfig(hostedV2, local))

	codex, ok := effective.GetAgent("codex")
	if !ok {
		t.Fatalf("expected codex")
	}
	if codex.Command != "local-codex" || codex.Brief != "local brief" {
		t.Fatalf("local override not preserved: %+v", codex)
	}
	if !reflect.DeepEqual(codex.Env, map[string]string{"RUNTIME": "1"}) {
		t.Fatalf("runtime env not preserved: %#v", codex.Env)
	}
	hostedOnly, ok := effective.GetAgent("hosted-only")
	if !ok {
		t.Fatalf("expected hosted-only")
	}
	if hostedOnly.Command != "hosted-only-v2" || hostedOnly.Brief != "hosted only v2" {
		t.Fatalf("hosted update was frozen: %+v", hostedOnly)
	}
}

func TestProbeInstalledAgentWithPoolSkipsMissingCommand(t *testing.T) {
	def := Definition{
		Name:    "missing-agent",
		Command: "mindfs-test-agent-command-that-does-not-exist",
	}
	status := probeInstallStatus(def.Name, def, time.Now().UTC())
	if status.Installed {
		t.Fatalf("test command unexpectedly exists in PATH")
	}

	got := probeInstalledAgentWithPool(context.Background(), def.Name, def, nil, nil, status, probePhaseBackground)
	if got.Installed {
		t.Fatalf("missing command should not be marked installed: %+v", got)
	}
	if got.Available {
		t.Fatalf("missing command should not be available: %+v", got)
	}
	if !strings.Contains(got.ProbeError, def.Command) {
		t.Fatalf("probe error = %q, want command name", got.ProbeError)
	}
}

func TestLoadConfigReadsShells(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	var want []Shell
	if runtime.GOOS == "windows" {
		want = []Shell{{Command: "pwsh", Args: []string{"-NoLogo", "-NoProfile", "-Command"}, LongShellArgs: []string{"-NoLogo", "-NoProfile"}, CommandPrefix: windowsPowerShellCommandPrefix(), OS: []string{"windows"}}}
	} else {
		want = []Shell{
			{Command: "zsh", Args: []string{"-ic"}, LongShellArgs: []string{}, OS: []string{"darwin", "linux"}},
			{Command: "bash", Args: []string{"-ic"}, LongShellArgs: []string{}, OS: []string{"darwin", "linux"}},
			{Command: "sh", Args: []string{"-lc"}, LongShellArgs: []string{}, OS: []string{"darwin", "linux"}},
		}
	}
	if got := cfg.Shells; !reflect.DeepEqual(got, want) {
		t.Fatalf("shells = %#v, want %#v", got, want)
	}
}

func TestNormalizeConfigFiltersShellsByOS(t *testing.T) {
	cfg, err := normalizeConfig(Config{
		Shells: []Shell{
			{Command: "zsh", Args: []string{"-ic"}, OS: []string{"darwin", "linux"}},
			{Command: "pwsh", Args: []string{"-NoLogo", "-NoProfile", "-Command"}, OS: []string{"windows"}},
			{Command: "portable", Args: []string{"-c"}},
		},
		Agents: []Definition{{Name: "codex", Command: "codex"}},
	})
	if err != nil {
		t.Fatalf("normalizeConfig: %v", err)
	}
	for _, shell := range cfg.Shells {
		if len(shell.OS) == 0 {
			continue
		}
		matched := false
		for _, value := range shell.OS {
			if value == runtime.GOOS {
				matched = true
			}
		}
		if !matched {
			t.Fatalf("shell %q with os %#v should have been filtered on %s", shell.Command, shell.OS, runtime.GOOS)
		}
	}
}

func TestLoadConfigReadsOMPAgent(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	def, ok := cfg.GetAgent("omp")
	if !ok {
		t.Fatalf("expected omp in test agents.json")
	}
	if def.Command != "omp" || def.Protocol != ProtocolACP {
		t.Fatalf("omp definition = command %q protocol %q", def.Command, def.Protocol)
	}
	if len(def.Args) != 1 || def.Args[0] != "acp" {
		t.Fatalf("omp args = %#v", def.Args)
	}
}

func TestMergeConfigsKeepsBundledAgentsAndAppliesUserOverrides(t *testing.T) {
	base := Config{
		Shells: []Shell{{Command: "zsh", Args: []string{"-ic"}}, {Command: "bash", Args: []string{"-ic"}}},
		Agents: []Definition{
			{
				Name:            "codex",
				Brief:           "bundled brief",
				Command:         "codex",
				Protocol:        ProtocolCodexSDK,
				InstallCommands: LifecycleCommands{"install codex"},
				UpdateCommands:  LifecycleCommands{"update codex"},
				ConfigBackup:    ConfigBackupDefaults{FileSources: []string{"~/.codex/auth.json"}, EnvKeys: []string{"CODEX_HOME"}},
			},
			{Name: "new-agent", Command: "new-agent", Protocol: ProtocolACP},
		},
	}
	override := Config{
		Shells: []Shell{{Command: "fish", Args: []string{"-i", "-c"}}, {Command: "zsh", Args: []string{"-ic"}}},
		Agents: []Definition{
			{Name: "codex", Command: "custom-codex", Protocol: ProtocolCodexSDK, Args: []string{"--profile", "work"}},
			{Name: "local-agent", Command: "local-agent", Protocol: ProtocolACP},
		},
	}

	cfg := mergeConfigs(base, override)
	wantShells := []Shell{
		{Command: "fish", Args: []string{"-i", "-c"}},
		{Command: "zsh", Args: []string{"-ic"}},
		{Command: "bash", Args: []string{"-ic"}},
	}
	if !reflect.DeepEqual(cfg.Shells, wantShells) {
		t.Fatalf("shells = %#v, want %#v", cfg.Shells, wantShells)
	}
	if len(cfg.Agents) != 3 {
		t.Fatalf("agents length = %d, want 3", len(cfg.Agents))
	}
	codex, ok := cfg.GetAgent("codex")
	if !ok {
		t.Fatalf("expected codex")
	}
	if codex.Command != "custom-codex" || len(codex.Args) != 2 {
		t.Fatalf("codex override not applied: %+v", codex)
	}
	if codex.Brief != "bundled brief" {
		t.Fatalf("codex brief = %q, want bundled brief", codex.Brief)
	}
	if !reflect.DeepEqual(codex.InstallCommands, LifecycleCommands{"install codex"}) {
		t.Fatalf("codex install commands = %#v", codex.InstallCommands)
	}
	if !reflect.DeepEqual(codex.UpdateCommands, LifecycleCommands{"update codex"}) {
		t.Fatalf("codex update commands = %#v", codex.UpdateCommands)
	}
	if !reflect.DeepEqual(codex.ConfigBackup.FileSources, []string{"~/.codex/auth.json"}) {
		t.Fatalf("codex config backup file sources = %#v", codex.ConfigBackup.FileSources)
	}
	if !reflect.DeepEqual(codex.ConfigBackup.EnvKeys, []string{"CODEX_HOME"}) {
		t.Fatalf("codex config backup env keys = %#v", codex.ConfigBackup.EnvKeys)
	}
	if _, ok := cfg.GetAgent("new-agent"); !ok {
		t.Fatalf("expected bundled new-agent to be preserved")
	}
	if _, ok := cfg.GetAgent("local-agent"); !ok {
		t.Fatalf("expected user local-agent to be appended")
	}
}

func TestLoadConfigFiltersLifecycleCommandsByOS(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "agents.json")
	otherOS := "linux"
	if runtime.GOOS == "linux" {
		otherOS = "darwin"
	}
	payload := `{
  "agents": [
    {
      "name": "codex",
      "command": "codex",
      "installCommands": [
        "legacy install",
        {"os": "` + runtime.GOOS + `", "command": "current install"},
        {"os": "` + otherOS + `", "command": "other install"}
      ],
      "updateCommands": [
        {"os": ["` + runtime.GOOS + `"], "command": "current update"},
        {"os": ["` + otherOS + `"], "command": "other update"}
      ]
    }
  ]
}`
	if err := os.WriteFile(configPath, []byte(payload), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	def, ok := cfg.GetAgent("codex")
	if !ok {
		t.Fatalf("expected codex")
	}
	if !reflect.DeepEqual(def.InstallCommands, LifecycleCommands{"legacy install", "current install"}) {
		t.Fatalf("install commands = %#v", def.InstallCommands)
	}
	if !reflect.DeepEqual(def.UpdateCommands, LifecycleCommands{"current update"}) {
		t.Fatalf("update commands = %#v", def.UpdateCommands)
	}
}

func TestInstalledDefaultConfigPathPrefersExecutableDirectory(t *testing.T) {
	tempDir := t.TempDir()
	exeDir := filepath.Join(tempDir, "archive")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatalf("mkdir exe dir: %v", err)
	}
	configPath := filepath.Join(exeDir, "agents.json")
	if err := os.WriteFile(configPath, []byte(`{"agents":[{"name":"zip-agent","command":"zip-agent"}]}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	got := installedDefaultConfigPathFromExecutable(filepath.Join(exeDir, "mindfs.exe"))
	if got != configPath {
		t.Fatalf("installedDefaultConfigPathFromExecutable() = %q, want %q", got, configPath)
	}
}

func TestInstalledDefaultConfigPathFallsBackToInstalledLayout(t *testing.T) {
	tempDir := t.TempDir()
	exeDir := filepath.Join(tempDir, "bin")
	want := filepath.Join(tempDir, "share", "mindfs", "agents.json")

	got := installedDefaultConfigPathFromExecutable(filepath.Join(exeDir, "mindfs.exe"))
	if got != want {
		t.Fatalf("installedDefaultConfigPathFromExecutable() = %q, want %q", got, want)
	}
}

func TestLoadConfigPrefersAgentsConfigEnv(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "agents.json")
	if err := os.WriteFile(configPath, []byte(`{"agents":[{"name":"env-agent","command":"env-agent"}]}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv(configPathEnvKey, configPath)

	cfg, err := LoadConfig("")
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if _, ok := cfg.GetAgent("env-agent"); !ok {
		t.Fatalf("expected env-agent from %s", configPathEnvKey)
	}
}

func TestLoadConfigWithExtraMergesSingleExtraConfigAfterDefaultConfig(t *testing.T) {
	tempDir := t.TempDir()
	userConfigPath := filepath.Join(tempDir, "user-agents.json")
	extraConfigPath := filepath.Join(tempDir, "extra-agents.json")
	if err := os.WriteFile(userConfigPath, []byte(`{
  "agents": [
    {"name":"user-agent","command":"user-agent","brief":"from user"},
    {"name":"shared-agent","command":"user-shared","brief":"from user"}
  ]
}`), 0o644); err != nil {
		t.Fatalf("write user config: %v", err)
	}
	if err := os.WriteFile(extraConfigPath, []byte(`{
  "agents": [
    {"name":"extra-agent","command":"extra-agent","brief":"from extra"},
    {"name":"shared-agent","command":"extra-shared","brief":"from extra"}
  ]
}`), 0o644); err != nil {
		t.Fatalf("write extra config: %v", err)
	}
	t.Setenv(configPathEnvKey, userConfigPath)

	cfg, err := LoadConfigWithExtra(extraConfigPath)
	if err != nil {
		t.Fatalf("LoadConfigWithExtra failed: %v", err)
	}
	if _, ok := cfg.GetAgent("user-agent"); !ok {
		t.Fatalf("expected user-agent to remain")
	}
	if _, ok := cfg.GetAgent("extra-agent"); !ok {
		t.Fatalf("expected extra-agent to be appended")
	}
	shared, ok := cfg.GetAgent("shared-agent")
	if !ok {
		t.Fatalf("expected shared-agent")
	}
	if shared.Command != "extra-shared" || shared.Brief != "from extra" {
		t.Fatalf("extra config should override same-name user config, got %+v", shared)
	}
}
