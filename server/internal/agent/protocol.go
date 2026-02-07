package agent

// Protocol defines the communication protocol for an agent.
type Protocol string

const (
	// ProtocolACP is the Agent Client Protocol (JSON-RPC 2.0 over ndJSON).
	// All agents (Claude, Gemini, Codex) now use ACP via their respective wrappers.
	ProtocolACP Protocol = "acp"
)

// DefaultProtocol returns the default protocol for agents.
// All agents now use ACP.
func DefaultProtocol(agentName string) Protocol {
	return ProtocolACP
}
