import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentSelector } from "../src/components/AgentSelector";
import { I18nProvider } from "../src/i18n";
import { bootstrapService } from "../src/services/bootstrap";
import { e2eeService } from "../src/services/e2ee";
import { fetchAgents, type AgentStatus } from "../src/services/agents";
import "../src/index.css";

// Exercise the actual preferences service and selector, without requiring
// pairing/encryption in this fixture. Playwright supplies the HTTP backend.
bootstrapService.canUseProtectedAPI = () => true;
e2eeService.protectedFetch = (input, init) => fetch(input, init);
e2eeService.parseProtectedJSONResponse = (response) => response.json();
function Fixture() {
  const [selection, setSelection] = useState("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  useEffect(() => { void fetchAgents(true).then(setAgents); }, []);
  return <I18nProvider><main style={{ padding: 20 }}>
    <output data-testid="selection">{selection}</output>
    {agents.length ? <AgentSelector agent="codex" agents={agents} defaultExpandOptions menuPlacement="bottom" onAgentChange={(agent, model) => setSelection(`${agent}:${model}`)} /> : null}
  </main></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
