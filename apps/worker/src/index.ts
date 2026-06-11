/**
 * Cloudflare Workers entry point.
 * Adapts CF-specific bindings (KVNamespace, ExecutionContext) to the
 * platform-independent createApp() factory.
 */
import { type AppConfig, createApp } from "./app.js";
import { kvFromNamespace } from "./platform.js";

export interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  DOUBAO_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  BSCODE_CLIENT_TOKEN?: string;
  BSCODE_ALLOWED_ORIGIN?: string;
  AGENTKIT_LOG_LEVEL?: string;
  BSCODE_FILES?: KVNamespace;
  BSCODE_SESSIONS?: KVNamespace;
  /** B1 — KV namespace for durable agent checkpoints. */
  BSCODE_CHECKPOINTS?: KVNamespace;
  /** B2 — KV namespace for browser-reported build/install/test outcomes. */
  BSCODE_BUILD_RESULTS?: KVNamespace;
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
      deepseekApiKey: env.DEEPSEEK_API_KEY,
      clientToken: env.BSCODE_CLIENT_TOKEN,
      allowedOrigin: env.BSCODE_ALLOWED_ORIGIN,
      filesKv: env.BSCODE_FILES ? kvFromNamespace(env.BSCODE_FILES) : undefined,
      sessionsKv: env.BSCODE_SESSIONS ? kvFromNamespace(env.BSCODE_SESSIONS) : undefined,
      checkpointsKv: env.BSCODE_CHECKPOINTS ? kvFromNamespace(env.BSCODE_CHECKPOINTS) : undefined,
      buildResultsKv: env.BSCODE_BUILD_RESULTS ? kvFromNamespace(env.BSCODE_BUILD_RESULTS) : undefined,
      ...(embedding ? { embedding } : {}),
    };
    const app = createApp(config);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
