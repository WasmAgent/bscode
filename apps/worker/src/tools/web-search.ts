import type { ToolDefinition } from "@agentkit-js/core";
import { z } from "zod";

interface DdgRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DdgRelatedTopic[];
}

interface DdgResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DdgRelatedTopic[];
}

/**
 * Web search tool using DuckDuckGo Instant Answer API.
 * No API key required. Works in Cloudflare Workers (fetch only).
 * readOnly=true → DAG scheduler can run in parallel with other read tools.
 */
export function createWebSearchTool(): ToolDefinition<
  { query: string; maxResults?: number },
  string
> {
  return {
    name: "web_search",
    description:
      "Search the web for current information, documentation, or news. " +
      "Returns a list of relevant results with titles, URLs, and snippets. " +
      "Use this to find information that may not be in the codebase.",
    inputSchema: z.object({
      query: z.string().describe("Search query — be specific for better results"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe("Max results to return (default 5)"),
    }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ query, maxResults = 5 }) => {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "bscode/1.0 (+https://github.com/WasmAgent/bscode)" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) return `(search unavailable: HTTP ${resp.status})`;

        const data = (await resp.json()) as DdgResponse;
        const results: string[] = [];

        // Instant answer (abstract)
        if (data.AbstractText && data.AbstractURL) {
          results.push(
            `**${query}** (instant answer)\n${data.AbstractText}\n🔗 ${data.AbstractURL}`
          );
        }

        // Related topics
        const topics = (data.RelatedTopics ?? [])
          .flatMap((t) => (t.Topics ? t.Topics : [t]))
          .filter((t): t is DdgRelatedTopic => !!t.Text && !!t.FirstURL)
          .slice(0, maxResults);

        for (const t of topics) {
          results.push(`${t.Text}\n🔗 ${t.FirstURL}`);
        }

        if (results.length === 0) {
          return `No results found for: "${query}"\nTry rephrasing or using more specific terms.`;
        }

        return `Search results for "${query}":\n\n${results.slice(0, maxResults).join("\n\n---\n\n")}`;
      } catch (err) {
        return `(search unavailable: ${err instanceof Error ? err.message : String(err)})`;
      }
    },
  };
}
