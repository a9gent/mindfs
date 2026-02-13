import { useCallback, useEffect, useRef, useState } from "react";
import { sessionService, type StreamEvent, type PermissionRequest } from "../services/session";

type UseSessionStreamResult = {
  chunks: StreamEvent[];
  isStreaming: boolean;
  permissionRequest: PermissionRequest | null;
  respondToPermission: (requestId: string, granted: boolean, always?: boolean) => void;
  clearChunks: () => void;
};

export function useSessionStream(sessionKey: string | null): UseSessionStreamResult {
  const [chunks, setChunks] = useState<StreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sessionKey) {
      setChunks([]);
      setIsStreaming(false);
      setPermissionRequest(null);
      return;
    }

    // Subscribe to session events
    unsubscribeRef.current = sessionService.subscribe(sessionKey, {
      onStream: (chunk) => {
        setIsStreaming(true);
        setChunks((prev) => [...prev, chunk]);
      },
      onDone: () => {
        setIsStreaming(false);
      },
      onError: (error) => {
        setIsStreaming(false);
        setChunks((prev) => [...prev, { type: "error", data: { message: error } }]);
      },
      onPermissionRequest: (req) => {
        setPermissionRequest(req);
      },
    });

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [sessionKey]);

  const respondToPermission = useCallback(
    (requestId: string, granted: boolean, _always?: boolean) => {
      if (!sessionKey) return;
      sessionService.respondToPermission(sessionKey, requestId, granted);
      setPermissionRequest(null);
    },
    [sessionKey]
  );

  const clearChunks = useCallback(() => {
    setChunks([]);
  }, []);

  return {
    chunks,
    isStreaming,
    permissionRequest,
    respondToPermission,
    clearChunks,
  };
}
