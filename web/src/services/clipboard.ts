import { isCapacitorRuntime } from "./runtime";

async function writeTextWithExecCommand(text: string): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable");
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) {
    throw new Error("复制失败");
  }
}

async function writeTextWithCapacitor(text: string): Promise<boolean> {
  if (!isCapacitorRuntime()) {
    return false;
  }
  try {
    const mod = await import("@capacitor/clipboard");
    await mod.Clipboard.write({ string: text });
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<void> {
  if (!text) {
    throw new Error("复制内容为空");
  }
  if (await writeTextWithCapacitor(text)) {
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await writeTextWithExecCommand(text);
}
