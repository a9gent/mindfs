import React from "react";
import { useI18n, type MessageKey } from "../i18n";
import {
  isSessionFilterActive,
  type SessionFilterState,
  type SessionTimeWindow,
} from "../services/sessionFilter";

type SessionFilterBarProps = {
  filter: SessionFilterState;
  onChange: (next: SessionFilterState) => void;
};

const TIME_WINDOWS: Array<{ value: Exclude<SessionTimeWindow, "all">; labelKey: MessageKey }> = [
  { value: "1h", labelKey: "sessionList.filterTime1h" },
  { value: "3h", labelKey: "sessionList.filterTime3h" },
  { value: "day", labelKey: "sessionList.filterTimeDay" },
];

const chipBaseStyle: React.CSSProperties = {
  height: "26px",
  border: "1px solid var(--border-color)",
  borderRadius: "999px",
  padding: "0 10px",
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  lineHeight: "1",
  whiteSpace: "nowrap",
  flexShrink: 0,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const chipActiveStyle: React.CSSProperties = {
  ...chipBaseStyle,
  borderColor: "var(--accent-color)",
  color: "var(--accent-color)",
  background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
};

function RunningDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: "#ef4444",
        flexShrink: 0,
      }}
    />
  );
}

export function SessionFilterBar({ filter, onChange }: SessionFilterBarProps) {
  const { t } = useI18n();
  const active = isSessionFilterActive(filter);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 10px",
        borderBottom: "1px solid var(--border-color)",
        background: "var(--mindfs-topbar-bg, transparent)",
        overflowX: "auto",
        overflowY: "hidden",
        flexShrink: 0,
        scrollbarWidth: "none",
      }}
    >
      <button
        type="button"
        aria-pressed={filter.runningOnly}
        onClick={() => onChange({ ...filter, runningOnly: !filter.runningOnly })}
        style={filter.runningOnly ? chipActiveStyle : chipBaseStyle}
      >
        <RunningDot />
        {t("sessionList.filterRunning")}
      </button>
      {TIME_WINDOWS.map(({ value, labelKey }) => {
        const isActive = filter.timeWindow === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange({ ...filter, timeWindow: isActive ? "all" : value })}
            style={isActive ? chipActiveStyle : chipBaseStyle}
          >
            {t(labelKey)}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={filter.sortAsc}
        onClick={() => onChange({ ...filter, sortAsc: !filter.sortAsc })}
        style={filter.sortAsc ? chipActiveStyle : chipBaseStyle}
        title={t(filter.sortAsc ? "sessionList.filterSortAsc" : "sessionList.filterSortDesc")}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{
            transform: filter.sortAsc ? "none" : "rotate(180deg)",
            transition: "transform 0.15s ease",
          }}
        >
          <path
            fill="currentColor"
            d="M18.5 13.5 12 20l-6.5-6.5L7 12l4 4V4h2v12l4-4z"
          />
        </svg>
        {t(filter.sortAsc ? "sessionList.filterSortAsc" : "sessionList.filterSortDesc")}
      </button>
      {active ? (
        <button
          type="button"
          onClick={() =>
            onChange({ runningOnly: false, timeWindow: "all", sortAsc: false })
          }
          style={{
            ...chipBaseStyle,
            border: "none",
            padding: "0 6px",
            color: "var(--text-secondary)",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          {t("sessionList.filterReset")}
        </button>
      ) : null}
    </div>
  );
}
