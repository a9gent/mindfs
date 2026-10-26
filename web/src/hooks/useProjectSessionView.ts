import { useEffect, useState } from "react";

export type ProjectSessionView = "grouped" | "flat";
const STORAGE_KEY = "mindfs-project-session-view";

export function useProjectSessionView() {
  const [view, setView] = useState<ProjectSessionView>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "flat" ? "flat" : "grouped";
    } catch {
      return "grouped";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, view);
    } catch {
      // The view remains usable when browser storage is unavailable.
    }
  }, [view]);
  return [view, setView] as const;
}
