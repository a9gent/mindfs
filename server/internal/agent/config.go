package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	configpkg "mindfs/server/internal/config"
)

const configPathEnvKey = "MINDFS_AGENTS_CONFIG"

// Config holds all agent configurations.
type Config struct {
	Agents       []Definition `json:"agents"`
	RelayBaseURL string       `json:"relayBaseURL,omitempty"`
}

// Definition defines how to spawn and communicate with an agent.
type Definition struct {
	// Name is the logical agent name (e.g. codex/claude/gemini).
	Name string `json:"name"`

	// Command is the executable name or path.
	Command string `json:"command"`

	// Protocol specifies the communication protocol (stream-json, acp, mcp).
	// If empty, defaults based on agent name.
	Protocol Protocol `json:"protocol,omitempty"`

	// Args are base arguments always passed to the command.
	Args []string `json:"args,omitempty"`

	// Env are additional environment variables.
	Env map[string]string `json:"env,omitempty"`

	// ConfigBackup stores default inputs for config backup flows.
	ConfigBackup ConfigBackupDefaults `json:"configBackup,omitempty"`

	// CwdTemplate is the working directory template ({root} is replaced).
	CwdTemplate string `json:"cwdTemplate,omitempty"`

	// ProbeArgs are arguments for availability check.
	ProbeArgs []string `json:"probeArgs,omitempty"`
}

type ConfigBackupDefaults struct {
	FileSources []string `json:"fileSources,omitempty"`
	EnvKeys     []string `json:"envKeys,omitempty"`
}

// LoadConfig loads agent configuration from the given path or default location.
func LoadConfig(path string) (Config, error) {
	if path != "" {
		return loadConfigFile(path)
	}

	resolved, err := defaultConfigPath()
	if err != nil {
		return Config{}, err
	}
	baseCfg, basePath, err := loadInstalledDefaultConfig()
	if err != nil {
		return Config{}, err
	}
	if samePath(resolved, basePath) {
		return baseCfg, nil
	}

	userCfg, err := loadConfigFile(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return baseCfg, nil
		}
		return Config{}, err
	}
	return mergeConfigs(baseCfg, userCfg), nil
}

func loadConfigFile(path string) (Config, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return Config{}, err
	}
	return normalizeConfig(cfg)
}

func loadInstalledDefaultConfig() (Config, string, error) {
	if fallbackPath, fallbackErr := installedDefaultConfigPath(); fallbackErr == nil {
		if cfg, err := loadConfigFile(fallbackPath); err == nil {
			return cfg, fallbackPath, nil
		} else if !os.IsNotExist(err) {
			return Config{}, "", err
		}
	}
	cfg, err := normalizeConfig(defaultConfig())
	return cfg, "", err
}

func normalizeConfig(cfg Config) (Config, error) {
	cfg.RelayBaseURL = strings.TrimSpace(cfg.RelayBaseURL)
	for i := range cfg.Agents {
		name := strings.TrimSpace(cfg.Agents[i].Name)
		if name == "" {
			return Config{}, fmt.Errorf("agent name required")
		}
		cfg.Agents[i].Name = name
		if cfg.Agents[i].Protocol == "" {
			cfg.Agents[i].Protocol = DefaultProtocol(name)
		}
	}
	return cfg, nil
}

func mergeConfigs(base Config, override Config) Config {
	merged := Config{
		Agents:       append([]Definition(nil), base.Agents...),
		RelayBaseURL: base.RelayBaseURL,
	}
	if override.RelayBaseURL != "" {
		merged.RelayBaseURL = override.RelayBaseURL
	}

	agentIndexes := make(map[string]int, len(merged.Agents))
	for i, agent := range merged.Agents {
		agentIndexes[agent.Name] = i
	}
	for _, agent := range override.Agents {
		if index, ok := agentIndexes[agent.Name]; ok {
			merged.Agents[index] = agent
			continue
		}
		agentIndexes[agent.Name] = len(merged.Agents)
		merged.Agents = append(merged.Agents, agent)
	}
	return merged
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA == nil && errB == nil {
		return absA == absB
	}
	return a == b
}

func defaultConfigPath() (string, error) {
	return ResolveConfigPath()
}

func ResolveConfigPath() (string, error) {
	if hinted := strings.TrimSpace(os.Getenv(configPathEnvKey)); hinted != "" {
		return hinted, nil
	}
	if shouldPreferWorkingDirConfig() {
		if cwd, err := os.Getwd(); err == nil {
			candidate := filepath.Join(cwd, "agents.json")
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "agents.json"), nil
}

func shouldPreferWorkingDirConfig() bool {
	if len(os.Args) == 0 {
		return false
	}
	arg0 := strings.TrimSpace(os.Args[0])
	if arg0 == "" {
		return false
	}
	return strings.HasPrefix(arg0, "."+string(os.PathSeparator))
}

func installedDefaultConfigPath() (string, error) {
	installDir, err := configpkg.MindFSInstallDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(installDir, "agents.json"), nil
}

// defaultConfig returns built-in agent definitions.
func defaultConfig() Config {
	return Config{
		Agents: []Definition{
			{
				Name:     "claude",
				Command:  "claude",
				Protocol: ProtocolClaudeSDK,
			},
			{
				Name:     "gemini",
				Command:  "gemini",
				Protocol: ProtocolACP,
				Args:     []string{"--experimental-acp"},
			},
			{
				Name:     "codex",
				Command:  "codex",
				Protocol: ProtocolCodexSDK,
			},
		},
	}
}

// GetAgent returns an agent definition by name.
func (c Config) GetAgent(name string) (Definition, bool) {
	for _, a := range c.Agents {
		if a.Name == name {
			return a, true
		}
	}
	return Definition{}, false
}

// BuildArgs constructs the full argument list for spawning.
func (d Definition) BuildArgs(rootPath string) []string {
	args := append([]string{}, d.Args...)
	if d.CwdTemplate != "" && rootPath != "" {
		// Some agents need explicit path argument
	}
	return args
}

// ResolveCwd returns the working directory for the agent.
func (d Definition) ResolveCwd(rootPath string) string {
	if d.CwdTemplate == "" {
		return rootPath
	}
	return strings.ReplaceAll(d.CwdTemplate, "{root}", rootPath)
}
