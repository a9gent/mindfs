import { getNativeBridge } from "./nativeBridge";
import { isCapacitorRuntime, isNativeShellRuntime } from "./runtime";

async function writeTextWithExecCommand(text: string): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable");
  }
  if (!document.body) {
    throw new Error("Clipboard unavailable");
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (selection) {
    selection.removeAllRanges();
    if (previousRange) {
      selection.addRange(previousRange);
    }
  }
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

async function writeTextWithNativeBridge(text: string): Promise<boolean> {
  if (!isNativeShellRuntime()) {
    return false;
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.writeClipboardText !== "function") {
      return false;
    }
    const result = await native.writeClipboardText(text);
    return result !== false;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<void> {
  if (!text) {
    throw new Error("复制内容为空");
  }
  if (await writeTextWithNativeBridge(text)) {
    return;
  }
  if (await writeTextWithCapacitor(text)) {
    return;
  }

  try {
    await writeTextWithExecCommand(text);
    return;
  } catch {
    // Some browsers block execCommand, so fall through to the async API.
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error("当前浏览器不支持自动复制");
}
