import { useI18n } from "../i18n";
import { rootBadgeButtonStyle } from "./rootBadgeStyle";
import "./MobileWorkspaceHeader.css";

type MobileWorkspaceHeaderProps = {
  projectLabel?: string | null;
  title?: string | null;
  onProjectClick?: () => void;
  onOpenFileSidebar: () => void;
  onOpenSessionSidebar: () => void;
  sidebarsSwapped?: boolean;
};

export function MobileWorkspaceHeader({
  projectLabel,
  title,
  onProjectClick,
  onOpenFileSidebar,
  onOpenSessionSidebar,
  sidebarsSwapped = false,
}: MobileWorkspaceHeaderProps) {
  const { t } = useI18n();
  const fileButton = (
    <button
      type="button"
      className="mobile-workspace-header__sidebar-button"
      data-mobile-sidebar="file"
      aria-label={t("sidebar.openFile")}
      title={t("sidebar.openFile")}
      onClick={onOpenFileSidebar}
    >
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          fill="currentColor"
          d="M3 3h6v4H3zm12 7h6v4h-6zm0 7h6v4h-6zm-2-4H7v5h6v2H5V9h2v2h6z"
          style={{ transform: "scale(1.28)", transformOrigin: "12px 12px" }}
        />
      </svg>
    </button>
  );
  const sessionButton = (
    <button
      type="button"
      className="mobile-workspace-header__sidebar-button"
      data-mobile-sidebar="session"
      aria-label={t("sidebar.openSession")}
      title={t("sidebar.openSession")}
      onClick={onOpenSessionSidebar}
    >
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
        <line x1="6" y1="4" x2="18" y2="4" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="6" y1="20" x2="18" y2="20" />
      </svg>
    </button>
  );

  return (
    <header className="mobile-workspace-header">
      {sidebarsSwapped ? sessionButton : fileButton}
      <div className={`mobile-workspace-header__content${title ? "" : " mobile-workspace-header__content--project-only"}`}>
        {projectLabel ? (
          onProjectClick ? (
            <button
              type="button"
              className="mobile-workspace-header__project"
              title={projectLabel}
              onClick={onProjectClick}
            >
              <span style={{ ...rootBadgeButtonStyle, padding: "6px 8px" }}>{projectLabel}</span>
            </button>
          ) : (
            <span className="mobile-workspace-header__project" style={{ ...rootBadgeButtonStyle, padding: "6px 8px" }} title={projectLabel}>
              <span>{projectLabel}</span>
            </span>
          )
        ) : null}
        {title ? <h1 className="mobile-workspace-header__title" title={title}>{title}</h1> : null}
      </div>
      {sidebarsSwapped ? fileButton : sessionButton}
    </header>
  );
}
