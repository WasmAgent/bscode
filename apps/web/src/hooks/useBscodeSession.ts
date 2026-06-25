"use client";
import { useCallback, useState } from "react";
import { clearSessionId, getOrCreateSessionId } from "@/lib/session";

export function useBscodeSession(): { sessionId: string; resetSession: () => void } {
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());

  const resetSession = useCallback(() => {
    clearSessionId();
    setSessionId(getOrCreateSessionId());
  }, []);

  return { sessionId, resetSession };
}
