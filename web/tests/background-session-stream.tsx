import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useSessionStream } from "../src/hooks/useSessionStream";
import { sessionService } from "../src/services/session";

function Check() {
  const [key, setKey] = useState("foreground");
  const { isStreaming } = useSessionStream(key);
  Object.assign(window, {
    backgroundStreamCheck: {
      select: setKey,
      emit: (type: string, sessionKey: string, eventType = "message_chunk") => {
        (sessionService as any).dispatchDecrypted(type, sessionKey, {
          root_id: "test", session_key: sessionKey,
          event: { type: eventType, data: { content: "Background reply" } },
        }, {});
      },
      active: (sessionKey: string) => sessionService.isSessionStreaming(sessionKey),
    },
  });
  return <output data-session={key} data-streaming={String(isStreaming)}>{isStreaming ? "generating" : "idle"}</output>;
}

createRoot(document.getElementById("root")!).render(<Check />);
