import React, { useId } from "react";

export type ModeIconType = "chat" | "plugin" | "command";

type ModeIconProps = {
  type: ModeIconType;
  size?: number | string;
  style?: React.CSSProperties;
};

export function ModeIcon({ type, size = "1em", style }: ModeIconProps) {
  if (type === "plugin") {
    return <PluginIcon size={size} style={style} />;
  }
  if (type === "command") {
    return <CommandIcon size={size} style={style} />;
  }
  return <ChatIcon size={size} style={style} />;
}

function ChatIcon({ size, style }: Omit<ModeIconProps, "type">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 12 12" style={{ color: "#3b82f6", ...style }} aria-hidden="true">
      <path d="M0 0h12v12H0z" fill="none" />
      <path
        fill="currentColor"
        transform="translate(6 6) scale(1.08) translate(-6 -6)"
        d="M4 5.5a.5.5 0 0 1 .5-.5h3a.5.5 0 1 1 0 1h-3a.5.5 0 0 1-.5-.5M4.5 7a.5.5 0 0 0 0 1h2a.5.5 0 0 0 0-1zM1 6a5 5 0 1 1 2.59 4.382l-1.944.592a.5.5 0 0 1-.624-.624l.592-1.947A5 5 0 0 1 1 6m5-4a4 4 0 0 0-3.417 6.08a.5.5 0 0 1 .051.406l-.383 1.259l1.257-.383a.5.5 0 0 1 .407.052A4 4 0 1 0 6 2"
      />
    </svg>
  );
}

function PluginIcon({ size, style }: Omit<ModeIconProps, "type">) {
  const gradientId = `plugin-gradient-${useId().replace(/:/g, "")}`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 32 32" style={style} aria-hidden="true">
      <path d="M0 0h32v32H0z" fill="none" />
      <g fill="none">
        <path fill="#b0b0af" d="M8.185 14.95c-.105-.105-6.498-1.512-6.498-1.512s-.372.597-.265.95c.06.197 1.455 1.82 2.89 3.312c1.133 1.18 2.42 2.38 2.608 3.065c.287 1.055.317 2.747.317 2.747L3.07 26.059s.51 2.595 3.815 2.492c3.087-.095 3.248-3.365 4.228-3.383c.165-.002.392-.06.8.378c1.01 1.085 2.9 3.18 3.532 3.815c.845.845 1.445 1.69 1.762 1.655c.318-.035 2.996-2.43 3.77-3.17c.776-.74 1.48-1.62 1.48-2.36s-1.092-1.302-1.092-1.302l-6.025.704zm17.72-9.545c.105 0 2.782-1.338 2.782-1.338s1.375 2.783-.387 4.368s-2.15.688-2.995 1.62c-.645.713-.317 2.185-.317 2.185l5.237 5.035s.292.533.082.92c-.15.275-1.912 2.247-3.277 3.665c-.615.637-1.473.852-1.937.74c-1.163-.283-1.338-1.198-1.55-2.818c-.213-1.62-1.608-1.594-2.116-1.515c-1.07.17-1.767.796-1.767.796s-6.3-7.593-6.23-7.805c.07-.213.318-1.798-.422-2.465c-.74-.67-2.218-1.01-2.783-1.398c-.563-.387-.638-1.125-.535-1.84s4.658-.707 4.658-.707s7.855 4.332 7.892 4.157c.035-.185 3.665-3.6 3.665-3.6" />
        <path fill={`url(#${gradientId})`} d="M22.03 6.247c.19-.695-.027-2.402 1.3-3.532c1.328-1.13 3.393-.99 4.635.197s1.442 3.42-.027 4.89c-1.47 1.47-2.148.65-2.968 1.443s-.677 1.443-.17 1.923c.51.48 5.57 5.767 5.427 6.105c-.142.337-3.59 4.24-4.154 4.522c-.566.282-1.556.255-1.753-.678c-.198-.932.142-2.797-1.273-3.28c-1.412-.48-2.035-.084-3.42 1.386s-2.007 3.08-.877 3.9s2.545.48 3.11 1.442s-.282 1.837-1.78 3.223c-1.497 1.384-2.657 2.514-2.855 2.375c-.198-.143-4.495-4.693-4.918-5.173c-.425-.48-1.245-.905-2.034-.17c-.793.735-.933 3.137-4.268 3.137S2.27 24.34 3.457 22.844c1.188-1.498 3.815-1.64 3.873-2.658c.025-.467-1.418-1.727-2.713-3.08c-1.522-1.593-2.937-3.28-2.997-3.478c-.113-.367 3.165-3.59 3.787-4.042c.623-.453 1.328-.17 1.668.197c.34.368.425 1.498.707 2.148c.283.65 1.61 3.478 4.806.255c3.165-3.195.17-4.58-.848-4.863c-1.018-.282-1.75-.375-2.035-1.412c-.225-.82 1.018-1.78 2.318-3.025S14.085.99 14.425.99s4.89 4.89 5.485 5.455s.96.707 1.385.592c.422-.11.65-.477.735-.79" />
        <defs>
          <radialGradient id={gradientId} cx="0" cy="0" r="1" gradientTransform="translate(15.543 -7.075)scale(29.8062)" gradientUnits="userSpaceOnUse">
            <stop offset=".508" stopColor="#b7d118" />
            <stop offset=".572" stopColor="#b2d019" />
            <stop offset=".643" stopColor="#a5cd1d" />
            <stop offset=".717" stopColor="#8fc922" />
            <stop offset=".793" stopColor="#70c22a" />
            <stop offset=".871" stopColor="#48ba34" />
            <stop offset=".949" stopColor="#18b040" />
            <stop offset=".981" stopColor="#02ab46" />
          </radialGradient>
        </defs>
      </g>
    </svg>
  );
}

function CommandIcon({ size, style }: Omit<ModeIconProps, "type">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" transform="translate(12 12) scale(1.12) translate(-12 -12)">
        <path d="m7 7l1.227 1.057C8.742 8.502 9 8.724 9 9s-.258.498-.773.943L7 11m4 0h3" />
        <path d="M12 21c3.75 0 5.625 0 6.939-.955a5 5 0 0 0 1.106-1.106C21 17.625 21 15.749 21 12s0-5.625-.955-6.939a5 5 0 0 0-1.106-1.106C17.625 3 15.749 3 12 3s-5.625 0-6.939.955A5 5 0 0 0 3.955 5.06C3 6.375 3 8.251 3 12s0 5.625.955 6.939a5 5 0 0 0 1.106 1.106C6.375 21 8.251 21 12 21" />
      </g>
    </svg>
  );
}
