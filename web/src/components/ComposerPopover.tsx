import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import "./ComposerPopover.css";

type ComposerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  isMobile: boolean;
  title: string;
  className?: string;
  children: ReactNode;
};

/** Anchored on desktop and a keyboard-aware bottom sheet on mobile. */
export function ComposerPopover({ open, onClose, anchorRef, isMobile, title, className = "", children }: ComposerPopoverProps) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      if (!panel || !anchor) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const fontScaleStyle = {
        "--mindfs-font-scale": getComputedStyle(anchor).getPropertyValue("--mindfs-font-scale").trim() || "1",
      } as CSSProperties;
      if (isMobile) {
        setPosition({ ...fontScaleStyle, left, width, bottom: Math.max(0, window.innerHeight - top - height), maxHeight: Math.max(0, height - 16) });
      } else {
        const rect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const spaceAbove = rect.top - top - 16;
        const spaceBelow = top + height - rect.bottom - 16;
        const above = spaceAbove >= Math.min(panelRect.height, 280) || spaceAbove >= spaceBelow;
        const maxHeight = Math.max(80, above ? spaceAbove : spaceBelow);
        setPosition({
          ...fontScaleStyle,
          left: Math.max(left + 8, Math.min(rect.left, left + width - panelRect.width - 8)),
          top: above ? Math.max(top + 8, rect.top - Math.min(panelRect.height, maxHeight) - 8) : rect.bottom + 8,
          maxWidth: Math.max(0, width - 16),
          maxHeight,
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    const fontRegion = anchorRef.current?.closest(".mindfs-font-scale-region");
    const fontObserver = new MutationObserver(update);
    if (fontRegion) fontObserver.observe(fontRegion, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      fontObserver.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, isMobile, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focusing the sheet itself avoids opening the phone keyboard immediately.
    panel?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'))
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
        event.preventDefault();
        first.focus();
      }
    };
    // A mobile backdrop must stay mounted until the tap completes, otherwise
    // the release or compatibility click can reach controls underneath it.
    if (!isMobile) document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown, true);
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) {
        const fallback = anchorRef.current?.matches("button") ? anchorRef.current : anchorRef.current?.querySelector<HTMLElement>("button");
        (previouslyFocused?.isConnected && previouslyFocused !== document.body ? previouslyFocused : fallback)?.focus({ preventScroll: true });
      }
    };
  }, [open, isMobile, anchorRef]);

  if (!open) return null;
  return createPortal(<>
    {isMobile ? <div
      className="composer-popover-backdrop"
      aria-hidden="true"
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    /> : null}
    <div
      ref={panelRef}
      className={`composer-popover ${isMobile ? "composer-popover--sheet" : "composer-popover--desktop"} ${className}`}
      style={position}
      role="dialog"
      aria-modal={isMobile || undefined}
      aria-labelledby={isMobile ? titleId : undefined}
      aria-label={isMobile ? undefined : title}
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {isMobile ? <>
        <div className="composer-sheet-handle" aria-hidden="true" />
        <div className="composer-sheet-heading">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="composer-sheet-close" onClick={onClose} aria-label={t("common.close")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </> : null}
      <div className="composer-popover-content">{children}</div>
    </div>
  </>, document.body);
}
