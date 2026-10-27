import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MultiProjectSessionList, SessionList, type SessionItem, type ProjectSessionGroup } from "../src/components/SessionList";
import { sessionService } from "../src/services/session";
import { bootstrapService } from "../src/services/bootstrap";
import { e2eeService } from "../src/services/e2ee";
import { I18nProvider } from "../src/i18n";
import { FileTree } from "../src/components/FileTree";
import { useProjectSessionView } from "../src/hooks/useProjectSessionView";

bootstrapService.canUseProtectedAPI = () => true;
e2eeService.protectedFetch = (input, init) => fetch(input, init);
e2eeService.parseProtectedJSONResponse = response => response.json();

function Fixture() {
  const [view, setView] = useProjectSessionView();
  const [enabled, setEnabled] = useState(true);
  const [groups, setGroups] = useState<ProjectSessionGroup[]>([
    { rootId: "a", rootName: "Project A", totalCount: 4, sessions: [
      { key: "pinned", session_key: "pinned", name: "Old pinned", updated_at: "2026-10-01T00:00:00Z", pinned_at: "2026-10-26T00:00:00Z" },
      { key: "same", session_key: "same", name: "A recent", updated_at: "2026-10-25T00:00:00Z" },
      { key: "fallback", session_key: "fallback", name: "Created only", created_at: "2026-10-23T00:00:00Z" },
    ] },
    { rootId: "b", rootName: "Project B", totalCount: 1, sessions: [
      { key: "same", session_key: "same", name: "B newest", updated_at: "2026-10-26T00:00:00Z" },
      { key: "child", session_key: "child", parent_session_key: "same", name: "Child session", updated_at: "2026-10-24T00:00:00Z" },
    ] },
  ]);
  const [selected, setSelected] = useState("");
  const detach = async (session: SessionItem) => {
    try {
      const updated = await sessionService.detachSession(session.root_id!, session.key);
      setGroups(current => current.map(group => group.rootId !== session.root_id ? group : {
        ...group, totalCount: group.totalCount + 1,
        sessions: group.sessions.map(item => item.key !== session.key ? item : { ...item, ...updated }),
      }));
      setSelected("detached");
    } catch { setSelected("detach failed"); }
  };
  if (new URLSearchParams(location.search).has("single")) return <I18nProvider>
    <output>{selected}</output><SessionList selectedKey="same" sessions={groups.filter(group => group.rootId === "b").flatMap(group => group.sessions.map(item => ({ ...item, root_id: group.rootId })))} onDetach={detach} />
  </I18nProvider>;
  return <I18nProvider><div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ height: 80, flexShrink: 0 }}>
      <FileTree entries={[]} childrenByPath={{}} expanded={[]}
        multiProjectSessionsEnabled={enabled} onMultiProjectSessionsChange={setEnabled}
        projectSessionView={view} onProjectSessionViewChange={setView} />
    </div>
    <output>{selected}</output>
    <MultiProjectSessionList groups={groups} viewMode={view} selectedKey="same" selectedRootId="b"
      onDetach={detach}
      onSelect={(session) => setSelected(`${session.root_id}:${session.key}`)}
      onProjectClick={(root) => setSelected(`project:${root}`)}
      onPin={(session, pinned) => {
        setGroups((current) => current.map((group) => group.rootId !== session.root_id ? group : {
          ...group, sessions: group.sessions.map((item) => item.key !== session.key ? item : {
            ...item, pinned_at: pinned ? "2026-10-27T00:00:00Z" : null,
          }),
        }));
        return true;
      }}
      onLoadMoreProject={async (group) => {
        setGroups((current) => current.map((item) => item.rootId !== group.rootId ? item : {
          ...item, sessions: [...item.sessions, { key: "older", session_key: "older", name: "Loaded session", updated_at: "2026-10-22T00:00:00Z" }],
        }));
      }} />
  </div></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
