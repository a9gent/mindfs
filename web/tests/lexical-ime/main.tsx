import { useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import TokenEditor from "../../src/components/editor/TokenEditor";

interface ProbeState {
  events: string[];
  submitCount: number;
  text: string;
  serializedText: string;
}

const probe: ProbeState = { events: [], submitCount: 0, text: "", serializedText: "" };
Object.assign(window, { __lexicalImeProbe: probe });

// 与 ActionBar 的 IME Enter 守卫保持同一语义：组合中、组合结束后 120ms 内、
// isComposing 或 keyCode 229 的 Enter 一律不视为发送。
const IME_ENTER_GUARD_MS = 120;

function ImeProbeApp() {
  const composingRef = useRef(false);
  const guardUntilRef = useRef(0);

  useEffect(() => {
    const root = document.querySelector(".token-editor-input");
    if (!root) return;
    const record = (event: Event) => {
      const input = event as InputEvent;
      probe.events.push(
        `${event.type}:${input.data ?? ""}:${input.inputType ?? ""}:${input.isComposing ?? ""}`,
      );
    };
    for (const type of ["compositionend", "beforeinput", "input"]) {
      root.addEventListener(type, record);
    }
    return () => {
      for (const type of ["compositionend", "beforeinput", "input"]) {
        root.removeEventListener(type, record);
      }
    };
  }, []);

  const isCompositionActive = useCallback(
    (event: KeyboardEvent | null) =>
      composingRef.current ||
      performance.now() < guardUntilRef.current ||
      !!event?.isComposing ||
      event?.keyCode === 229,
    [],
  );

  return (
    <TokenEditor
      placeholder="IME probe"
      onChange={({ serializedText, displayText }) => {
        probe.text = displayText;
        probe.serializedText = serializedText;
      }}
      onEnter={(event) => {
        if (isCompositionActive(event)) return false;
        event?.preventDefault();
        probe.submitCount += 1;
        return true;
      }}
      onCompositionStart={() => {
        composingRef.current = true;
        guardUntilRef.current = 0;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        guardUntilRef.current = performance.now() + IME_ENTER_GUARD_MS;
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<ImeProbeApp />);
