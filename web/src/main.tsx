import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { registerServiceWorker } from "./registerServiceWorker";
import { isCapacitorRuntime, getApiBaseURL } from "./services/runtime";
import { Login } from "./components/Login";
import { setStoredApiBaseURL, setStoredWsBaseURL } from "./services/storage";

function AppRoot() {
  // In Capacitor runtime, require explicit API base URL before entering the app.
  const [ready, setReady] = useState(() => !isCapacitorRuntime() || !!getApiBaseURL());


  useEffect(() => {
    if (!isCapacitorRuntime() || typeof window === "undefined") {
      return;
    }

    const onBackRequest = () => {
      const event = new CustomEvent("mindfs:android-back-request");
      window.dispatchEvent(event);
    };

    let removeListener: (() => void) | undefined;
    void import("@capacitor/app").then(({ App: CapApp }) => {
      void CapApp.addListener("backButton", () => {
        onBackRequest();
      }).then((handle) => {
        removeListener = () => {
          void handle.remove();
        };
      });
    });

    return () => {
      removeListener?.();
    };
  }, []);

  if (!ready) {
    return (
      <Login
        onLogin={(_token) => setReady(true)}
        onLogout={() => {}}
        isAuthenticated={false}
        connectionStatus="disconnected"
      />
    );
  }
  return <App />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<AppRoot />);
}

registerServiceWorker();


if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    console.error("[global-error]", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error ? {
        name: event.error.name,
        message: event.error.message,
        stack: event.error.stack,
      } : event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    console.error("[unhandled-rejection]", reason instanceof Error ? {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    } : reason);
  });
}
