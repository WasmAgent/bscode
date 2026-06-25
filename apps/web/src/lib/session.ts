const SESSION_KEY = "bscode.sessionId";
const SESSION_ID_RE = /^[a-zA-Z0-9._-]{8,128}$/;

export function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  try {
    const existing = window.localStorage.getItem(SESSION_KEY);
    if (existing && SESSION_ID_RE.test(existing)) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    // localStorage blocked (strict privacy mode) — generate ephemeral id
    return crypto.randomUUID();
  }
}

export function clearSessionId(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }
}
