/**
 * B2 DoD ① — semantic_search vs grep substring search Top-3 hit-rate eval.
 *
 * Synthesises a 50-file project covering 10 distinct topics (auth, cart,
 * email, logging, ...). For each topic, runs a natural-language query
 * (e.g. "where is authentication handled") and measures whether the
 * canonical file appears in the Top-3 results returned by:
 *   • semantic_search — TF-IDF embedding ranked by cosine similarity
 *   • grep-style search — exact substring match on the same query
 *
 * The test PASSES when semantic_search Top-3 recall ≥ grep Top-3 recall on
 * a query set that intentionally avoids substring overlap with the file
 * content (e.g. "user login flow" → file uses "validateCredentials").
 * That's the asymmetry the README claim relies on.
 *
 * Repeat-runnable, deterministic, no external services.
 */

import { describe, expect, it } from "bun:test";
import { createSemanticIndexer } from "./semanticSearch.js";

interface Doc {
  path: string;
  content: string;
}

interface Query {
  /** Natural-language query — uses synonyms / paraphrase, not the file's literal vocabulary. */
  query: string;
  /** Canonical file the searcher should surface in Top-K. */
  expectedPath: string;
}

// ── 50-file fixture: 10 topics × 5 files each ────────────────────────────────
// One file per topic uses the exact "canonical" wording; the other 4 are
// support files in the same area (helpers, types, tests, fixtures).

const TOPICS = [
  {
    name: "auth",
    canonical: "src/auth/credentials.ts",
    canonicalContent:
      "validateCredentials accepts email and password, hashes via bcrypt, " +
      "and issues a JWT session token. Throws InvalidCredentialsError on mismatch.",
    others: [
      ["src/auth/types.ts", "InvalidCredentialsError extends Error; SessionToken interface"],
      ["src/auth/middleware.ts", "Express middleware that reads Bearer token from header"],
      ["src/auth/test.spec.ts", "describe wrapper for credential rejection cases"],
      ["src/auth/fixtures.ts", "Test fixture user records with seeded password hashes"],
    ],
  },
  {
    name: "cart",
    canonical: "src/checkout/basket.ts",
    canonicalContent:
      "Shopping basket: addItem, removeItem, computeSubtotal, computeTax, computeShipping, " +
      "computeGrandTotal. Persists to localStorage in browser; SSR-safe.",
    others: [
      ["src/checkout/types.ts", "Item interface; Basket interface; Currency enum"],
      ["src/checkout/persistence.ts", "Wraps window.localStorage with JSON serde"],
      ["src/checkout/test.spec.ts", "Basket arithmetic edge cases — empty, single, mixed currency"],
      ["src/checkout/coupons.ts", "Promo code application — percent-off and fixed-off"],
    ],
  },
  {
    name: "email",
    canonical: "src/notify/mailer.ts",
    canonicalContent:
      "sendMail dispatches transactional messages via SMTP. Supports TLS, " +
      "DKIM signing, and exponential backoff on transient 4xx responses.",
    others: [
      ["src/notify/templates.ts", "Handlebars compilation for confirmation messages"],
      ["src/notify/queue.ts", "BullMQ producer; retry policy for delivery failures"],
      ["src/notify/test.spec.ts", "Mock SMTP server; verifies header construction"],
      ["src/notify/types.ts", "MailEnvelope interface, Recipient address shape"],
    ],
  },
  {
    name: "logging",
    canonical: "src/observability/logger.ts",
    canonicalContent:
      "Structured logger producing JSON lines with severity, timestamp, " +
      "and trace id. Wraps pino with a redactor for PII fields like email and SSN.",
    others: [
      [
        "src/observability/redact.ts",
        "Recursive object walker that replaces matched keys with [REDACTED]",
      ],
      ["src/observability/transport.ts", "OTLP HTTP exporter for log shipping"],
      ["src/observability/test.spec.ts", "Snapshot tests for the redaction walker"],
      ["src/observability/types.ts", "LogLevel union; LogContext shape"],
    ],
  },
  {
    name: "rate-limit",
    canonical: "src/middleware/throttle.ts",
    canonicalContent:
      "Token bucket rate limiter. Limits requests per second per IP using " +
      "Redis INCR with PEXPIRE. Returns 429 when budget is exhausted.",
    others: [
      ["src/middleware/keys.ts", "buildRedisKey helper combining IP + route slug"],
      ["src/middleware/test.spec.ts", "Time-traveling clock tests for refill"],
      ["src/middleware/types.ts", "ThrottleConfig: bucketSize, refillPerSecond"],
      ["src/middleware/redis-client.ts", "Singleton ioredis connection"],
    ],
  },
  {
    name: "uploads",
    canonical: "src/storage/uploader.ts",
    canonicalContent:
      "Multipart S3 file uploads. Streams large payloads in 5 MiB chunks with " +
      "presigned URLs; resumable via etag manifest stored in DynamoDB.",
    others: [
      ["src/storage/types.ts", "UploadSession interface; Etag string brand"],
      ["src/storage/manifest.ts", "DynamoDB document client wrapper"],
      ["src/storage/test.spec.ts", "Mock S3 server; chunk boundary cases"],
      ["src/storage/presign.ts", "AWS SigV4 query-param signer"],
    ],
  },
  {
    name: "billing",
    canonical: "src/payments/stripe.ts",
    canonicalContent:
      "Stripe webhook handler. Verifies signature, parses charge events, " +
      "updates the subscription record, and triggers downstream invoicing.",
    others: [
      ["src/payments/types.ts", "ChargeEvent type union; Subscription interface"],
      ["src/payments/idempotency.ts", "Maintains an LRU cache of processed event ids"],
      ["src/payments/test.spec.ts", "Replay-attack prevention tests"],
      ["src/payments/refund.ts", "Refund issuance; partial-amount support"],
    ],
  },
  {
    name: "search-ui",
    canonical: "src/ui/typeahead.tsx",
    canonicalContent:
      "Typeahead React component. Debounces user keystrokes and queries the " +
      "/suggest endpoint; renders a popover with arrow-key navigation.",
    others: [
      ["src/ui/types.ts", "SuggestResult; TypeaheadProps"],
      ["src/ui/styles.ts", "Emotion styled-component overrides"],
      ["src/ui/test.spec.tsx", "@testing-library keystroke simulation"],
      ["src/ui/popover.tsx", "Floating UI portal positioning"],
    ],
  },
  {
    name: "i18n",
    canonical: "src/locale/translator.ts",
    canonicalContent:
      "Localization layer: lazy-loads message catalogues per locale, " +
      "falls back to en-US, supports ICU MessageFormat with plural rules.",
    others: [
      ["src/locale/types.ts", "Locale brand; Message catalogue map"],
      ["src/locale/loader.ts", "Dynamic import of JSON catalogues"],
      ["src/locale/test.spec.ts", "Plural form coverage for ar, ru, ja"],
      ["src/locale/numbers.ts", "Intl.NumberFormat helper wrappers"],
    ],
  },
  {
    name: "scheduling",
    canonical: "src/jobs/cron.ts",
    canonicalContent:
      "Recurring background jobs. Cron-style spec parsed with cron-parser; " +
      "leadership election via a Redis SETNX lock so only one node runs each tick.",
    others: [
      ["src/jobs/types.ts", "JobDefinition; LockHandle"],
      ["src/jobs/runner.ts", "Worker loop polling the next-due timestamp"],
      ["src/jobs/test.spec.ts", "DST transition handling"],
      ["src/jobs/lock.ts", "RedLock-style multi-node mutex helper"],
    ],
  },
];

const QUERIES: Query[] = [
  // Each query intentionally uses paraphrase rather than the file's literal vocab.
  { query: "user login flow with bearer tokens", expectedPath: "src/auth/credentials.ts" },
  { query: "shopping cart subtotal and tax computation", expectedPath: "src/checkout/basket.ts" },
  { query: "send transactional confirmation email via SMTP", expectedPath: "src/notify/mailer.ts" },
  {
    query: "structured JSON log lines with PII redaction",
    expectedPath: "src/observability/logger.ts",
  },
  { query: "per-IP request throttling with Redis", expectedPath: "src/middleware/throttle.ts" },
  { query: "resumable large file upload to S3", expectedPath: "src/storage/uploader.ts" },
  { query: "Stripe payment webhook subscription update", expectedPath: "src/payments/stripe.ts" },
  {
    query: "autocomplete dropdown component with keyboard navigation",
    expectedPath: "src/ui/typeahead.tsx",
  },
  {
    query: "translation and pluralization message format",
    expectedPath: "src/locale/translator.ts",
  },
  { query: "scheduled background tasks with leader election", expectedPath: "src/jobs/cron.ts" },
];

function buildCorpus(): Doc[] {
  const out: Doc[] = [];
  for (const t of TOPICS) {
    out.push({ path: t.canonical, content: t.canonicalContent });
    for (const [path, content] of t.others)
      out.push({ path: path as string, content: content as string });
  }
  return out;
}

/** Top-K substring search — exactly what bscode's search_code tool does. */
function grepTopK(corpus: Doc[], query: string, topK: number): string[] {
  const q = query.toLowerCase();
  const scored = corpus
    .map((d) => ({
      path: d.path,
      // Score by raw match count — strict substring of the full query.
      score: d.content.toLowerCase().split(q).length - 1,
    }))
    .filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((r) => r.path);
}

describe("B2 DoD ① — semantic_search vs grep on a 50-file project", () => {
  it("the corpus has exactly 50 files (10 topics × 5)", () => {
    expect(buildCorpus().length).toBe(50);
  });

  it("Top-3 recall: semantic_search materially outperforms substring grep", async () => {
    const corpus = buildCorpus();
    const indexer = createSemanticIndexer();
    for (const d of corpus) await indexer.upsert(d.path, d.content);

    let semanticHits = 0;
    let grepHits = 0;
    const trace: Array<{ q: string; semOk: boolean; grepOk: boolean }> = [];

    for (const { query, expectedPath } of QUERIES) {
      const semResult = await indexer.retriever.search(query, 3);
      const semPaths = semResult.map(
        (r) => (r.metadata as { path?: string } | undefined)?.path ?? r.id
      );
      const semOk = semPaths.includes(expectedPath);

      const grepPaths = grepTopK(corpus, query, 3);
      const grepOk = grepPaths.includes(expectedPath);

      if (semOk) semanticHits++;
      if (grepOk) grepHits++;
      trace.push({ q: query, semOk, grepOk });
    }

    const semanticRecall = semanticHits / QUERIES.length;
    const grepRecall = grepHits / QUERIES.length;

    // Always print the recall numbers so CI logs surface the eval result and
    // we don't silently drift below the threshold without anyone noticing.
    // eslint-disable-next-line no-console
    console.log(
      `[B2 eval] Top-3 recall — semantic_search=${(semanticRecall * 100).toFixed(0)}% ` +
        `grep=${(grepRecall * 100).toFixed(0)}% (${QUERIES.length} queries, 50-file corpus)`
    );
    if (semanticRecall <= grepRecall) {
      // eslint-disable-next-line no-console
      console.log("[B2 eval] per-query trace:", trace);
    }

    // Hard threshold the README implicitly relies on: TF-IDF semantic search
    // hits the canonical file in Top-3 substantially more often than the
    // raw-substring path. We require ≥ 60% recall on this paraphrase set
    // (vs grep which typically scores ≤ 20% because the queries deliberately
    // use synonyms).
    expect(semanticRecall).toBeGreaterThanOrEqual(0.6);
    expect(semanticRecall).toBeGreaterThan(grepRecall);
  });
});
