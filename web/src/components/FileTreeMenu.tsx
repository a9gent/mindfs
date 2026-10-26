import React from "react";
import { useI18n, type MessageKey } from "../i18n";

type MenuCategory = "files" | "agents" | "sessions" | "appearance" | "connections";
type MenuEntryProps = {
  "data-menu-category"?: MenuCategory;
  "data-menu-action"?: "add-project" | "transfer" | "guide";
  "data-menu-order"?: number;
};

const categories: { id: MenuCategory; label: MessageKey; path: string }[] = [
  { id: "files", label: "fileTree.menu.files", path: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" },
  { id: "agents", label: "fileTree.menu.agents", path: "M12 3v3M5 9h14v11H5ZM2 12v5M22 12v5M9 13h.01M15 13h.01M9 17h6" },
  { id: "sessions", label: "fileTree.menu.sessions", path: "M21 11a8 8 0 0 1-8 8H7l-4 3V5h10a8 8 0 0 1 8 6ZM7 9h10M7 13h7" },
  { id: "appearance", label: "fileTree.menu.appearance", path: "M3 4h18v13H3ZM8 21h8M12 17v4" },
  { id: "connections", label: "fileTree.menu.connections", path: "M8 12h8M5 8h3v8H5a4 4 0 0 1 0-8ZM19 8h-3v8h3a4 4 0 0 0 0-8Z" },
];

// Keep existing controls and callbacks in FileTree; explicit slots determine
// presentation without duplicating the settings' state or business behavior.
export function FileTreeMenu({ children, onCategoryChange }: { children: React.ReactNode; onCategoryChange: () => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState<MenuCategory | null>(null);
  const id = React.useId();
  const entries = React.Children.toArray(children).filter((child): child is React.ReactElement<MenuEntryProps> => React.isValidElement<MenuEntryProps>(child));
  const action = (name: MenuEntryProps["data-menu-action"]) => entries.filter(entry => entry.props["data-menu-action"] === name);
  const divider = <div role="separator" style={{ height: 1, background: "var(--border-color)", margin: "6px 4px" }} />;

  return <div role="group" aria-label={t("fileTree.menu.settings")} onKeyDown={event => {
    if (event.key === "Escape" && expanded) {
      event.stopPropagation();
      document.getElementById(`${id}-${expanded}-button`)?.focus();
      setExpanded(null); onCategoryChange();
    }
  }} style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: "var(--mindfs-file-menu-width, 220px)", maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 68px)", overflowY: "auto", overscrollBehavior: "contain", padding: 6, boxSizing: "border-box", whiteSpace: "nowrap", borderRadius: 10, border: "1px solid var(--border-color)", background: "var(--menu-bg)", boxShadow: "0 12px 30px rgba(15,23,42,.14)", zIndex: 20 }}>
    {action("add-project")}
    {divider}
    {categories.map(category => {
      const items = entries.filter(entry => entry.props["data-menu-category"] === category.id)
        .sort((a, b) => (a.props["data-menu-order"] || 0) - (b.props["data-menu-order"] || 0));
      if (!items.length) return null;
      const open = expanded === category.id;
      return <React.Fragment key={category.id}>
        <button type="button" id={`${id}-${category.id}-button`} aria-expanded={open} aria-controls={`${id}-${category.id}`} onClick={() => {
          setExpanded(open ? null : category.id); onCategoryChange();
        }} style={{ width: "100%", border: 0, borderRadius: 8, background: open ? "var(--selection-bg)" : "transparent", color: open ? "var(--accent-color)" : "var(--text-primary)", padding: "8px 10px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, textAlign: "left", cursor: "pointer" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d={category.path} /></svg>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "normal", lineHeight: 1.4 }}>{t(category.label)}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s ease", flexShrink: 0 }}><path d="m9 5 7 7-7 7" /></svg>
        </button>
        {open && <div id={`${id}-${category.id}`} role="group" aria-label={t(category.label)} style={{ margin: "2px 0 6px 9px", paddingLeft: 5, borderLeft: "1px solid var(--border-color)", whiteSpace: "normal" }}>{items}</div>}
      </React.Fragment>;
    })}
    {divider}
    {action("transfer")}
    {action("guide")}
  </div>;
}
