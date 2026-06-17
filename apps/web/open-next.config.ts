/**
 * OpenNext Cloudflare adapter configuration.
 *
 * `defineCloudflareConfig()` returns the default config — that's what we
 * want here. OpenNext takes the standard Next.js build output (the
 * `.next/` directory) and produces a Cloudflare Worker (`.open-next/worker.js`)
 * plus the static asset directory (`.open-next/assets`) that wrangler picks
 * up via the `[assets]` binding in `wrangler.toml`.
 *
 * Why we use OpenNext instead of `@cloudflare/next-on-pages`:
 *   - **Platform-neutral build.** OpenNext takes Next.js's standard build
 *     output (no `vercel build` shim). Means the same `apps/web` checkout
 *     can deploy to Vercel, Netlify, Docker, or anywhere else without
 *     touching the Next config — only this adapter / wrangler.toml is CF-
 *     specific.
 *   - **Single Worker for static + dynamic.** next-on-pages required two
 *     separate paths (Pages for static, plus an edge handler for routes);
 *     OpenNext serves both from one Worker via the `assets` binding
 *     introduced by Cloudflare in 2024-09.
 *   - **Looser runtime constraints.** Some demos (e.g. /api/recipes/run's
 *     Function() stub evaluator) ran fine on raw Workers but were rejected
 *     by next-on-pages's edge-runtime gate. OpenNext goes through the full
 *     V8 isolate, which CF Workers does support.
 *
 * If you ever switch this consumer to a non-Cloudflare deploy (e.g. Docker
 * container with `next start`), you can leave this file in place — it is
 * a no-op when the OpenNext build is not invoked. The CF-specific bits
 * are: this file, `wrangler.toml`, and the `deploy` script in package.json.
 */
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
