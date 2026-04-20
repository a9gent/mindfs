import React, { useState, useCallback, useEffect, type ReactElement } from "react";
import { appURL } from "../services/base";
import {
  clearStoredToken,
  getStoredApiBaseURL,
  getStoredToken,
  getStoredWsBaseURL,
  setStoredApiBaseURL,
  setStoredToken,
  setStoredWsBaseURL,
} from "../services/storage";

type LoginProps = {
  onLogin: (token: string) => void;
  onLogout: () => void;
  isAuthenticated: boolean;
  connectionStatus: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
};

export function Login({
  onLogin,
  onLogout,
  isAuthenticated,
  connectionStatus,
  error,
}: LoginProps): ReactElement {
  const [token, setToken] = useState("");
  const [apiBaseURL, setApiBaseURL] = useState(() => getStoredApiBaseURL() || "");
  const [wsBaseURL, setWsBaseURL] = useState(() => getStoredWsBaseURL() || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingEndpoint, setIsCheckingEndpoint] = useState(false);
  const [endpointMessage, setEndpointMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!token.trim()) return;

      setStoredApiBaseURL(apiBaseURL.trim());
      setStoredWsBaseURL(wsBaseURL.trim());
      setIsSubmitting(true);
      try {
        onLogin(token.trim());
      } finally {
        setIsSubmitting(false);
      }
    },
    [apiBaseURL, onLogin, token, wsBaseURL]
  );

  const handleCheckEndpoint = useCallback(async () => {
    setStoredApiBaseURL(apiBaseURL.trim());
    setStoredWsBaseURL(wsBaseURL.trim());
    setIsCheckingEndpoint(true);
    setEndpointMessage(null);
    try {
      const response = await fetch(appURL("/api/relay/status"));
      if (!response.ok) {
        setEndpointMessage(`Service check failed: ${response.status}`);
        return;
      }
      setEndpointMessage("Service reachable");
    } catch {
      setEndpointMessage("Service unreachable");
    } finally {
      setIsCheckingEndpoint(false);
    }
  }, [apiBaseURL, wsBaseURL]);

  const statusColors: Record<string, string> = {
    connected: "#10b981",
    connecting: "#f59e0b",
    disconnected: "#6b7280",
    error: "#ef4444",
  };

  const statusLabels: Record<string, string> = {
    connected: "Connected",
    connecting: "Connecting...",
    disconnected: "Disconnected",
    error: "Connection Error",
  };

  if (isAuthenticated) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "8px 16px",
          background: "#f9fafb",
          borderRadius: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: statusColors[connectionStatus],
            }}
          />
          <span
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
            }}
          >
            {statusLabels[connectionStatus]}
          </span>
        </div>
        <button
          type="button"
          onClick={onLogout}
          style={{
            padding: "6px 12px",
            borderRadius: "6px",
            border: "1px solid var(--border-color)",
            background: "#fff",
            fontSize: "12px",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "20px",
        background: "#f9fafb",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          background: "#fff",
          borderRadius: "16px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
          padding: "32px",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "8px",
            }}
          >
            MindFS
          </h1>
          <p
            style={{
              fontSize: "14px",
              color: "var(--text-secondary)",
            }}
          >
            Enter your access token to continue
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "16px" }}>
            <label
              htmlFor="apiBaseURL"
              style={{
                display: "block",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: "6px",
              }}
            >
              API Base URL
            </label>
            <input
              id="apiBaseURL"
              type="url"
              value={apiBaseURL}
              onChange={(e) => setApiBaseURL(e.target.value)}
              placeholder="http://host:port"
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: "12px",
              }}
              autoFocus
            />
            <label
              htmlFor="wsBaseURL"
              style={{
                display: "block",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: "6px",
              }}
            >
              WS Base URL
            </label>
            <input
              id="wsBaseURL"
              type="url"
              value={wsBaseURL}
              onChange={(e) => setWsBaseURL(e.target.value)}
              placeholder="Optional, derive from API by default"
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: "12px",
              }}
            />
            <label
              htmlFor="token"
              style={{
                display: "block",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: "6px",
              }}
            >
              Access Token
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: "12px",
                borderRadius: "8px",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                marginBottom: "16px",
              }}
            >
              <p
                style={{
                  fontSize: "13px",
                  color: "#dc2626",
                  margin: 0,
                }}
              >
                {error}
              </p>
            </div>
          )}

          <div style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
            <button
              type="button"
              onClick={() => { void handleCheckEndpoint(); }}
              disabled={isCheckingEndpoint || !apiBaseURL.trim()}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                background: "#fff",
                color: "var(--text-primary)",
                fontSize: "14px",
                fontWeight: 500,
                cursor: isCheckingEndpoint || !apiBaseURL.trim() ? "not-allowed" : "pointer",
              }}
            >
              {isCheckingEndpoint ? "Checking..." : "Check Service"}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !token.trim() || !apiBaseURL.trim()}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: "8px",
                border: "none",
                background: isSubmitting || !token.trim() || !apiBaseURL.trim() ? "#d1d5db" : "#3b82f6",
                color: "#fff",
                fontSize: "14px",
                fontWeight: 500,
                cursor: isSubmitting || !token.trim() || !apiBaseURL.trim() ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {isSubmitting ? "Connecting..." : "Connect"}
            </button>
          </div>
          {endpointMessage ? (
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "0 0 12px" }}>
              {endpointMessage}
            </p>
          ) : null}
        </form>

        <div
          style={{
            marginTop: "24px",
            paddingTop: "24px",
            borderTop: "1px solid var(--border-color)",
            textAlign: "center",
          }}
        >
          <p
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
            }}
          >
            Connection Status:{" "}
            <span style={{ color: statusColors[connectionStatus] }}>
              {statusLabels[connectionStatus]}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// Hook for managing authentication state
export function useAuth(): {
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
} {
  const [token, setToken] = useState<string | null>(() => getStoredToken());

  const login = useCallback((newToken: string) => {
    setToken(newToken);
    setStoredToken(newToken);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    clearStoredToken();
  }, []);

  return {
    token,
    isAuthenticated: !!token,
    login,
    logout,
  };
}

// Compact login status indicator for header
export function LoginStatus({
  isAuthenticated,
  connectionStatus,
  onLogout,
}: {
  isAuthenticated: boolean;
  connectionStatus: "connected" | "connecting" | "disconnected" | "error";
  onLogout: () => void;
}): ReactElement | null {
  if (!isAuthenticated) {
    return null;
  }

  const statusColors: Record<string, string> = {
    connected: "#10b981",
    connecting: "#f59e0b",
    disconnected: "#6b7280",
    error: "#ef4444",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: statusColors[connectionStatus],
        }}
      />
      <button
        type="button"
        onClick={onLogout}
        style={{
          padding: "4px 8px",
          borderRadius: "4px",
          border: "none",
          background: "transparent",
          fontSize: "11px",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        Logout
      </button>
    </div>
  );
}
