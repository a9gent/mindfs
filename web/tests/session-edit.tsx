import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionViewer } from "../src/components/SessionViewer";
import { I18nProvider } from "../src/i18n";
import { sessionService } from "../src/services/session";

const original = { key: "edit-check", type: "chat", name: "Edit check", exchanges: [
  {seq:1, role:"user", content:"Earlier message", timestamp:"2026-10-09T00:00:00Z"},
  {seq:2, role:"agent", content:"Earlier answer", timestamp:"2026-10-09T00:00:01Z"},
  {seq:3, role:"user", content:"Fix the wrong file", timestamp:"2026-10-09T00:00:02Z"},
  {seq:4, role:"agent", content:"Original reply", timestamp:"2026-10-09T00:00:03Z"},
] };
function Check() {
  const [session, setSession] = useState<any>(original);
  const [copied, setCopied] = useState("");
  const controls = ((window as any).editCheck ||= { fail: false, requests: [] });
  sessionService.editMessage = async (...args) => {
    controls.requests.push(args);
    if (controls.fail) throw new Error("Simulated failure: original conversation retained");
    setSession({...original, exchanges: [...original.exchanges.slice(0,2), {...original.exchanges[2],content:args[3]}, {...original.exchanges[3], content:"Regenerated reply"}]});
  };
  controls.streaming = () => setSession({...original, pending:true, exchanges:[...original.exchanges.slice(0,2), {...original.exchanges[2], seq:0}]});
  controls.task = () => setSession({...original, task_id:"edit-task"});
  return <I18nProvider><div style={{height:"100vh", display:"flex", flexDirection:"column", fontFamily:"sans-serif", background:"#fff", color:"#222"}}>
    <output>{copied}</output><SessionViewer session={session} rootId="test" onEditUserMessage={setCopied}/>
  </div></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Check/>);
