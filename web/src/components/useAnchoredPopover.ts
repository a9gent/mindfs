import { useLayoutEffect, useState, type RefObject } from "react";

export type PopoverPlacement = "below" | "above";

export type AnchoredPopoverState = {
  /** Which side of the anchor the popover should open on. */
  placement: PopoverPlacement;
  /** Height cap in px for the chosen side, so the popover never leaves the viewport. */
  maxHeight: number;
};

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
const MIN_USABLE_HEIGHT = 120;

/**
 * Keeps an anchored popover inside the visual viewport.
 *
 * A popover anchored to a row low in a scrolling list opens downward past the
 * viewport bottom, where the enclosing drawer's `overflow: hidden` clips it and
 * the lower entries become untappable. This measures the space on both sides of
 * the anchor and flips the popover upward when that side has more room, capping
 * the height to the chosen side either way.
 *
 * Attach `anchorRef` to the positioned wrapper and `menuRef` to the popover.
 */
export function useAnchoredPopover(
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  open: boolean,
): AnchoredPopoverState {
  const [state, setState] = useState<AnchoredPopoverState>({ placement: "below", maxHeight: 0 });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) {
      return;
    }

    const measure = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      // scrollHeight is the natural content height, unaffected by any maxHeight
      // already applied — comparing against it keeps the side choice stable
      // instead of oscillating once the cap kicks in.
      const naturalHeight = Math.max(menuRect.height, menu.scrollHeight);
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const spaceBelow = viewportTop + viewportHeight - anchorRect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
      const spaceAbove = anchorRect.top - viewportTop - ANCHOR_GAP - VIEWPORT_MARGIN;
      // Stay below while the content fits, or when below is at least as roomy.
      const placement: PopoverPlacement =
        naturalHeight <= spaceBelow || spaceBelow >= spaceAbove ? "below" : "above";
      const available = placement === "below" ? spaceBelow : spaceAbove;
      const maxHeight = Math.max(MIN_USABLE_HEIGHT, Math.round(available));
      setState((current) =>
        current.placement === placement && current.maxHeight === maxHeight
          ? current
          : { placement, maxHeight },
      );
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef, menuRef, open]);

  return state;
}
