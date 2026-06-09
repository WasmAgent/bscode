/**
 * Model Registry — manages built-in and custom model configurations.
 *
 * Supports:
 *   - Built-in providers: Anthropic, DeepSeek, Doubao (from env vars)
 *   - Custom providers: any OpenAI-compatible endpoint
 *   - Local service discovery: Ollama, LM Studio, llama.cpp, vLLM, etc.
 *
 * Persistence: custom models + preferred models stored in FsKvStore (local dev)
 * or Cloudflare KV (production). API keys encrypted with AES-256-GCM before storage.
 */
import type { Model } from "@agentkit-js/core";
import { OpenAIModel } from "@agentkit-js/core";
import { AnthropicModel } from "@agentkit-js/model-anthropic";
import { DeepSeekModel } from "@agentkit-js/model-deepseek";
import { DoubaoModel } from "@agentkit-js/model-doubao";
import type { AppConfig, KvStore } from "../platform.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  label: string;
  provider: string;
  baseUrl?: string;
  available: boolean;
  source: "builtin" | "local" | "custom";
}

export interface CustomModelConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string; // stored encrypted
  provider?: string;
}

export interface ModelPreferences {
  primaryModelId: string;
  economyModelId?: string;
}

// ── AES-256-GCM encryption for stored API keys ────────────────────────────────

const STORE_KEY_KV = "meta:storeKey";
const CUSTOM_MODELS_KV = "meta:customModels";
const PREFERENCES_KV = "meta:preferences";

let encKey: CryptoKey | null = null;

async function getOrCreateEncKey(store: KvStore): Promise<CryptoKey> {
  if (encKey) return encKey;

  const stored = await store.get(STORE_KEY_KV);
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    encKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return encKey;
  }

  // Generate and persist a new random 256-bit key
  const newKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const exported = await crypto.subtle.exportKey("raw", newKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  await store.put(STORE_KEY_KV, b64);
  encKey = newKey;
  return encKey;
}

async function encryptValue(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  // Pack as base64(iv) + "." + base64(ciphertext)
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}.${ctB64}`;
}

async function decryptValue(packed: string, key: CryptoKey): Promise<string> {
  const [ivB64, ctB64] = packed.split(".");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// ── Persistent custom model store ─────────────────────────────────────────────

// In-memory cache (populated from KV on first access)
let customModelCache: Map<string, CustomModelConfig> | null = null;

async function loadCustomModels(store: KvStore): Promise<Map<string, CustomModelConfig>> {
  if (customModelCache) return customModelCache;
  const raw = await store.get(CUSTOM_MODELS_KV);
  if (!raw) {
    customModelCache = new Map();
    return customModelCache;
  }
  try {
    const list = JSON.parse(raw) as CustomModelConfig[];
    customModelCache = new Map(list.map((m) => [m.id, m]));
  } catch {
    customModelCache = new Map();
  }
  return customModelCache;
}

async function saveCustomModels(
  store: KvStore,
  models: Map<string, CustomModelConfig>
): Promise<void> {
  await store.put(CUSTOM_MODELS_KV, JSON.stringify([...models.values()]));
}

export async function registerCustomModel(cfg: CustomModelConfig, store: KvStore): Promise<void> {
  const models = await loadCustomModels(store);
  const key = await getOrCreateEncKey(store);

  const toStore: CustomModelConfig = { ...cfg };
  if (cfg.apiKey) {
    toStore.apiKey = await encryptValue(cfg.apiKey, key);
  }

  models.set(cfg.id, toStore);
  await saveCustomModels(store, models);
}

export async function removeCustomModel(id: string, store: KvStore): Promise<boolean> {
  const models = await loadCustomModels(store);
  const deleted = models.delete(id);
  if (deleted) await saveCustomModels(store, models);
  return deleted;
}

export async function listCustomModels(store: KvStore): Promise<CustomModelConfig[]> {
  const models = await loadCustomModels(store);
  // Return without decrypted keys
  return [...models.values()].map((m) => ({ ...m, apiKey: m.apiKey ? "***" : undefined }));
}

async function getDecryptedCustomModel(
  id: string,
  store: KvStore
): Promise<CustomModelConfig | null> {
  const models = await loadCustomModels(store);
  const m = models.get(id);
  if (!m) return null;

  if (m.apiKey && !m.apiKey.startsWith("sk-") && m.apiKey !== "local") {
    try {
      const key = await getOrCreateEncKey(store);
      const decrypted = await decryptValue(m.apiKey, key);
      return { ...m, apiKey: decrypted };
    } catch {
      return { ...m, apiKey: undefined };
    }
  }
  return m;
}

// ── Model preferences persistence ─────────────────────────────────────────────

export async function savePreferences(prefs: ModelPreferences, store: KvStore): Promise<void> {
  await store.put(PREFERENCES_KV, JSON.stringify(prefs));
}

export async function loadPreferences(store: KvStore): Promise<ModelPreferences | null> {
  const raw = await store.get(PREFERENCES_KV);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelPreferences;
  } catch {
    return null;
  }
}

// ── Well-known local LLM service endpoints to auto-detect ────────────────────

const LOCAL_PROBE_TARGETS = [
  { baseUrl: "http://localhost:11434", provider: "ollama", label: "Ollama" },
  { baseUrl: "http://localhost:1234", provider: "lmstudio", label: "LM Studio" },
  { baseUrl: "http://localhost:8080", provider: "llamacpp", label: "llama.cpp" },
  { baseUrl: "http://localhost:8000", provider: "vllm", label: "vLLM" },
  { baseUrl: "http://localhost:8001", provider: "vllm", label: "vLLM (alt)" },
  { baseUrl: "http://localhost:5000", provider: "localai", label: "LocalAI" },
  { baseUrl: "http://localhost:7860", provider: "tgi", label: "Text Generation UI" },
];

async function probeLocalService(
  baseUrl: string,
  provider: string
): Promise<{ available: boolean; models: Array<{ id: string; label: string }> }> {
  try {
    const endpoint = provider === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/v1/models`;
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(600) });
    if (!resp.ok) return { available: false, models: [] };

    const data = (await resp.json()) as Record<string, unknown>;
    let modelList: Array<{ id: string; label: string }> = [];

    if (provider === "ollama") {
      const models = (data.models as Array<{ name: string }>) ?? [];
      modelList = models.map((m) => ({
        id: `local:${baseUrl.replace(/^https?:\/\//, "")}/${m.name}`,
        label: m.name,
      }));
    } else {
      const models = (data.data as Array<{ id: string }>) ?? [];
      modelList = models.map((m) => ({
        id: `local:${baseUrl.replace(/^https?:\/\//, "")}/${m.id}`,
        label: m.id,
      }));
    }

    return { available: true, models: modelList.slice(0, 30) };
  } catch {
    return { available: false, models: [] };
  }
}

export async function discoverLocalModels(): Promise<ModelEntry[]> {
  const results = await Promise.all(
    LOCAL_PROBE_TARGETS.map(async (target) => {
      const probe = await probeLocalService(target.baseUrl, target.provider);
      if (!probe.available) return [];
      return probe.models.map((m) => ({
        id: m.id,
        label: `${target.label} · ${m.label}`,
        provider: target.provider,
        baseUrl: target.baseUrl,
        available: true,
        source: "local" as const,
      }));
    })
  );
  return results.flat();
}

// ── Build full model list ─────────────────────────────────────────────────────

export async function getBuiltinModels(config: AppConfig, store: KvStore): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];
  const hasAnthropic = !!(config.anthropicApiKey || config.anthropicAuthToken);
  const hasDeepSeek = !!config.deepseekApiKey;
  const hasDoubao = !!config.doubaoApiKey;

  if (hasAnthropic || config.anthropicBaseUrl) {
    entries.push(
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        available: hasAnthropic,
        source: "builtin",
      },
      {
        id: "claude-opus-4-8",
        label: "Claude Opus 4.8",
        provider: "anthropic",
        available: hasAnthropic,
        source: "builtin",
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        provider: "anthropic",
        available: hasAnthropic,
        source: "builtin",
      }
    );
  }
  if (hasDeepSeek) {
    entries.push(
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        provider: "deepseek",
        available: true,
        source: "builtin",
      },
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        provider: "deepseek",
        available: true,
        source: "builtin",
      }
    );
  }
  if (hasDoubao) {
    entries.push({
      id: "doubao-seed-1-6-251015",
      label: "Doubao Seed-1.6",
      provider: "doubao",
      available: true,
      source: "builtin",
    });
  }

  // Custom models from persistent store
  const customs = await listCustomModels(store);
  for (const m of customs) {
    entries.push({
      id: m.id,
      label: m.label,
      provider: m.provider ?? "custom",
      baseUrl: m.baseUrl,
      available: true,
      source: "custom",
    });
  }

  return entries;
}

// ── Resolve modelId → agentkit-js Model instance ─────────────────────────────

export async function resolveModelFromRegistry(
  modelId: string | undefined,
  config: AppConfig,
  store: KvStore
): Promise<Model | null> {
  const id = modelId ?? "claude-sonnet-4-6";

  // Built-in providers
  if (id.startsWith("claude")) {
    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return null;
    return new AnthropicModel(
      id as string & {},
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );
  }
  if (id.startsWith("doubao")) {
    if (!config.doubaoApiKey) return null;
    return new DoubaoModel(id as string & {}, config.doubaoApiKey);
  }
  if (id.startsWith("deepseek")) {
    if (!config.deepseekApiKey) return null;
    return new DeepSeekModel(id as string & {}, config.deepseekApiKey);
  }

  // Custom registered models (decrypted)
  const custom = await getDecryptedCustomModel(id, store);
  if (custom) {
    const modelName = id.includes("/") ? id.split("/").pop()! : id;
    return new OpenAIModel(modelName, {
      baseURL: custom.baseUrl,
      apiKey: custom.apiKey ?? "local",
      apiMode: "chat",
    });
  }

  // Local discovered models: "local:host:port/model-name"
  if (id.startsWith("local:")) {
    const withoutPrefix = id.slice(6);
    const slashIdx = withoutPrefix.indexOf("/");
    if (slashIdx === -1) return null;
    const hostPort = withoutPrefix.slice(0, slashIdx);
    const modelName = withoutPrefix.slice(slashIdx + 1);
    return new OpenAIModel(modelName, {
      baseURL: `http://${hostPort}`,
      apiKey: "local",
      apiMode: "chat",
    });
  }

  // Fallback to Anthropic
  const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
  if (!apiKey) return null;
  return new AnthropicModel(
    "claude-sonnet-4-6",
    config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
  );
}
