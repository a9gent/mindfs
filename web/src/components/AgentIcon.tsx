import React, { useEffect, useState } from 'react';

type AgentIconProps = {
  agentName: string;
  [key: string]: any; // Allow other props like style, etc.
};

const ICON_URLS: Record<string, { src: string; alt: string }> = {
  codex: { src: '/assets/agents/codex.svg', alt: 'Codex' },
  claude: { src: '/assets/agents/claude.svg', alt: 'Claude' },
  gemini: { src: '/assets/agents/gemini.svg', alt: 'Gemini' },
};

const iconCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function svgToDataURL(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function loadIconOnce(url: string): Promise<string> {
  const cached = iconCache.get(url);
  if (cached) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = (async () => {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) {
      throw new Error(`failed to load icon: ${res.status}`);
    }
    const svg = await res.text();
    const dataURL = svgToDataURL(svg);
    iconCache.set(url, dataURL);
    return dataURL;
  })();

  inflight.set(url, task);
  try {
    return await task;
  } finally {
    inflight.delete(url);
  }
}

function useCachedIcon(url?: string): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() => {
    if (!url) return undefined;
    return iconCache.get(url) ?? undefined;
  });

  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setSrc(undefined);
      return;
    }
    const cached = iconCache.get(url);
    if (cached) {
      setSrc(cached);
      return;
    }
    loadIconOnce(url)
      .then((dataURL) => {
        if (!cancelled) setSrc(dataURL);
      })
      .catch(() => {
        if (!cancelled) setSrc(url);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}

export function AgentIcon({ agentName, ...props }: AgentIconProps) {
  const lowerAgentName = agentName.toLowerCase();
  const style = props.style ?? {};
  const width = style.width ?? props.width ?? 16;
  const height = style.height ?? props.height ?? 16;
  let icon: { src: string; alt: string } | null = null;
  if (lowerAgentName.includes('codex') || lowerAgentName.includes('copilot')) {
    icon = ICON_URLS.codex;
  } else if (lowerAgentName.includes('claude')) {
    icon = ICON_URLS.claude;
  } else if (lowerAgentName.includes('gemini')) {
    icon = ICON_URLS.gemini;
  }
  const iconSrc = useCachedIcon(icon?.src);

  if (icon && iconSrc) {
    return (
      <img
        src={iconSrc}
        alt={icon.alt}
        width={width}
        height={height}
        {...props}
      />
    );
  }

  if (icon) {
    return (
      <span
        style={{
          display: 'inline-block',
          width: Number(width) || 16,
          height: Number(height) || 16,
        }}
        {...props}
      />
    );
  }

  return <span {...props}>🤖</span>;
}
