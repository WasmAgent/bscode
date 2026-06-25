"use client";
import type { ClarifyQuestion } from "@/hooks/useAgent";
import { theme } from "@/lib/theme";

interface ClarifyPanelProps {
  questions: ClarifyQuestion[];
  answers: Record<number, string>;
  onAnswerChange: (qi: number, value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

export function ClarifyPanel({
  questions,
  answers,
  onAnswerChange,
  onSubmit,
  onSkip,
}: ClarifyPanelProps) {
  const allAnswered = questions.every((_, i) => (answers[i] ?? "").trim());
  const isChinese = /[一-龥]/.test(questions[0]?.text ?? "");

  return (
    <div
      style={{
        marginBottom: 10,
        background: "#0d1b2a",
        border: "1px solid #1f6feb55",
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#58a6ff",
          fontWeight: 700,
          marginBottom: 10,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          💬 {isChinese ? "几个问题帮我更好地理解需求：" : "A few questions before I start:"}
        </span>
        <button
          type="button"
          onClick={onSkip}
          style={{
            background: "none",
            border: "none",
            color: theme.textMuted,
            fontSize: 10,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {isChinese ? "跳过，直接运行 →" : "Skip, run anyway →"}
        </button>
      </div>

      {questions.map((q, qi) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: questions render once per clarification round; index IS identity
          key={qi}
          style={{ marginBottom: qi < questions.length - 1 ? 12 : 8 }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#c9d1d9",
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            {qi + 1}. {q.text}
          </div>

          {/* Option buttons */}
          {q.options.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
              {q.options.map((opt, oi) => {
                const selected = answers[qi] === opt;
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: option list is fixed per question — index IS identity
                    key={oi}
                    type="button"
                    onClick={() => onAnswerChange(qi, selected ? "" : opt)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 20,
                      border: `1px solid ${selected ? "#58a6ff" : "#30363d"}`,
                      background: selected ? "#1f6feb22" : "transparent",
                      color: selected ? "#58a6ff" : theme.textMuted,
                      fontSize: 11,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      transition: "all 0.1s",
                    }}
                  >
                    {opt}
                  </button>
                );
              })}
              {/* "Other" option to show free text */}
              <button
                type="button"
                onClick={() =>
                  onAnswerChange(
                    qi,
                    answers[qi] && !q.options.includes(answers[qi]) ? "" : "other:"
                  )
                }
                style={{
                  padding: "5px 12px",
                  borderRadius: 20,
                  border: `1px solid ${answers[qi] && !q.options.includes(answers[qi]) ? "#58a6ff" : "#30363d"}`,
                  background:
                    answers[qi] && !q.options.includes(answers[qi]) ? "#1f6feb22" : "transparent",
                  color:
                    answers[qi] && !q.options.includes(answers[qi]) ? "#58a6ff" : theme.textMuted,
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {isChinese ? "其他…" : "Other…"}
              </button>
            </div>
          )}

          {/* Free text — shown when "Other" selected or no options */}
          {(q.options.length === 0 || (answers[qi] && !q.options.includes(answers[qi]))) && (
            <input
              type="text"
              placeholder={isChinese ? "请输入..." : "Type your answer..."}
              value={answers[qi]?.replace(/^other:/, "") ?? ""}
              onChange={(e) => onAnswerChange(qi, e.target.value || "other:")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && allAnswered) onSubmit();
              }}
              style={{
                width: "100%",
                background: "#161b22",
                border: "1px solid #30363d",
                borderRadius: 6,
                color: "#c9d1d9",
                fontSize: 12,
                padding: "6px 10px",
                fontFamily: "inherit",
                outline: "none",
              }}
              // biome-ignore lint/a11y/noAutofocus: intentional focus for UX
              autoFocus={qi === 0}
            />
          )}
        </div>
      ))}

      {/* Submit button — enabled when all answered */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!allAnswered}
        style={{
          marginTop: 4,
          padding: "7px 16px",
          borderRadius: 6,
          border: "none",
          background: allAnswered ? "#1f6feb" : "#21262d",
          color: allAnswered ? "#fff" : theme.textMuted,
          fontSize: 12,
          fontWeight: 700,
          cursor: allAnswered ? "pointer" : "default",
          fontFamily: "inherit",
          transition: "background 0.15s",
        }}
      >
        {isChinese ? "确认并运行 ▶" : "Submit & Run ▶"}
      </button>
    </div>
  );
}
