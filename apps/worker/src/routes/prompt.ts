import type { Hono } from "hono";
import type { AppConfig } from "../platform.js";

export function mountPromptRoutes(app: Hono, config: AppConfig): void {
  // ── Enhance Prompt — expand vague task into detailed spec (bolt.new pattern) ─
  // Uses Claude Haiku to rewrite a vague user prompt into a detailed, actionable
  // specification. Returns the enhanced prompt so the frontend can show a preview
  // before submitting to the full agent run.
  app.post("/enhance-prompt", async (c) => {
    const { task, mode, framework } = await c.req.json<{
      task: string;
      mode?: string;
      framework?: string | null;
    }>();
    if (!task) return c.json({ error: "task required" }, 400);

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ enhanced: task }); // passthrough fallback

    const { AnthropicModel } = await import("@wasmagent/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const modeCtx = framework
      ? `The user is building a ${framework} web app.`
      : mode === "code"
        ? "The user wants to write and execute JavaScript/Python code."
        : "The user wants to use file tools to build or modify a codebase.";

    const systemMsg = `You are a prompt engineer. Your job is to take a vague coding task and expand it into a clear, detailed specification that a coding agent can execute precisely.

${modeCtx}

Rules:
- Keep the enhanced prompt concise (3-8 sentences)
- Add specific technical details that were implied but not stated
- Specify expected inputs, outputs, and edge cases
- Mention UI/UX details for frontend tasks (colors, interactions, layout)
- Do NOT change the core intent — only add clarity
- Write in the same language as the original (Chinese stays Chinese, English stays English)
- Reply with ONLY the enhanced task description, no preamble`;

    try {
      let enhanced = "";
      for await (const ev of model.generate(
        [
          { role: "system", content: systemMsg },
          { role: "user", content: task },
        ],
        { stream: true, maxTokens: 300 }
      )) {
        if (ev.type === "text_delta" && ev.delta) enhanced += ev.delta;
      }
      return c.json({ enhanced: enhanced.trim() || task });
    } catch {
      return c.json({ enhanced: task });
    }
  });

  // ── Clarify — detect ambiguity and generate clarifying questions (Lovable pattern) ──
  // Returns { needsClarification: boolean, questions: string[] } so the frontend
  // can ask the user before burning tokens on a potentially wrong execution.
  app.post("/clarify", async (c) => {
    const { task, context } = await c.req.json<{ task: string; context?: string }>();
    if (!task) return c.json({ error: "task required" }, 400);

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ needsClarification: false, questions: [] });

    const { AnthropicModel } = await import("@wasmagent/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const prompt = `You are deciding whether a coding task needs clarification before execution.
IMPORTANT: Reply in the SAME LANGUAGE as the task (Chinese task → Chinese questions).

Task: "${task.slice(0, 600)}"
${context ? `Context: "${context.slice(0, 200)}"` : ""}

DEFAULT: Do NOT ask. Only ask when the task is so vague that executing it would very likely produce the WRONG output.

NEVER ask when the task:
- Names specific technology/format (React, D2, Markdown, SQL, REST…)
- Has a clear deliverable (draw X, implement Y, fix Z, explain W)
- Is a standard well-known operation (sort array, add button, create todo app, draw flowchart, explain code)
- Contains enough specifics to make a reasonable choice (e.g. "画一个系统架构图（前端→API→数据库）" is fully specified)

ONLY ask when:
- The scope is completely undefined ("make it better", "build a dashboard" with NO other info, "add authentication" with zero context)
- Two completely different valid interpretations exist AND the wrong choice wastes significant effort
- Max 2 questions. Options: 2-4 short labels (2-5 words each)

When in doubt → do NOT ask.

Reply JSON only:
{"needsClarification": false}
OR
{"needsClarification": true, "questions": [
  {"text": "question text", "options": ["Option A", "Option B"]}
]}`;

    try {
      let text = "";
      for await (const ev of model.generate([{ role: "user", content: prompt }], {
        stream: true,
        maxTokens: 300,
      })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      const jsonMatch = /\{[\s\S]*\}/.exec(text.trim());
      if (!jsonMatch) return c.json({ needsClarification: false, questions: [] });
      const result = JSON.parse(jsonMatch[0]) as {
        needsClarification: boolean;
        questions?: Array<{ text: string; options: string[] } | string>;
      };
      // Normalise — handle both old string format and new {text, options} format
      const questions = (result.questions ?? [])
        .slice(0, 2)
        .map((q) =>
          typeof q === "string"
            ? { text: q, options: [] }
            : { text: q.text, options: (q.options ?? []).slice(0, 4) }
        );
      return c.json({
        needsClarification: result.needsClarification ?? false,
        questions,
      });
    } catch {
      return c.json({ needsClarification: false, questions: [] });
    }
  });

  // ── Generate from schema — Glide data-schema-first UI generation ─────────
  // Accepts a JSON schema and returns a React component that renders a form/view
  // for that schema, with field types mapped to appropriate UI components.
  app.post("/generate-from-schema", async (c) => {
    const {
      schema,
      framework = "react",
      componentName = "DataForm",
    } = await c.req.json<{
      schema: Record<string, unknown>;
      framework?: string;
      componentName?: string;
    }>();
    if (!schema) return c.json({ error: "schema required" }, 400);

    // Type-to-component mapping (Glide pattern)
    const typeMap: Record<string, { component: string; props: string }> = {
      string: { component: "Input", props: 'type="text"' },
      number: { component: "Input", props: 'type="number"' },
      integer: { component: "Input", props: 'type="number" step="1"' },
      boolean: { component: "input", props: 'type="checkbox"' },
      array: { component: "Textarea", props: 'placeholder="JSON array"' },
      object: { component: "Textarea", props: 'placeholder="JSON object"' },
    };

    // Heuristic: detect image/date/email by field name
    const nameHints: Record<string, { component: string; props: string }> = {
      image: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      img: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      photo: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      date: { component: "Input", props: 'type="date"' },
      time: { component: "Input", props: 'type="time"' },
      email: { component: "Input", props: 'type="email"' },
      phone: { component: "Input", props: 'type="tel"' },
      url: { component: "Input", props: 'type="url"' },
      color: { component: "Input", props: 'type="color"' },
      password: { component: "Input", props: 'type="password"' },
    };

    const properties = (schema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >;
    const required = new Set<string>((schema.required as string[]) ?? []);

    const fields = Object.entries(properties).map(([name, def]) => {
      const lower = name.toLowerCase();
      const hint = Object.entries(nameHints).find(([k]) => lower.includes(k))?.[1];
      const mapped = hint ?? typeMap[def.type ?? "string"] ?? typeMap.string;
      return { name, ...mapped, required: required.has(name), description: def.description };
    });

    // Generate React component (framework=react default)
    const componentCode =
      framework === "react"
        ? `
import { useState } from "react";

interface ${componentName}Data {
${fields.map((f) => `  ${f.name}${f.required ? "" : "?"}: ${f.component === "input" ? "boolean" : "string"};`).join("\n")}
}

export function ${componentName}({ onSubmit }: { onSubmit?: (data: ${componentName}Data) => void }) {
  const [data, setData] = useState<${componentName}Data>({
${fields.map((f) => `    ${f.name}: ${f.component === "input" ? "false" : '""'},`).join("\n")}
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit?.(data); }} className="space-y-4 p-4">
${fields
  .map(
    (f) => `      <div className="flex flex-col gap-1">
        <label htmlFor="${f.name}" className="text-sm font-medium">${f.name}${f.required ? " *" : ""}</label>
        ${
          f.component === "Textarea"
            ? `<textarea id="${f.name}" ${f.props} value={data.${f.name} as string} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.value}))} className="border rounded p-2" />`
            : f.component === "img"
              ? `{data.${f.name} && <${f.component} src={data.${f.name} as string} ${f.props} />}`
              : `<${f.component === "Input" ? "input" : f.component} id="${f.name}" ${f.props} ${f.component === "input" ? `checked={data.${f.name} as boolean} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.checked}))` : `value={data.${f.name} as string} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.value}))`} className="border rounded p-2" />`
        }
      </div>`
  )
  .join("\n")}
      <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded">Submit</button>
    </form>
  );
}
`.trim()
        : `// Framework "${framework}" not yet supported for schema generation.`;

    return c.json({
      ok: true,
      framework,
      componentName,
      code: componentCode,
      fields: fields.length,
    });
  });

  // ── Task classifier — detects agent mode from task description ────────────
  // Uses Claude Haiku for fast, cheap classification (typically < 500ms).
  // Returns { mode, framework } so the frontend can auto-configure before running.
  app.post("/classify", async (c) => {
    const { task } = await c.req.json<{ task: string }>();
    if (!task) return c.json({ error: "task required" }, 400);

    // Fast-path: diagram/visualization-only tasks belong in "code" mode
    // (the agent emits a card:d2 / card:mermaid block — no files, no
    // WebContainers). Without this the LLM classifier sometimes routes
    // "画一个流程图" / "draw a sequence diagram" to "framework·vanilla",
    // which spins up WebContainers for nothing.
    const lcTask = task.toLowerCase();
    const diagramKeywords = [
      "画.*?(图|流程图|架构图|时序图|关系图|拓扑图|思维导图)",
      "(draw|render|create|make|generate).*\\b(diagram|flowchart|flow chart|sequence|architecture|topology|mindmap|mind map|er diagram|state machine)\\b",
      "\\b(d2|mermaid|graphviz|plantuml)\\b",
    ];
    const isDiagramTask = diagramKeywords.some((re) => new RegExp(re, "i").test(lcTask));
    // Only honor the fast-path if the task does NOT also ask for an app
    // / interactive UI (e.g. "build a Vue app that draws a diagram") —
    // those still need framework mode.
    const looksLikeApp =
      /\b(app|todo|game|component|website|ui|界面|应用|网站|游戏|计算器|看板)\b/i.test(lcTask);
    if (isDiagramTask && !looksLikeApp) {
      return c.json({ mode: "code", framework: null, loop: "single" });
    }

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ mode: "tool", framework: null, loop: "single" }); // fallback

    const { AnthropicModel } = await import("@wasmagent/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const prompt = `Classify this user task on TWO orthogonal axes. Reply with ONLY valid JSON.

Task: "${task.slice(0, 500)}"

# Axis 1 — "mode" (what kind of agent runs)

- "framework": The task asks to build a UI app, web app, website, interactive animation/game with visuals, or use React/Vue/Svelte/Next.js/Vite. Choose this for games (贪吃蛇, calculator app, todo app, etc), canvas animations (fireworks, particle effects, etc), or anything that needs a live interactive visual output in the browser.
- "code": The task asks to write/execute an algorithm, function, data structure, math computation, data analysis, OR to draw a static diagram (flow chart, sequence diagram, architecture, ER, mind map — D2 / Mermaid / PlantUML output). Choose this ONLY for non-visual, non-interactive scripts and for diagram-only output (which renders inline as a card, no app needed). If the task would normally use tkinter/pygame/GUI on desktop → use "framework" instead.
- "tool": Everything else — file operations, multi-file projects without a framework, analysis, refactoring, writing documents/reports/READMEs.

If mode is "framework", also pick "framework_kind": "react" | "vue" | "svelte" | "vanilla"
- react: React, Next.js, or unspecified frontend framework
- vue: Vue.js
- svelte: Svelte
- vanilla: Pure JS/TS, Canvas games/animations, HTML-only, no framework preference

# Axis 2 — "loop" (does completion need a verifier loop?)

- "verify": The user expects a substantive deliverable that should be machine-checkable. Pick this when the task implies non-trivial *quality bars*:
    • Long-form writing: "写一篇/份介绍/报告/文档/README/教程" with implicit length expectations (≥500 字 / ≥600 words).
    • Multi-file refactor or feature implementation that should *actually work* (e.g. tests pass, build succeeds, specific behaviour).
    • "Comprehensive / 全面 / 详细 / 深入 / 完整" anywhere in the task is a strong signal for "verify".
    • Anything where an outline / one-paragraph stub would be visibly wrong.
- "single": Quick tasks where one shot of a tool-calling agent is enough.
    • Short questions, single-line edits, "add a console.log", "fix this typo", "what does X mean".
    • Chat-style replies that don't produce a substantive artifact.
    • When uncertain between "single" and "verify" for a SHORT task → pick "single" (cheaper).

The two axes are independent: a "tool" task can be either "single" or "verify".

Reply JSON only, no explanation:
{"mode":"framework","framework":"react","loop":"single"}
or {"mode":"code","framework":null,"loop":"verify"}
or {"mode":"tool","framework":null,"loop":"verify"}
or {"mode":"tool","framework":null,"loop":"single"}`;

    try {
      let text = "";
      for await (const ev of model.generate([{ role: "user", content: prompt }], {
        stream: true,
        maxTokens: 80,
      })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      const jsonMatch = /\{[\s\S]*?\}/.exec(text.trim());
      if (!jsonMatch) return c.json({ mode: "tool", framework: null, loop: "single" });
      const result = JSON.parse(jsonMatch[0]) as {
        mode: string;
        framework: string | null;
        loop?: string;
      };
      const validModes = ["code", "tool", "framework"];
      const validFrameworks = ["react", "vue", "svelte", "vanilla", null];
      const validLoops = ["single", "verify"];
      if (!validModes.includes(result.mode)) {
        return c.json({ mode: "tool", framework: null, loop: "single" });
      }
      if (!validFrameworks.includes(result.framework)) result.framework = "react";
      // Loop default = "single" so an upstream model that hasn't learned the
      // axis yet behaves like the pre-2026-06-18 classifier — backward
      // compatible at the API level.
      const loop = validLoops.includes(result.loop ?? "") ? result.loop : "single";
      return c.json({ mode: result.mode, framework: result.framework, loop });
    } catch {
      return c.json({ mode: "tool", framework: null, loop: "single" });
    }
  });
}
