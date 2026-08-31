import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  app,
  /const DEFAULT_MAIN_CONTENT_VIEW_STORAGE_KEY = "mindfs-default-main-content-view"/,
  "the last manually selected main view should have its own persisted preference",
);
assert.match(
  app,
  /function loadDefaultMainContentView\(\): MainContentViewMode[\s\S]*?isMainContentViewMode\(saved\) \? saved : "task-kanban"/,
  "task board should remain the fallback until the user chooses another view",
);
assert.match(
  app,
  /const currentMainContentView: MainContentViewMode =[\s\S]*?mainContentViewByRoot\[currentRootId\]\)\s*\|\|\s*defaultMainContentView/,
  "a project-specific choice should win while untouched projects inherit the remembered default",
);
assert.match(
  app,
  /const handleMainContentViewChange = useCallback[\s\S]*?setMainContentViewForRoot\(rootID, mode\);[\s\S]*?setDefaultMainContentView\(mode\)/,
  "manual view changes should update both the project choice and the default for untouched projects",
);
const onboardingTaskSetup = app.match(
  /if \(showingTasks && currentRootId\) \{([\s\S]*?)\n    \}/,
)?.[1] || "";
assert.doesNotMatch(
  onboardingTaskSetup,
  /setMainContentViewForRoot|setDefaultMainContentView/,
  "programmatic onboarding navigation should not mark a project as manually switched",
);
assert.match(
  onboardingTaskSetup,
  /setOnboardingMainContentViewRoot\(currentRootId\)/,
  "onboarding should use a transient board override so its task steps stay visible",
);
