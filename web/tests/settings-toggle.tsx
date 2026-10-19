import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileTree } from "../src/components/FileTree";
import { I18nProvider } from "../src/i18n";
import { AppShell } from "../src/layout/AppShell";
import "../src/index.css";

function Harness() {
  const [enterSends, setEnterSends] = useState(false);
  const [ringEnabled, setRingEnabled] = useState(false);
  const [menuLog, setMenuLog] = useState<string[]>([]);
  const params = new URLSearchParams(location.search);
  const withShell = params.has("shell");

  const tree = (
    <FileTree
      entries={[]}
      childrenByPath={{}}
      expanded={[]}
      sortMode="name-asc"
      showEnterKeySendOption
      enterKeySends={enterSends}
      onEnterKeySendsChange={(v) => { setEnterSends(v); setMenuLog((l) => [...l, `enter:${v}`]); }}
      showSendShortcutOption
      sendShortcut={null}
      onSendShortcutChange={() => {}}
      blueRingGestures={{ enabled: ringEnabled, actions: {} as never }}
      onBlueRingGesturesChange={(c) => { setRingEnabled(c.enabled); setMenuLog((l) => [...l, `ring:${c.enabled}`]); }}
      taskTemplates={[]}
      onStartOnboarding={() => {}}
    />
  );

  const controls = ((window as any).settingsToggle = {});
  controls.state = () => ({ enterSends, ringEnabled, menuLog });

  if (withShell) {
    return (
      <AppShell sidebar={tree} main={<div style={{ padding: 8 }}>main</div>} footer={<div style={{ height: 56 }}>footer</div>} leftOpen rightOpen={false} onCloseLeft={() => {}} />
    );
  }
  return <div style={{ height: "100vh", width: 320 }}>{tree}</div>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><Harness /></I18nProvider>);
