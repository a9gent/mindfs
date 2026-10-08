import React from "react";
import { createPortal } from "react-dom";

type Props = {
  models: string[];
  value: string;
  label: string;
  onChange: (model: string) => void;
  getOptionLabel?: (value: string) => string;
  style?: React.CSSProperties;
};

export function ProviderModelSelect({ models, value, label, onChange, getOptionLabel = (option) => option, style }: Props) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState<React.CSSProperties>({});
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const id = React.useId();

  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const below = bottom - rect.bottom - 8;
      const above = rect.top - top - 8;
      const upwards = below < 180 && above > below;
      const height = Math.max(0, Math.min(240, upwards ? above : below));
      setPosition({
        position: "fixed", left: rect.left, width: rect.width,
        top: upwards ? undefined : rect.bottom + 4,
        bottom: upwards ? window.innerHeight - rect.top + 4 : undefined,
        maxHeight: height,
      });
    };
    place();
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) place();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  React.useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(Math.max(0, models.indexOf(value)));
    setOpen(true);
  };
  const select = (model: string) => {
    onChange(model);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        title={getOptionLabel(value)}
        onBlur={() => setOpen(false)}
        onClick={(event) => { event.stopPropagation(); if (open) setOpen(false); else show(); }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter", " "].includes(event.key)) {
            event.stopPropagation();
            event.preventDefault();
            if (event.key === "Escape") setOpen(false);
            else if (!open) show();
            else if (event.key === "Enter" || event.key === " ") { if (models[active]) select(models[active]); }
            else if (event.key === "Home") setActive(0);
            else if (event.key === "End") setActive(models.length - 1);
            else setActive((index) => Math.max(0, Math.min(models.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
          }
        }}
        style={{ flex: 1, minWidth: 0, height: "22px", minHeight: 0, boxSizing: "border-box", padding: "0 6px", border: "1px solid var(--border-color)", borderRadius: "6px", background: "var(--menu-bg)", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", cursor: "pointer", ...style }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{getOptionLabel(value)}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0 }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && createPortal(
        <div
          ref={menu} id={id} role="listbox" aria-label={label}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => event.stopPropagation()}
          style={{ ...position, zIndex: 10000, boxSizing: "border-box", overflowY: "auto", overscrollBehavior: "contain", padding: "3px", border: "1px solid var(--menu-border)", borderRadius: "6px", background: "var(--menu-bg)", boxShadow: "0 6px 20px rgba(0,0,0,0.18)" }}
        >
          {models.map((model, index) => (
            <div
              key={model} id={`${id}-${index}`} role="option" aria-selected={model === value} data-index={index}
              title={getOptionLabel(model)}
              onClick={() => select(model)}
              style={{ padding: "7px 6px", fontSize: "12px", lineHeight: "18px", borderRadius: "4px", overflowWrap: "anywhere", cursor: "pointer", background: index === active ? "var(--selection-bg)" : "transparent", color: model === value ? "var(--accent-color)" : "var(--text-primary)" }}
            >{getOptionLabel(model)}</div>
          ))}
        </div>, document.body,
      )}
    </>
  );
}
