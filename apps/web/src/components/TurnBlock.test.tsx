/**
 * 2026-06-18 — TurnBlock card-vs-inline rendering.
 *
 * Pins down the heuristic that decides whether `card:markdown` becomes a
 * compact card (default — chat shows a button, right pane shows full
 * content) or stays inline-rendered as a long markdown block (only when
 * framework mode produced a real WebContainer URL — see commit 2841407).
 *
 * Also covers card download + meta subtitle so a future copy edit can't
 * silently regress the format `{N} lines · {bytes} · {type}`.
 *
 * Fixture filenames are deliberately neutral (`enterprise-overview.md`,
 * etc.) — see [[no-sap-references-in-public-repos]].
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTurn } from "@/lib/conversationTypes";
import { cardDownloadName, formatBytes, TurnBlock } from "./TurnBlock";

const baseTurn: ConversationTurn = {
  id: "t1",
  task: "draft an enterprise AI overview md",
  detectedMode: { mode: "tool", framework: null },
  timestamp: 1_700_000_000_000,
  agentText: "",
  planText: null,
  toolLines: [],
  finalAnswer: null,
  error: null,
  status: "done",
  writtenFiles: ["enterprise-overview.md"],
  thinkingCollapsed: true,
};

const MD_CARD_REPLY = [
  "I drafted the overview.",
  "",
  "```card:markdown enterprise-overview.md",
  "# Enterprise AI Overview",
  "",
  "## Section 1",
  "Body line 1.",
  "Body line 2.",
  "```",
].join("\n");

function renderTurn(overrides: {
  isFrameworkMode: boolean;
  previewUrl?: string;
  finalAnswer?: string;
}) {
  const turn: ConversationTurn = {
    ...baseTurn,
    finalAnswer: overrides.finalAnswer ?? MD_CARD_REPLY,
  };
  const onPreview = vi.fn();
  const utils = render(
    <TurnBlock
      turn={turn}
      isActive={false}
      onRetry={() => {}}
      onPreviewCard={onPreview}
      isFrameworkMode={overrides.isFrameworkMode}
      previewUrl={overrides.previewUrl}
    />
  );
  return { ...utils, onPreview };
}

describe("TurnBlock — card-vs-inline heuristic", () => {
  it("Tool mode + writtenFiles>0: renders card button, NOT inline markdown", () => {
    renderTurn({ isFrameworkMode: false });
    // Card subtitle present
    expect(screen.getByText(/lines · .* · markdown/)).toBeTruthy();
    // Inline markdown body should NOT have rendered the H1 contents
    expect(screen.queryByRole("heading", { name: "Enterprise AI Overview" })).toBeNull();
    // Filename meta is the card title
    expect(screen.getByText("enterprise-overview.md")).toBeTruthy();
  });

  it("Framework mode + previewUrl: keeps inline markdown recap (preserves commit 2841407)", () => {
    renderTurn({
      isFrameworkMode: true,
      previewUrl: "https://abcdef-3000.local-credentialless.webcontainer.io",
    });
    // Inline markdown DID render — H1 visible as a real heading
    expect(screen.getByRole("heading", { name: "Enterprise AI Overview" })).toBeTruthy();
    // No card subtitle button
    expect(screen.queryByText(/lines · .* · markdown/)).toBeNull();
  });

  it("Framework mode but previewUrl not yet ready: still renders card (no race-y inline)", () => {
    renderTurn({ isFrameworkMode: true, previewUrl: undefined });
    expect(screen.getByText(/lines · .* · markdown/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Enterprise AI Overview" })).toBeNull();
  });

  it("clicking the card body sends the card to onPreviewCard", () => {
    const { onPreview } = renderTurn({ isFrameworkMode: false });
    // The first button (the card body) is the title; click it
    const titleBtn = screen.getByRole("button", {
      name: /Open enterprise-overview\.md in preview/,
    });
    fireEvent.click(titleBtn);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls[0][0].type).toBe("markdown");
    expect(onPreview.mock.calls[0][0].meta).toBe("enterprise-overview.md");
  });

  it("download button triggers a blob URL with the right filename", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    const origCreate = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    const origRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    try {
      renderTurn({ isFrameworkMode: false });
      const dlBtn = screen.getByRole("button", { name: /Download enterprise-overview\.md/ });
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      fireEvent.click(dlBtn);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blobArg = createObjectURL.mock.calls[0][0] as Blob;
      expect(blobArg.type).toMatch(/^text\/markdown/);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
    } finally {
      URL.createObjectURL = origCreate as typeof URL.createObjectURL;
      URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
    }
  });
});

describe("TurnBlock — pure helpers", () => {
  it("formatBytes formats below KB / KB / MB scales", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("cardDownloadName uses meta verbatim when it has an extension", () => {
    expect(
      cardDownloadName({ id: "card-0", type: "markdown", content: "x", meta: "notes.md" })
    ).toBe("notes.md");
  });

  it("cardDownloadName falls back to id + type extension when meta is missing", () => {
    expect(cardDownloadName({ id: "card-0", type: "markdown", content: "x" })).toBe("card-0.md");
    expect(cardDownloadName({ id: "card-1", type: "d2", content: "x" })).toBe("card-1.d2");
  });

  it("cardDownloadName sanitizes weird chars in meta when no extension", () => {
    expect(
      cardDownloadName({ id: "card-0", type: "markdown", content: "x", meta: "hello world!" })
    ).toBe("hello-world-.md");
  });
});

describe("TurnBlock — Goal-directed timeline", () => {
  it("renders the timeline with criteria, iteration counter, and verified outcome", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      finalAnswer: "ok",
      goalCriteria: [
        {
          id: "size",
          description: "≥1500 bytes",
          verify_method: "file_size_min",
          arg: 1500,
          path: "doc.md",
        },
        {
          id: "depth",
          description: "covers principle, types, applications",
          verify_method: "llm_judge",
          path: "doc.md",
        },
      ],
      goalIteration: 2,
      goalDone: {
        outcome: "verified",
        iterationCount: 2,
        totalInputTokens: 800,
        totalOutputTokens: 1200,
      },
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    expect(screen.getByText(/Goal-directed/i)).toBeTruthy();
    expect(screen.getByText(/iteration 2/)).toBeTruthy();
    expect(screen.getByText(/✓ verified/)).toBeTruthy();
    expect(screen.getByText(/file_size_min/)).toBeTruthy();
    expect(screen.getByText(/llm_judge/)).toBeTruthy();
    expect(screen.getByText(/≥1500 bytes/)).toBeTruthy();
  });

  it("does not render when no goal-directed state is set", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      finalAnswer: "ok",
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    expect(screen.queryByText(/Goal-directed/i)).toBeNull();
  });

  it("shows the lastHint when the loop didn't fully verify", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      finalAnswer: "ok",
      goalCriteria: [
        {
          id: "size",
          description: "≥1500 bytes",
          verify_method: "file_size_min",
          arg: 1500,
          path: "doc.md",
        },
      ],
      goalDone: {
        outcome: "exhausted",
        iterationCount: 5,
        totalInputTokens: 2000,
        totalOutputTokens: 3000,
        lastHint: "- size: file doc.md is 800 bytes; criterion requires ≥1500",
      },
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    expect(screen.getByText(/× exhausted/)).toBeTruthy();
    expect(screen.getByText(/file doc.md is 800 bytes/)).toBeTruthy();
  });
});

describe("TurnBlock — mode badge with classifier loop axis", () => {
  it("loop=single (default) renders the plain mode label", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      detectedMode: { mode: "tool", framework: null, loop: "single" },
      finalAnswer: "ok",
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    // Plain "Tool + DAG" — no goal-mode suffix.
    expect(screen.getByText("Tool + DAG")).toBeTruthy();
    expect(screen.queryByText(/Tool \+ DAG · 🎯/)).toBeNull();
  });

  it("loop=verify appends a 🎯 suffix so the auto-routing decision is visible", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      detectedMode: { mode: "tool", framework: null, loop: "verify" },
      finalAnswer: "ok",
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    expect(screen.getByText("Tool + DAG · 🎯")).toBeTruthy();
  });

  it("loop=verify also applies to code mode badges", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      detectedMode: { mode: "code", framework: null, loop: "verify" },
      finalAnswer: "ok",
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={false}
      />
    );
    expect(screen.getByText("Code + WASM · 🎯")).toBeTruthy();
  });

  it("framework mode ignores loop axis (it has its own plan→build loop already)", () => {
    const turn: ConversationTurn = {
      ...baseTurn,
      detectedMode: { mode: "framework", framework: "react", loop: "verify" },
      finalAnswer: "ok",
    };
    render(
      <TurnBlock
        turn={turn}
        isActive={false}
        onRetry={() => {}}
        onPreviewCard={() => {}}
        isFrameworkMode={true}
        previewUrl="https://x.local"
      />
    );
    // Plain framework label, no 🎯 suffix.
    expect(screen.getByText("Framework · react")).toBeTruthy();
    expect(screen.queryByText(/Framework.*🎯/)).toBeNull();
  });
});
