import React from "react";
import { createRoot } from "react-dom/client";
import { FileTree } from "../src/components/FileTree";
import { I18nProvider } from "../src/i18n";
import { bootstrapService } from "../src/services/bootstrap";
import { e2eeService } from "../src/services/e2ee";
import type { DirectorySortMode } from "../src/services/directorySort";
import { DEFAULT_FONT_SIZE_PREFERENCES } from "../src/services/fontSize";
import "../src/index.css";
import { useProjectSessionView } from "../src/hooks/useProjectSessionView";

bootstrapService.canUseProtectedAPI = () => true;
e2eeService.protectedFetch = (input, init) => fetch(input, init);
e2eeService.parseProtectedJSONResponse = response => response.json();

function Fixture() {
  const [sort, setSort] = React.useState<DirectorySortMode>("name-asc");
  const [hidden, setHidden] = React.useState(false);
  const [multi, setMulti] = React.useState(false);
  const [view, setView] = useProjectSessionView();
  const [swapped, setSwapped] = React.useState(false);
  const [diff, setDiff] = React.useState(false);
  const [enter, setEnter] = React.useState(false);
  const [fonts, setFonts] = React.useState(DEFAULT_FONT_SIZE_PREFERENCES);
  const [action, setAction] = React.useState("");
  return <I18nProvider>
    <aside data-testid="sidebar" style={{ width: 280, height: "100dvh", display: "flex", flexDirection: "column", background: "var(--sidebar-bg)", borderRight: "1px solid var(--border-color)" }}>
      <FileTree entries={[]} childrenByPath={{}} expanded={[]} sortMode={sort} onSortModeChange={setSort}
        showHiddenFiles={hidden} onShowHiddenFilesChange={setHidden}
        multiProjectSessionsEnabled={multi} onMultiProjectSessionsChange={setMulti}
        projectSessionView={view} onProjectSessionViewChange={setView}
        sidebarsSwapped={swapped} onSidebarsSwappedChange={setSwapped}
        gitDiffSideBySide={diff} onGitDiffSideBySideChange={setDiff}
        showEnterKeySendOption enterKeySends={enter} onEnterKeySendsChange={setEnter}
        showSendShortcutOption fontSizePreferences={fonts} onFontSizePreferencesChange={setFonts}
        onOpenProjectAdd={() => setAction("add-project")} onStartOnboarding={() => setAction("guide")} />
    </aside>
    <output data-testid="action">{action}</output>
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
