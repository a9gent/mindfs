import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { getStoredString, removeStoredString, setStoredString } from "../services/storage";

const STORAGE_KEY = "mindfs-desktop-composer-height";
const MIN_HEIGHT = 104;
const KEYBOARD_STEP = 20;

function loadHeight(): number | null {
  const height = Number(getStoredString(STORAGE_KEY));
  return Number.isFinite(height) && height >= MIN_HEIGHT ? height : null;
}

export function useComposerResize(enabled: boolean, defaultHeight: number) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [preferredHeight, setPreferredHeight] = useState(loadHeight);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [currentHeight, setCurrentHeight] = useState(defaultHeight);
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(viewportHeight * 0.6));
  const clampHeight = (value: number) => Math.max(MIN_HEIGHT, Math.min(maxHeight, Math.round(value)));
  const height = enabled && preferredHeight !== null ? clampHeight(preferredHeight) : undefined;

  useEffect(() => {
    if (preferredHeight === null) removeStoredString(STORAGE_KEY);
    else setStoredString(STORAGE_KEY, String(preferredHeight));
  }, [preferredHeight]);

  useEffect(() => {
    dragRef.current = null;
    if (!enabled || !surfaceRef.current) return;
    const updateViewport = () => setViewportHeight(window.innerHeight);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    const observer = new ResizeObserver(() => {
      if (surfaceRef.current) setCurrentHeight(Math.round(surfaceRef.current.getBoundingClientRect().height));
    });
    observer.observe(surfaceRef.current);
    return () => {
      window.removeEventListener("resize", updateViewport);
      observer.disconnect();
    };
  }, [enabled]);

  const reset = () => setPreferredHeight(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !surfaceRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: surfaceRef.current.getBoundingClientRect().height,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreferredHeight(clampHeight(drag.startHeight + drag.startY - event.clientY));
  };
  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const actualHeight = surfaceRef.current?.getBoundingClientRect().height ?? defaultHeight;
    switch (event.key) {
      case "ArrowUp": setPreferredHeight(clampHeight(actualHeight + KEYBOARD_STEP)); break;
      case "ArrowDown": setPreferredHeight(clampHeight(actualHeight - KEYBOARD_STEP)); break;
      case "Home": setPreferredHeight(MIN_HEIGHT); break;
      case "End": setPreferredHeight(maxHeight); break;
      case "Escape": reset(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    surfaceRef,
    height,
    minHeight: MIN_HEIGHT,
    maxHeight,
    currentHeight,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDrag,
      onPointerCancel: stopDrag,
      onLostPointerCapture: stopDrag,
      onDoubleClick: reset,
      onKeyDown,
    },
  };
}
