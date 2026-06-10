"use client";
import { del, get, keys, set } from "idb-keyval";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConfig } from "./useAgent";

/**
 * Persistent session storage for BSCode.
 *
 * Sessions are stored in IndexedDB via idb-keyval (no schema migrations,
 * no transaction ceremony). Each session keeps:
 * - the configuration snapshot the user was running with
 * - the full conversation `turns` array
 * - any associated metadata (title, last touched timestamp)
 *
 * Working files are NOT mirrored here — they live in the worker KV. The
 * session record only stores the session ID, which the worker uses as
 * a namespace to isolate file state.
 */

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSession<TTurn = unknown> extends SessionMeta {
  config: AgentConfig;
  turns: TTurn[];
}

const KEY_PREFIX = "bscode.session.";
const MAX_SESSIONS = 50;
const AUTOSAVE_DEBOUNCE_MS = 1_000;

const sessionKey = (id: string) => `${KEY_PREFIX}${id}`;

function genId(): string {
  // ULID-ish — sortable by time, unique enough for client-only IDs
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function deriveTitle<TTurn>(turns: TTurn[]): string {
  const first = turns[0] as { task?: string } | undefined;
  const task = first?.task?.trim();
  if (!task) return "Untitled session";
  return task.length > 60 ? `${task.slice(0, 57)}...` : task;
}

async function loadSession<TTurn>(id: string): Promise<PersistedSession<TTurn> | null> {
  try {
    const raw = (await get(sessionKey(id))) as PersistedSession<TTurn> | undefined;
    return raw ?? null;
  } catch {
    return null;
  }
}

async function saveSession<TTurn>(s: PersistedSession<TTurn>): Promise<void> {
  await set(sessionKey(s.id), s);
}

async function listAll(): Promise<SessionMeta[]> {
  try {
    const allKeys = (await keys()) as string[];
    const ids = allKeys
      .filter((k) => typeof k === "string" && k.startsWith(KEY_PREFIX))
      .map((k) => (k as string).slice(KEY_PREFIX.length));
    const records = await Promise.all(
      ids.map(async (id) => {
        const s = await loadSession(id);
        if (!s) return null;
        return {
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        } satisfies SessionMeta;
      })
    );
    return records
      .filter((r): r is SessionMeta => r !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function gcExtraSessions(): Promise<void> {
  const list = await listAll();
  if (list.length <= MAX_SESSIONS) return;
  const overflow = list.slice(MAX_SESSIONS);
  await Promise.all(overflow.map((s) => del(sessionKey(s.id))));
}

export interface UseSessionStorageReturn<TTurn = unknown> {
  /** Currently-loaded session, or null if no session is active. */
  current: PersistedSession<TTurn> | null;
  /** Lightweight metadata list of all stored sessions. */
  list: SessionMeta[];
  /** Status of the IndexedDB layer. */
  ready: boolean;
  /** Create a new empty session and switch to it. */
  newSession(config: AgentConfig): Promise<string>;
  /** Load a previously-saved session by id. */
  loadById(id: string): Promise<void>;
  /** Update the working session — schedules a debounced save. */
  update(patch: Partial<PersistedSession<TTurn>>): void;
  /** Delete a session permanently. */
  remove(id: string): Promise<void>;
  /** Refresh the metadata list (e.g. after manual writes). */
  refresh(): Promise<void>;
  /** Export the current session as a downloadable JSON blob. */
  exportCurrent(): Blob | null;
  /** Import a session JSON file. Returns the new session id. */
  importJson(text: string): Promise<string>;
}

/**
 * React hook providing IndexedDB-backed session persistence.
 *
 * Usage:
 *   const session = useSessionStorage<ConversationTurn>();
 *   useEffect(() => {
 *     if (session.ready && !session.current) session.newSession(initialConfig);
 *   }, [session.ready]);
 */
export function useSessionStorage<TTurn = unknown>(): UseSessionStorageReturn<TTurn> {
  const [current, setCurrent] = useState<PersistedSession<TTurn> | null>(null);
  const [list, setList] = useState<SessionMeta[]>([]);
  const [ready, setReady] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Partial<PersistedSession<TTurn>> | null>(null);

  const refresh = useCallback(async () => {
    setList(await listAll());
  }, []);

  // Initial load: read the most recent session if one exists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await gcExtraSessions();
      const all = await listAll();
      if (cancelled) return;
      setList(all);
      const first = all[0];
      if (first) {
        const s = await loadSession<TTurn>(first.id);
        if (!cancelled && s) setCurrent(s);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const flush = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const patch = pendingPatch.current;
    if (!patch) return;
    pendingPatch.current = null;
    setCurrent((prev) => {
      if (!prev) return prev;
      const next: PersistedSession<TTurn> = {
        ...prev,
        ...patch,
        updatedAt: Date.now(),
        title: deriveTitle((patch.turns ?? prev.turns) as TTurn[]),
      };
      void saveSession(next).then(() => listAll().then(setList));
      return next;
    });
  }, []);

  const update = useCallback(
    (patch: Partial<PersistedSession<TTurn>>) => {
      pendingPatch.current = { ...(pendingPatch.current ?? {}), ...patch };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flush();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flush]
  );

  const newSession = useCallback(
    async (config: AgentConfig): Promise<string> => {
      const id = genId();
      const fresh: PersistedSession<TTurn> = {
        id,
        title: "Untitled session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config,
        turns: [],
      };
      await saveSession(fresh);
      await refresh();
      setCurrent(fresh);
      return id;
    },
    [refresh]
  );

  const loadById = useCallback(async (id: string) => {
    const s = await loadSession<TTurn>(id);
    if (s) setCurrent(s);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await del(sessionKey(id));
      if (current?.id === id) setCurrent(null);
      await refresh();
    },
    [current, refresh]
  );

  const exportCurrent = useCallback((): Blob | null => {
    if (!current) return null;
    return new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
  }, [current]);

  const importJson = useCallback(
    async (text: string): Promise<string> => {
      const parsed = JSON.parse(text) as PersistedSession<TTurn>;
      const newId = genId();
      const imported: PersistedSession<TTurn> = {
        ...parsed,
        id: newId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await saveSession(imported);
      await refresh();
      setCurrent(imported);
      return newId;
    },
    [refresh]
  );

  return {
    current,
    list,
    ready,
    newSession,
    loadById,
    update,
    remove,
    refresh,
    exportCurrent,
    importJson,
  };
}
