import React, { useLayoutEffect, useRef } from "react";

export function TaskCardText({ expanded, onOverflowChange, children, style }: {
  expanded: boolean;
  onOverflowChange: (overflow: boolean) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || expanded) return;
    const measure = () => {
      if (node.clientWidth > 0) onOverflowChange(node.scrollHeight > node.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, children, onOverflowChange]);
  return <div ref={element} style={style}>{children}</div>;
}
