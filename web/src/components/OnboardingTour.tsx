import React from "react";
import { createPortal } from "react-dom";
import { useI18n, type MessageKey } from "../i18n";

type TourStep = {
  id: string;
  target: string;
  fallbackTarget?: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  interactive?: boolean;
  padding?: number;
  pinToTop?: boolean;
};

const TOUR_STEPS: TourStep[] = [
  { id: "sidebar-menu", target: "[data-onboarding='sidebar-menu']", titleKey: "onboarding.sidebarMenu.title", bodyKey: "onboarding.sidebarMenu.body", pinToTop: true },
  { id: "project-tabs", target: "[data-onboarding='project-tabs']", titleKey: "onboarding.projectTabs.title", bodyKey: "onboarding.projectTabs.body", pinToTop: true },
  { id: "project-home", target: "[data-onboarding='project-home']", titleKey: "onboarding.projectHome.title", bodyKey: "onboarding.projectHome.body", pinToTop: true },
  { id: "main-menu", target: "[data-onboarding='main-menu']", titleKey: "onboarding.mainMenu.title", bodyKey: "onboarding.mainMenu.body", pinToTop: true },
  { id: "task-templates", target: "[data-onboarding='task-templates']", titleKey: "onboarding.taskTemplates.title", bodyKey: "onboarding.taskTemplates.body" },
  { id: "task-template-menu", target: "[data-onboarding='task-template-menu']", titleKey: "onboarding.taskTemplateMenu.title", bodyKey: "onboarding.taskTemplateMenu.body" },
  { id: "tasks", target: "[data-onboarding='task-create']", titleKey: "onboarding.tasks.title", bodyKey: "onboarding.tasks.body" },
  { id: "session-actions", target: "[data-onboarding='session-actions']", titleKey: "onboarding.sessionActions.title", bodyKey: "onboarding.sessionActions.body", padding: 1, pinToTop: true },
  { id: "shortcuts", target: "[data-onboarding='message-input']", titleKey: "onboarding.shortcuts.title", bodyKey: "onboarding.shortcuts.body" },
  { id: "session-ring", target: "[data-onboarding='session-ring']", titleKey: "onboarding.sessionRing.title", bodyKey: "onboarding.sessionRing.body" },
  { id: "mode-selector", target: "[data-onboarding='mode-selector']", titleKey: "onboarding.modeSelector.title", bodyKey: "onboarding.modeSelector.body", interactive: true },
  { id: "agent-selector", target: "[data-onboarding='agent-selector']", fallbackTarget: "[data-onboarding='input-controls']", titleKey: "onboarding.agentSelector.title", bodyKey: "onboarding.agentSelector.body", interactive: true },
  { id: "attachment-action", target: "[data-onboarding='attachment-action']", titleKey: "onboarding.attachmentAction.title", bodyKey: "onboarding.attachmentAction.body" },
  { id: "send-action", target: "[data-onboarding='send-action']", titleKey: "onboarding.sendAction.title", bodyKey: "onboarding.sendAction.body" },
];

type OnboardingTourProps = {
  open: boolean;
  isMobile: boolean;
  onStepChange?: (stepId: string) => void;
  onComplete: () => void;
  onDismiss: () => void;
};

type TargetRect = Pick<DOMRect, "top" | "left" | "right" | "bottom" | "width" | "height">;

export function OnboardingTour({
  open,
  isMobile,
  onStepChange,
  onComplete,
  onDismiss,
}: OnboardingTourProps) {
  const { t } = useI18n();
  const [stepIndex, setStepIndex] = React.useState(0);
  const [targetRect, setTargetRect] = React.useState<TargetRect | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  const step = TOUR_STEPS[stepIndex];

  React.useEffect(() => {
    if (!open) return;
    setStepIndex(0);
  }, [open]);

  React.useEffect(() => {
    if (!open || !step) return;
    onStepChange?.(step.id);

    let frame = 0;
    let settleTimer = 0;
    const updateRect = () => {
      const element = document.querySelector<HTMLElement>(step.target)
        ?? (step.fallbackTarget ? document.querySelector<HTMLElement>(step.fallbackTarget) : null);
      const rect = element?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const padding = step.padding ?? 5;
        setTargetRect({
          top: step.pinToTop ? 0 : Math.max(6, rect.top - padding),
          left: Math.max(6, rect.left - padding),
          right: Math.min(window.innerWidth - 6, rect.right + padding),
          bottom: step.pinToTop
            ? rect.height + padding * 2
            : Math.min(window.innerHeight - 6, rect.bottom + padding),
          width: Math.min(window.innerWidth - 12, rect.width + padding * 2),
          height: Math.min(window.innerHeight - 12, rect.height + padding * 2),
        });
      } else {
        setTargetRect(null);
      }
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateRect);
    };
    scheduleUpdate();
    settleTimer = window.setTimeout(scheduleUpdate, 320);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [onStepChange, open, step]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
      if (event.key === "ArrowLeft" && stepIndex > 0) setStepIndex((value) => value - 1);
      if (event.key === "ArrowRight") {
        if (stepIndex === TOUR_STEPS.length - 1) onComplete();
        else setStepIndex((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onComplete, onDismiss, open, stepIndex]);

  React.useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open, stepIndex]);

  if (!open || !step || typeof document === "undefined") return null;

  const positionTarget = targetRect;
  const cardWidth = Math.min(360, window.innerWidth - 24);
  const cardLeft = isMobile
    ? 12
    : Math.max(12, Math.min(
        window.innerWidth - cardWidth - 12,
        positionTarget ? positionTarget.left + positionTarget.width / 2 - cardWidth / 2 : window.innerWidth / 2 - cardWidth / 2,
      ));
  const placeBelow = positionTarget ? positionTarget.bottom + 220 < window.innerHeight : false;
  const cardPosition: React.CSSProperties = isMobile
    ? { left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }
    : {
        left: cardLeft,
        top: positionTarget
          ? placeBelow
            ? positionTarget.bottom + 14
            : Math.max(12, positionTarget.top - 214)
          : "50%",
        transform: positionTarget ? undefined : "translateY(-50%)",
        width: cardWidth,
      };

  const overlayZIndex = step.interactive ? 900 : 5000;
  const spotlightZIndex = overlayZIndex + 1;
  const blockerStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: overlayZIndex,
    pointerEvents: "auto",
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("onboarding.dialogLabel")}>
      {step.interactive && targetRect ? (
        <>
          <div style={{ ...blockerStyle, top: 0, left: 0, right: 0, height: targetRect.top }} />
          <div style={{ ...blockerStyle, top: targetRect.bottom, left: 0, right: 0, bottom: 0 }} />
          <div style={{ ...blockerStyle, top: targetRect.top, left: 0, width: targetRect.left, height: targetRect.height }} />
          <div style={{ ...blockerStyle, top: targetRect.top, left: targetRect.right, right: 0, height: targetRect.height }} />
        </>
      ) : (
        <div style={{ ...blockerStyle, inset: 0 }} />
      )}
      {targetRect ? (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            zIndex: spotlightZIndex,
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
            borderRadius: 12,
            border: "2px solid var(--accent-color)",
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.62), 0 0 0 5px rgba(59, 130, 246, 0.18)",
            pointerEvents: "none",
            transition: "all 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)",
          }}
        />
      ) : (
        <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: spotlightZIndex, background: "rgba(15, 23, 42, 0.62)", pointerEvents: "none" }} />
      )}
      <div
        ref={cardRef}
        tabIndex={-1}
        style={{
          position: "fixed",
          zIndex: 5002,
          ...cardPosition,
          boxSizing: "border-box",
          border: "1px solid var(--panel-border)",
          borderRadius: 14,
          background: "var(--panel-bg)",
          color: "var(--text-primary)",
          boxShadow: "0 20px 60px rgba(15, 23, 42, 0.28)",
          padding: "16px",
          outline: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "var(--accent-color)", fontWeight: 750 }}>
            {t("onboarding.progress", { current: stepIndex + 1, total: TOUR_STEPS.length })}
          </span>
          <button type="button" onClick={onDismiss} style={quietButtonStyle}>
            {t("onboarding.skip")}
          </button>
        </div>
        <div style={{ fontSize: 17, lineHeight: 1.35, fontWeight: 750, marginBottom: 7 }}>{t(step.titleKey)}</div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-secondary)", minHeight: 43 }}>{t(step.bodyKey)}</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 16 }}>
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
            style={{ ...secondaryButtonStyle, opacity: stepIndex === 0 ? 0.45 : 1 }}
          >
            {t("onboarding.previous")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (stepIndex === TOUR_STEPS.length - 1) onComplete();
              else setStepIndex((value) => value + 1);
            }}
            style={primaryButtonStyle}
          >
            {stepIndex === TOUR_STEPS.length - 1 ? t("onboarding.finish") : t("onboarding.next")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const quietButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  padding: "4px 0",
  cursor: "pointer",
  fontSize: 12,
};

const secondaryButtonStyle: React.CSSProperties = {
  height: 34,
  border: "1px solid var(--border-color)",
  borderRadius: 9,
  background: "transparent",
  color: "var(--text-primary)",
  padding: "0 13px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 650,
};

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: "1px solid var(--accent-color)",
  background: "var(--accent-color)",
  color: "#fff",
  minWidth: 78,
};
