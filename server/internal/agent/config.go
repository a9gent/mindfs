package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	configpkg "mindfs/server/internal/config"
)

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

	// CwdTemplate is the working directory template ({root} is replaced).
	CwdTemplate string `json:"cwdTemplate,omitempty"`

	// ProbeArgs are arguments for availability check.
	ProbeArgs []string `json:"probeArgs,omitempty"`
}

// LoadConfig loads agent configuration from the given path or default location.
func LoadConfig(path string) (Config, error) {
	if path == "" {
		resolved, err := defaultConfigPath()
		if err != nil {
			return Config{}, err
		}
		path = resolved
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			if fallbackPath, fallbackErr := installedDefaultConfigPath(); fallbackErr == nil {
				if fallbackPayload, readErr := os.ReadFile(fallbackPath); readErr == nil {
					payload = fallbackPayload
				} else if !os.IsNotExist(readErr) {
					return Config{}, readErr
				} else {
					return defaultConfig(), nil
				}
			} else {
				return defaultConfig(), nil
			}
		} else {
			return Config{}, err
		}
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return Config{}, err
	}
	// Apply defaults and validate.
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

func defaultConfigPath() (string, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "agents.json"), nil
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
