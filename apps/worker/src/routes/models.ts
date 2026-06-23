import type { Hono } from "hono";
import {
  type CustomModelConfig,
  discoverLocalModels,
  getBuiltinModels,
  listCustomModels,
  loadPreferences,
  type ModelPreferences,
  registerCustomModel,
  removeCustomModel,
  savePreferences,
} from "../models/registry.js";
import type { AppConfig, KvStore } from "../platform.js";

function getModelStore(config: AppConfig): KvStore {
  return (
    config.sessionsKv ??
    config.filesKv ?? {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [] }),
    }
  );
}

export function mountModelRoutes(app: Hono, config: AppConfig): void {
  /** GET /models — list all models (builtin + custom + locally discovered) */
  app.get("/models", async (c) => {
    const store = getModelStore(config);
    const [builtin, local, prefs] = await Promise.all([
      getBuiltinModels(config, store),
      discoverLocalModels(),
      loadPreferences(store),
    ]);
    return c.json({
      models: [...builtin, ...local],
      preferences: prefs ?? { primaryModelId: "claude-sonnet-4-6" },
    });
  });

  /** POST /models/custom — add or update a custom model (apiKey encrypted at rest) */
  app.post("/models/custom", async (c) => {
    const store = getModelStore(config);
    const body = await c.req.json<CustomModelConfig>();
    if (!body.id || !body.baseUrl) return c.json({ error: "id and baseUrl required" }, 400);
    await registerCustomModel(body, store);
    return c.json({ ok: true, id: body.id });
  });

  /** DELETE /models/custom/:id — remove a custom model */
  app.delete("/models/custom/:id", async (c) => {
    const store = getModelStore(config);
    const id = decodeURIComponent(c.req.param("id"));
    const deleted = await removeCustomModel(id, store);
    return deleted ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /** GET /models/custom — list custom models (keys redacted) */
  app.get("/models/custom", async (c) => {
    const store = getModelStore(config);
    return c.json({ models: await listCustomModels(store) });
  });

  /** PUT /models/preferences — save primary/economy model selection */
  app.put("/models/preferences", async (c) => {
    const store = getModelStore(config);
    const prefs = await c.req.json<ModelPreferences>();
    if (!prefs.primaryModelId) return c.json({ error: "primaryModelId required" }, 400);
    await savePreferences(prefs, store);
    return c.json({ ok: true, prefs });
  });
}
