import React, { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ComposerPopover } from "./ComposerPopover";
import { ModeIcon } from "./ModeIcon";
import type { SessionMode } from "./ModeSelector";

const modes: SessionMode[] = ["chat", "plugin", "command"];

function ModeOptions({ mode, onModeChange, disabled }: {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return <div className="composer-mode-options" role="group" aria-label={t("mode.title")}>
    {modes.map((value) => <button key={value} type="button" className="composer-menu-action" aria-pressed={mode === value} disabled={disabled} onClick={() => onModeChange(value)}>
      <ModeIcon type={value} size={19} /><span>{t(`mode.${value}`)}</span>
      {mode === value ? <span className="composer-menu-check" aria-hidden="true">✓</span> : null}
    </button>)}
  </div>;
}

export function ComposerModeSelector({ mode, onModeChange, disabled, isMobile }: {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  disabled?: boolean;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={anchorRef} type="button" className="composer-mode-trigger" data-onboarding="mode-selector" disabled={disabled} aria-label={t("mode.title")} title={t(`mode.${mode}`)} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <ModeIcon type={mode} size={19} /><span>{t(mode === "chat" ? "composer.chatMode" : `mode.${mode}`)}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <ComposerPopover open={open && !disabled} onClose={() => setOpen(false)} anchorRef={anchorRef} isMobile={isMobile} title={t("mode.title")} className="composer-mode-popover">
      <ModeOptions mode={mode} onModeChange={(value) => { onModeChange(value); setOpen(false); }} />
    </ComposerPopover>
  </>;
}

export function ComposerMoreMenu({ mode, onModeChange, modeLocked, attachmentDisabled, hasAttachments, onAddAttachment, onNewSession, onToggleFileSidebar, onToggleSessionSidebar, onOpenGestureSettings }: {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  modeLocked: boolean;
  attachmentDisabled: boolean;
  hasAttachments: boolean;
  onAddAttachment: () => void;
  onNewSession: () => void;
  onToggleFileSidebar?: () => void;
  onToggleSessionSidebar?: () => void;
  onOpenGestureSettings?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const run = (action: () => void) => { setOpen(false); action(); };
  return <>
    <button ref={anchorRef} type="button" className="composer-more-trigger" data-has-attachments={hasAttachments || undefined} aria-label={t("composer.more")} title={t("composer.more")} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
    <ComposerPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} isMobile title={t("composer.more")}>
      <button type="button" className="composer-menu-action" disabled={attachmentDisabled} onClick={() => run(onAddAttachment)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8" /></svg>{t("action.addAttachment")}
      </button>
      <button type="button" className="composer-menu-action" onClick={() => run(onNewSession)}><span className="composer-menu-symbol" aria-hidden="true">＋</span>{t("blueRing.action.newSession")}</button>
      <div className="composer-menu-divider" />
      <div className="composer-menu-label">{t("mode.title")}</div>
      <ModeOptions mode={mode} disabled={modeLocked} onModeChange={(value) => run(() => onModeChange(value))} />
      <div className="composer-menu-divider" />
      {onToggleFileSidebar ? <button type="button" className="composer-menu-action" onClick={() => run(onToggleFileSidebar)}>{t("sidebar.openFile")}</button> : null}
      {onToggleSessionSidebar ? <button type="button" className="composer-menu-action" onClick={() => run(onToggleSessionSidebar)}>{t("sidebar.openSession")}</button> : null}
      {onOpenGestureSettings ? <button type="button" className="composer-menu-action" onClick={() => run(onOpenGestureSettings)}>{t("action.sessionMenu.gestures")}</button> : null}
    </ComposerPopover>
  </>;
}
