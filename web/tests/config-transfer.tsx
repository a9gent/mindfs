import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigTransferDialog } from "../src/components/ConfigTransferDialog";
import { I18nProvider } from "../src/i18n";
import { bootstrapService } from "../src/services/bootstrap";
import { e2eeService } from "../src/services/e2ee";
import "../src/index.css";

bootstrapService.canUseProtectedAPI = () => true;
e2eeService.protectedFetch = (input, init) => fetch(input, init);
e2eeService.parseProtectedJSONResponse = response => response.json();

function Fixture() {
  const [open, setOpen] = React.useState(true);
  return <I18nProvider><aside data-testid="sidebar" style={{ width: 280, height: "100dvh", background: "var(--sidebar-bg)" }}>
    <div style={{ position: "relative", height: 36 }}>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      {open && <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, right: 3 }}><ConfigTransferDialog onClose={() => setOpen(false)} /></div>}
    </div>
  </aside></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
