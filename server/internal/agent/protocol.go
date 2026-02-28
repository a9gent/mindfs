package agent

// Protocol defines the communication protocol for an agent.
type Protocol string

const (
	// ProtocolACP is the Agent Client Protocol (JSON-RPC 2.0 over ndJSON).
	// Claude/Gemini default to ACP wrappers.
	ProtocolACP Protocol = "acp"
	// ProtocolClaudeSDK uses claude-agent-sdk-go stream-json transport.
	ProtocolClaudeSDK Protocol = "claude-sdk"
	// ProtocolCodexSDK uses codex-go-sdk app-server transport.
	ProtocolCodexSDK Protocol = "codex-sdk"
)

// DefaultProtocol returns the default protocol for agents.
func DefaultProtocol(agentName string) Protocol {
	if agentName == "claude" {
		return ProtocolClaudeSDK
	}
	if agentName == "codex" {
		return ProtocolCodexSDK
	}
	return ProtocolACP
}
