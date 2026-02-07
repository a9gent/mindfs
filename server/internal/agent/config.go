package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config holds all agent configurations.
type Config struct {
	Agents map[string]Definition `json:"agents"`
}

// Definition defines how to spawn and communicate with an agent.
type Definition struct {
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

	// Transport configuration
	Transport TransportConfig `json:"transport,omitempty"`

	// ProbeArgs are arguments for availability check.
	ProbeArgs []string `json:"probeArgs,omitempty"`
}

// TransportConfig holds protocol-specific timing and filtering settings.
type TransportConfig struct {
	// InitTimeout is the maximum time to wait for agent initialization.
	InitTimeout time.Duration `json:"initTimeout,omitempty"`

	// IdleTimeout is the time without output before considering response complete.
	IdleTimeout time.Duration `json:"idleTimeout,omitempty"`

	// FilterPatterns are regex patterns for stdout lines to filter out.
	FilterPatterns []string `json:"filterPatterns,omitempty"`
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
			return defaultConfig(), nil
		}
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.Agents == nil {
		cfg.Agents = map[string]Definition{}
	}
	// Apply defaults
	for name, def := range cfg.Agents {
		if def.Protocol == "" {
			def.Protocol = DefaultProtocol(name)
		}
		cfg.Agents[name] = def
	}
	return cfg, nil
}

func defaultConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "mindfs", "agents.json"), nil
}

// defaultConfig returns built-in agent definitions.
// All agents now use ACP protocol via their respective ACP wrappers.
func defaultConfig() Config {
	return Config{
		Agents: map[string]Definition{
			"claude": {
				Command:  "claude",
				Protocol: ProtocolACP,
				Args:     []string{"--acp"},
				Transport: TransportConfig{
					InitTimeout: 30 * time.Second,
					IdleTimeout: 500 * time.Millisecond,
				},
			},
			"gemini": {
				Command:  "gemini",
				Protocol: ProtocolACP,
				Args:     []string{"--experimental-acp"},
				Transport: TransportConfig{
					InitTimeout: 120 * time.Second, // Gemini needs longer init
					IdleTimeout: 500 * time.Millisecond,
				},
			},
			"codex": {
				Command:  "codex",
				Protocol: ProtocolACP,
				Args:     []string{"--acp"},
				Transport: TransportConfig{
					InitTimeout: 30 * time.Second,
					IdleTimeout: 500 * time.Millisecond,
				},
			},
		},
	}
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

// GetInitTimeout returns the initialization timeout.
func (d Definition) GetInitTimeout() time.Duration {
	if d.Transport.InitTimeout > 0 {
		return d.Transport.InitTimeout
	}
	return 30 * time.Second
}

// GetIdleTimeout returns the idle timeout for response completion detection.
func (d Definition) GetIdleTimeout() time.Duration {
	if d.Transport.IdleTimeout > 0 {
		return d.Transport.IdleTimeout
	}
	return 500 * time.Millisecond
}
