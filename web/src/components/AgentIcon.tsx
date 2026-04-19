import React, { useEffect, useState } from 'react';
import { appPath } from '../services/base';

type AgentIconProps = {
  agentName: string;
  [key: string]: any; // Allow other props like style, etc.
};

const ICON_URLS: Record<string, { src: string; alt: string }> = {
  augment: { src: appPath('/assets/agents/augment.svg'), alt: 'Augment' },
  codex: { src: appPath('/assets/agents/codex.svg'), alt: 'Codex' },
  claude: { src: appPath('/assets/agents/claude.svg'), alt: 'Claude' },
  cline: { src: appPath('/assets/agents/cline.svg'), alt: 'Cline' },
  copilot: { src: appPath('/assets/agents/copilot.svg'), alt: 'Copilot' },
  cursor: { src: appPath('/assets/agents/cursor.svg'), alt: 'Cursor' },
  gemini: { src: appPath('/assets/agents/gemini.svg'), alt: 'Gemini' },
  kiro: { src: appPath('/assets/agents/kiro.svg'), alt: 'Kiro' },
  kimi: { src: appPath('/assets/agents/kimi.svg'), alt: 'Kimi' },
  openclaw: { src: appPath('/assets/agents/openclaw.svg'), alt: 'OpenClaw' },
  opencode: { src: appPath('/assets/agents/opencode.svg'), alt: 'OpenCode' },
  pi: { src: appPath('/assets/agents/pi.svg'), alt: 'Pi' },
  qoder: { src: appPath('/assets/agents/qoder.svg'), alt: 'Qoder' },
  qwen: { src: appPath('/assets/agents/qwen.svg'), alt: 'Qwen' },
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
  if (lowerAgentName.includes('augment')) {
    icon = ICON_URLS.augment;
  } else if (lowerAgentName.includes('cursor')) {
    icon = ICON_URLS.cursor;
  } else if (lowerAgentName.includes('openclaw')) {
    icon = ICON_URLS.openclaw;
  } else if (lowerAgentName.includes('opencode')) {
    icon = ICON_URLS.opencode;
  } else if (lowerAgentName.includes('pi')) {
    icon = ICON_URLS.pi;
  } else if (lowerAgentName.includes('qoder')) {
    icon = ICON_URLS.qoder;
  } else if (lowerAgentName.includes('qwen')) {
    icon = ICON_URLS.qwen;
  } else if (lowerAgentName.includes('kiro')) {
    icon = ICON_URLS.kiro;
  } else if (lowerAgentName.includes('kimi')) {
    icon = ICON_URLS.kimi;
  } else if (lowerAgentName.includes('cline')) {
    icon = ICON_URLS.cline;
  } else if (lowerAgentName.includes('copilot')) {
    icon = ICON_URLS.copilot;
  } else if (lowerAgentName.includes('codex')) {
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
