# bscode + Loop Engineering — 改进点分析

> 触发：用户问"是否有 bscode 方面可以根据 Loop Engineering 优化的"。
> 这份文档审计 bscode 当前架构跟 Loop Engineering 文档（Addy Osmani，
> 2026-06）的对齐情况，并给出具体改进。
>
> 状态：分析阶段，不动 bscode 代码。等 evomerge SFT v5 完成 + agentkit
> `GoalAgent`/`IPT` 进入下一个发布版本后再决定哪些落实。

## TL;DR — 现状

bscode **已经是 Loop Engineering 的实例**，但走的是 **harness 路线**
而不是 **goal 路线**。两者本质都对，结构不同：

- **harness 路线（bscode 当前）**：agent 拿到 `read_build_result` 工具，
  自己决定何时检查、何时修。Loop 隐含在 `maxSteps` 中。
- **goal 路线（agentkit `GoalAgent`）**：framework 接管 verify 时机，
  每轮固定调用 `verify()`。Loop 显式在 framework 层。

bscode 的 B2（`docs/B2-validation-loop.md`）实际已经在做 goal 路线
该做的事 —— `putBuildResult` / `getBuildResult` 是显式的 verifier
state，只差一层声明式包装。

## 三档对照（bscode 现状 vs Loop Engineering 6 组件）

| 组件 | bscode 实现 | 对齐度 |
|---|---|---|
| **Automations** | 不在范围（用户在浏览器手动触发） | ⚪ 不需要 |
| **Worktrees** | `jobBranches.ts`（每个 job 一个 branch） | ✅ 完整 |
| **Skills** | 无（agentkit core 有，bscode 不直接用） | ⚪ 现阶段不需要 |
| **Plugins / Connectors** | MCP via `apps/worker/src/mcp.ts` | ✅ 完整 |
| **Sub-agents** | `apps/worker/src/agents/multi-agent.ts`（fan-out modes） | ✅ 完整 |
| **Memory / State** | KV checkpointer + `build-results.ts` 反向 channel | ✅ 完整 |
| **Verifier sub-agent** | `visualVerifier.ts` + `visionJudge.ts` —— **bscode 比 agentkit 多一层 visual verifier** | ✅+ 超出 |
| **`/goal` 原语** | 无（隐含在 maxSteps + tool call patterns） | ⚠️ 可加 |
| **L1 / L2 / L3 分层** | 部分（fan-out 是横向，不是纵向 tier） | ⚠️ 可加 |
| **IPT 反 reward-hacking** | 无 | ⏳ 等 agentkit 发布版进入 |

## 三件具体可加的事（按 ROI 排序）

### 1. **B2 + GoalAgent 包装** — ⭐ 最有价值

bscode B2 现有代码：

```ts
// apps/worker/src/build-results.ts
export async function getBuildResult(sessionId: string, kv?: KvStore): Promise<BuildResultSnapshot | null>
export async function putBuildResult(sessionId, snapshot, kv): Promise<void>
```

`getBuildResult` 已经是 verifier 形状。包一层 `GoalAgent.verify`：

```ts
// 假想的 apps/worker/src/agents/goal-driven.ts
import { GoalAgent } from "@wasmagent/core";
import { getBuildResult } from "../build-results.js";

export function makeBuildPassGoal(sessionId: string, kv: KvStore) {
  return {
    describe: "The project must build successfully and the dev server must run without errors.",
    verify: async () => {
      const snap = await getBuildResult(sessionId, kv);
      if (!snap) return { ok: false, hint: "No build result yet — run the project first" };
      if (snap.status === "ready") return { ok: true } as const;
      return {
        ok: false,
        hint: `Build failed at stage=${snap.stage}, exitCode=${snap.exitCode ?? "?"}, stderr=${snap.stderr?.slice(-500) ?? ""}`,
      };
    },
  };
}

// 用法
const goalAgent = new GoalAgent({
  model,
  tools: [readBuildResult, writeFile, /* ... */],
  maxIterations: 5,
  tokenBudget: 200_000,
});

for await (const ev of goalAgent.run(makeBuildPassGoal(sessionId, env.KV))) {
  // stream to SSE
}
```

**收益**：
- 把 "build pass" 的 goal 从 prompt 里隐式约定 → SDK 显式可验证
- 跨 iteration 自动重置 ToolCallingAgent history（避免上轮"声称完成"污染下轮）
- 自动跑 budget / step / iteration 三层熔断（文档第 202 行强烈推荐）
- `goal_done` event 直接给 UI 用作"完成判定"，不用解析 final_answer 文本

**代价**：
- 需要 bscode 升级到下一个 agentkit 发布版（含 `GoalAgent`）
- ~50 LOC 的 adapter

**建议时机**：等 agentkit `GoalAgent` 发版本号（当前在 main 但还没 release）+ evomerge v5 SFT 跑完 + 验证 `GoalAgent` 在 1.7B 模型上的真实表现。

### 2. **现有 visualVerifier 加 IPT 检测层** — 中价值

bscode 的 `visionJudge.ts` 让 LLM 看截图判定 "UI 渲染对了吗"。这是
**LLM-based verifier** —— 文档里反复警告这种东西易被 reward hacked。

可以加一层 IPT 检测：同一份 UI 任务用两个语义等价的 prompt（"render
a login form" vs "create a sign-in page with email and password
inputs"），跑结果配对喂给 `iptShortcutRate`。

**收益**：把 visionJudge 的可信度数值化。如果 shortcut rate < 0.10，
publish 那个数字证明 visionJudge 没被钻空子。

**代价**：需要造 ~5-10 对 isomorphic UI 任务。这是 evals 增量，不是
production 改动。

**建议时机**：作为 bscode 0.2 release 的"质量证据" feature，跟下一轮
agentkit memory eval 一起 publish。

### 3. **B2 加显式 token / iteration budget UI** — 低价值

文档第 202 行强调 "step 上限 + token budget 是必须的熔断器"。bscode B2
现在依赖 agent `maxSteps`，没有跨 iteration 累计预算。

如果换成 GoalAgent（点 1），自动获得 `tokenBudget`。如果不换 GoalAgent，
可以单独加一个 "session token cap" middleware。

**收益**：防止某些任务循环到 \$5+/session 而不被发现。
**代价**：~30 LOC + 一个 UI surface 显示 budget burn。

**建议时机**：等 GoalAgent 集成（点 1）后，这个自动到位，单独做意义不大。

## 不该做的事

### Loop Engineering 文档里的 Automations / `/loop` cron

bscode 是 Cloudflare Worker + 浏览器架构，**用户主动触发**的 webapp。
加 cron 自循环违反产品定位（thin funnel）。

### 替换现有 visualVerifier 为别的东西

`visionJudge.ts` 是 bscode 跟 agentkit 的差异化优势之一（agentkit 只有
程序化 evaluator，没有 visual verifier）。Loop Engineering 文档里"评估"
是天花板 —— bscode 这一层比文档建议的更好，**不要拆**。

### 加完整 IPT 防御套件

只做点 2（visionJudge 加 IPT 数字层）。其他论文里的 reward-hacking 防御
（捷径方向探针、inoculation prompting、process supervision）都是训练侧的，
跟 bscode 的应用层无关。

## 如果只能做一件

**做点 1：B2 + GoalAgent 包装。**

- 把 bscode "你写代码的 agent" 升级为 "你声明 goal 的系统"
- agent.run() prompt 调用 → goalAgent.run({describe, verify}) 声明
- 直接对应 Claude Code v2.1.139 `/goal` 的 SDK 形态，但 bscode 是
  edge-deployed webapp（Claude Code 是本地 CLI）—— 这个差异化点真实
  存在
- README 可以多一段："bscode 是 the world's first edge-deployed `/goal`
  agent" 这种 marketing line

但这必须等 agentkit 把 `GoalAgent` 进 release tag，bscode 不能锁
`workspace:*`。

## 不动 bscode 代码的原因

evomerge 还在跑 v5 SFT 训练（PID 70648, 用我前面 ship 的 v2 arm-f
shape 数据训练）。bscode 改动会需要 typecheck + 跑测试，CPU 占用
对 evomerge MPS/CPU 训练影响不大但有风险。**先文档化分析，等训练完
再实际改 bscode。**

## 跨 repo 协调

bscode 改动的前置：
1. agentkit-js cut 一个 release tag 含 `GoalAgent` (当前 commit `e324fb9`)
2. evomerge v5 SFT 跑完，跑 Run I 看新 G1 数字
3. 决定要不要让 bscode showcase 1.7B SFT'd model + GoalAgent 组合
4. 只有 G0 PASS 了 D1-D4 才 unblock，bscode 才有理由改

所以这份分析现在落到 docs，不动代码，等触发条件齐了再实施。

---

## 参考

- agentkit-js [Loop Engineering vs agentkit-js mapping](../../agentkit-js/docs/strategy/loop-engineering-vs-agentkit.md)
- agentkit-js `GoalAgent` 源代码：`packages/core/src/agents/GoalAgent.ts`
- agentkit-js `IPT` 源代码：`packages/evals-runner/src/stats/ipt.ts`
- bscode [B2 — Closed-loop validation](./B2-validation-loop.md)
- 用户给的 Loop Engineering 文档：`/Users/I041705/Downloads/Loop-Engineering-循环工程-最终整合版.md`
