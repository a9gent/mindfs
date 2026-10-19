import type { CSSProperties } from "react";

/**
 * Viewport cap for anchored menu popovers (position: absolute, top: 100% + gap).
 *
 * The drawers and the main content column both use `overflow: hidden`, so a
 * popover that grows past the viewport bottom is clipped instead of scrolled:
 * on short phones (small viewports, or any phone whose browser toolbars eat
 * vertical space) the lower entries become unreachable — taps hit nothing and
 * the toggle looks "dead". Capping to the viewport and scrolling inside keeps
 * every entry reachable.
 *
 * The 56px accounts for the anchored trigger row plus the popover gap, so the
 * capped box still clears the safe-area insets at the bottom.
 */
export const menuPopoverCapStyle: CSSProperties = {
  boxSizing: "border-box",
  maxHeight: "calc(100dvh - var(--mindfs-safe-area-top, 0px) - var(--mindfs-safe-area-bottom, 0px) - 56px)",
  overflowY: "auto",
};
