/**
 * Cloudflare Workers entry point.
 * Adapts CF-specific bindings (KVNamespace, ExecutionContext) to the
 * platform-independent createApp() factory.
 */
import { type AppConfig, createApp } from "./app.js";
import { checkProductionConfig, warnOptionalConfig } from "./config/productionGuard.js";
import { kvFromNamespace } from "./platform.js";

export interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  /** Volcengine Ark API key for Doubao models. */
  DOUBAO_API_KEY?: string;
  /** Override Volcengine Ark base URL (default: ark.cn-beijing.volces.com/api/v3). */
  DOUBAO_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  /** Override DeepSeek base URL (default: api.deepseek.com/v1). */
  DEEPSEEK_BASE_URL?: string;
  /**
   * Zhipu GLM API key.
   * Works for: standard GLM endpoint, GLM Coding Plan, GLM via Anthropic protocol.
   */
  GLM_API_KEY?: string;
  /**
   * GLM base URL override.
   * Standard:      https://open.bigmodel.cn/api/paas/v4  (default)
   * Coding Plan:   https://open.bigmodel.cn/api/coding/paas/v4
   * Anthropic API: https://open.bigmodel.cn/api/anthropic  (use with ANTHROPIC_BASE_URL)
   */
  GLM_BASE_URL?: string;
  BSCODE_CLIENT_TOKEN?: string;
  BSCODE_ALLOWED_ORIGIN?: string;
  AGENTKIT_LOG_LEVEL?: string;
  /** When "true", enables /rollouts/export for training data collection. Must be set explicitly by the operator. */
  TRAINING_DATA_MODE?: string;
  /**
   * P0-5: When "true", enables strict auth enforcement. Setting this to "true"
   * together with a dev-mode fallback (allowLocalSessionFallback) will cause the
   * worker to reject startup with a fatal error. Default: "false".
   *
   * MUST be set to "true" in all production deployments.
   */
  STRICT_AUTH?: string;
  /**
   * P0-4: When "true", exposes /mcp publicly without clientToken authentication.
   *
   * WARNING: This flag enables unauthenticated access to the /mcp endpoint.
   * You MUST also bind BSCODE_PUBLIC_READ_KV to a separate, read-only KV
   * namespace. The deployment-level BSCODE_FILES namespace will NOT be exposed.
   * Without BSCODE_PUBLIC_READ_KV bound, /mcp returns 503.
   *
   * Env var name is intentionally verbose to prevent accidental enablement.
   * Default: "false".
   */
  DANGEROUSLY_EXPOSE_DEPLOYMENT_KV?: string;
  /**
   * P1-7: When "true", session IDs are bound to the authenticated principal.
   * A session created by one token cannot be accessed with a different token.
   * Default: "false".
   */
  PRINCIPAL_BOUND_SESSIONS?: string;
  BSCODE_FILES?: KVNamespace;
  BSCODE_SESSIONS?: KVNamespace;
  /** B1 — KV namespace for durable agent checkpoints. */
  BSCODE_CHECKPOINTS?: KVNamespace;
  /** B2 — KV namespace for browser-reported build/install/test outcomes. */
  BSCODE_BUILD_RESULTS?: KVNamespace;
  /** Rate limiting KV — stores per-session request counters for POST /run. */
  BSCODE_RATE_KV?: KVNamespace;
  /**
   * P0-4: Dedicated read-only KV for the public /mcp endpoint. Must be a
   * SEPARATE namespace from BSCODE_FILES. Only used when
   * DANGEROUSLY_EXPOSE_DEPLOYMENT_KV=true.
   */
  BSCODE_PUBLIC_READ_KV?: KVNamespace;
  /** B3 follow-up — OpenAI-API-shape embedding endpoint (api key, base url, model). */
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const embedding =
      env.EMBEDDING_API_KEY && env.EMBEDDING_BASE_URL && env.EMBEDDING_MODEL
        ? {
            apiKey: env.EMBEDDING_API_KEY,
            baseUrl: env.EMBEDDING_BASE_URL,
            model: env.EMBEDDING_MODEL,
          }
        : undefined;
    const config: AppConfig = {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN,
      doubaoApiKey: env.DOUBAO_API_KEY,
      doubaoBaseUrl: env.DOUBAO_BASE_URL,
      deepseekApiKey: env.DEEPSEEK_API_KEY,
      deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
      glmApiKey: env.GLM_API_KEY,
      glmBaseUrl: env.GLM_BASE_URL,
      clientToken: env.BSCODE_CLIENT_TOKEN,
      allowedOrigin: env.BSCODE_ALLOWED_ORIGIN,
      trainingDataMode: env.TRAINING_DATA_MODE === "true",
      // P0-5: strict auth mode — must not coexist with allowLocalSessionFallback=true
      strictAuth: env.STRICT_AUTH === "true",
      // P0-4: public MCP flag — requires BSCODE_PUBLIC_READ_KV to be bound
      publicMcpEnabled: env.DANGEROUSLY_EXPOSE_DEPLOYMENT_KV === "true",
      // P1-7: principal-bound sessions
      principalBoundSessions: env.PRINCIPAL_BOUND_SESSIONS === "true",
      filesKv: env.BSCODE_FILES ? kvFromNamespace(env.BSCODE_FILES) : undefined,
      sessionsKv: env.BSCODE_SESSIONS ? kvFromNamespace(env.BSCODE_SESSIONS) : undefined,
      checkpointsKv: env.BSCODE_CHECKPOINTS ? kvFromNamespace(env.BSCODE_CHECKPOINTS) : undefined,
      buildResultsKv: env.BSCODE_BUILD_RESULTS
        ? kvFromNamespace(env.BSCODE_BUILD_RESULTS)
        : undefined,
      rateKv: env.BSCODE_RATE_KV ? kvFromNamespace(env.BSCODE_RATE_KV) : undefined,
      // P0-4: dedicated read-only KV for the public /mcp endpoint
      publicReadKv: env.BSCODE_PUBLIC_READ_KV
        ? kvFromNamespace(env.BSCODE_PUBLIC_READ_KV)
        : undefined,
      ...(embedding ? { embedding } : {}),
    };
    const app = createApp(config);
    warnOptionalConfig(config);
    const guardResult = checkProductionConfig(config);
    if (!guardResult.ok && !config.allowLocalSessionFallback) {
      return new Response(
        JSON.stringify({ error: "Missing required bindings", missing: guardResult.missing }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
