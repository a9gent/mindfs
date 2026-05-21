import React from "react";

type SymlinkBadgeProps = {
  offset?: string;
};

export function SymlinkBadge({ offset = "-2px" }: SymlinkBadgeProps) {
  return (
    <span
      title="软连接目录"
      aria-label="软连接目录"
      style={{
        position: "absolute",
        right: offset,
        bottom: offset,
        width: "10px",
        height: "10px",
        borderRadius: "999px",
        background: "var(--panel-bg)",
        color: "var(--text-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "9px",
        lineHeight: 1,
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M0 0h24v24H0z" fill="none" />
        <path fill="currentColor" d="M11 17H7q-2.075 0-3.537-1.463T2 12t1.463-3.537T7 7h4v2H7q-1.25 0-2.125.875T4 12t.875 2.125T7 15h4zm-3-4v-2h8v2zm5 4v-2h4q1.25 0 2.125-.875T20 12t-.875-2.125T17 9h-4V7h4q2.075 0 3.538 1.463T22 12t-1.463 3.538T17 17z" />
      </svg>
    </span>
  );
}
