import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionViewer } from "../src/components/SessionViewer";
import { DeleteSessionDialog } from "../src/components/DeleteSessionDialog";
import { I18nProvider } from "../src/i18n";
import { sessionService } from "../src/services/session";
import { BottomSheet } from "../src/components/BottomSheet";
import { AppShell } from "../src/layout/AppShell";
import "../src/index.css";

const original = { key: "edit-check", type: "chat", name: "Edit check", exchanges: [
  {seq:1, role:"user", content:"Earlier message", timestamp:"2026-10-09T00:00:00Z"},
  {seq:2, role:"agent", content:"Earlier answer", timestamp:"2026-10-09T00:00:01Z"},
  {seq:3, role:"user", content:"Fix the wrong file", timestamp:"2026-10-09T00:00:02Z"},
  {seq:4, role:"agent", content:"Original reply", timestamp:"2026-10-09T00:00:03Z"},
] };
function Check() {
  const [session, setSession] = useState<any>(original);
  const [copied, setCopied] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const controls = ((window as any).editCheck ||= { fail: false, requests: [] });
  controls.headerActions ||= [];
  controls.openDelete = (kind: string) => setDeleteTarget(kind);
  sessionService.getSession = async () => ({ ...original, parent_session_key: deleteTarget === "child" ? "parent" : "" });
  sessionService.fetchChildSessions = async () => {
    if (deleteTarget === "error") throw new Error("Unable to load children");
    return deleteTarget === "parent" || deleteTarget === "child" ? [{ ...original, key: "child" }] : [];
  };
  sessionService.editMessage = async (...args) => {
    controls.requests.push(args);
    if (controls.deferEdit) await new Promise<void>((resolve) => { controls.releaseEdit = resolve; });
    if (controls.fail) throw new Error("Simulated failure: original conversation retained");
    setSession({...original, exchanges: [...original.exchanges.slice(0,2), {...original.exchanges[2],content:args[3]}, {...original.exchanges[3], content:"Regenerated reply"}]});
  };
  controls.streaming = () => setSession({...original, pending:true, exchanges:[...original.exchanges.slice(0,2), {...original.exchanges[2], seq:0}]});
  controls.task = () => setSession({...original, task_id:"edit-task"});
  controls.empty = () => setSession(null);
  controls.restore = () => setSession(original);
  controls.child = () => setSession({ ...original, parent_session_key: "parent" });
  controls.switchSession = () => setSession({ ...original, key: "other-session", name: "Other session" });
  sessionService.getSessionLogPath = async (root, key) => {
    controls.headerActions.push(["path", root, key]);
    return { path: "/fixture/session.log", agentSessionId: "agent-test" };
  };
  if (new URLSearchParams(location.search).has("drawer")) {
    return <I18nProvider><AppShell sidebar={null} main={null} leftOpen={false} rightOpen={false}
      footer={<div style={{height: 64}}>Composer</div>}
      drawer={<BottomSheet isOpen onClose={() => {}}><SessionViewer session={session} rootId="test" interactionMode="drawer" /></BottomSheet>} />
    </I18nProvider>;
  }
  return <I18nProvider><div style={{height:"100vh", display:"flex", flexDirection:"column", fontFamily:"sans-serif", background:"#fff", color:"#222"}}>
    {deleteTarget && <DeleteSessionDialog key={deleteTarget} rootId="test" sessionKey="edit-check" name="Edit check"
      onClose={() => setDeleteTarget(null)} onConfirm={async (keep) => { controls.headerActions.push(["confirmDelete", keep]); return true; }} />}
    <output>{copied}</output><SessionViewer session={session} rootId="test" onEditUserMessage={setCopied}
      onForkAgentMessage={(seq, independent) => { controls.headerActions.push(["fork", seq, independent]); }}
      onRenameSession={async (name) => { controls.headerActions.push(["rename", name]); if (controls.renameFail) return false; setSession((current: any) => ({ ...current, name })); return true; }}
      onDeleteSession={() => controls.headerActions.push(["delete"])}
      onDetachSession={() => { controls.headerActions.push(["detach"]); setSession((current: any) => ({ ...current, parent_session_key: "" })); }}
      onHandoffPack={() => controls.headerActions.push(["handoff"])}
      onScheduledTask={() => controls.headerActions.push(["scheduled"])} />
  </div></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Check/>);
