export default function LeaderboardPage() {
  const rows = [
    { rank: 1, model: "WasmAgent-PCL", passRate: "87%", tasksPassed: "26/30", date: "2026-06-26" },
    { rank: 2, model: "WasmAgent-Base", passRate: "73%", tasksPassed: "22/30", date: "2026-06-26" },
    { rank: 3, model: "Baseline-GPT4o", passRate: "60%", tasksPassed: "18/30", date: "2026-06-26" },
  ];

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#0d1117",
        color: "#c9d1d9",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        <h1
          style={{
            fontSize: "2rem",
            fontWeight: 700,
            color: "#58a6ff",
            marginBottom: "12px",
          }}
        >
          bscode-bench-v0 Leaderboard
        </h1>

        <p
          style={{
            fontSize: "1rem",
            color: "#8b949e",
            marginBottom: "40px",
          }}
        >
          Benchmark results for WasmAgent tool-calling, policy, and security tasks
        </p>

        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginBottom: "32px",
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "1px solid #30363d",
              }}
            >
              {["Rank", "Model", "Pass Rate", "Tasks Passed", "Date"].map((col) => (
                <th
                  key={col}
                  style={{
                    textAlign: "left",
                    padding: "12px 16px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#8b949e",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.rank}
                style={{
                  borderBottom: "1px solid #30363d",
                }}
              >
                <td style={{ padding: "14px 16px", fontWeight: 600, color: "#58a6ff" }}>
                  {row.rank}
                </td>
                <td style={{ padding: "14px 16px", fontWeight: 500 }}>{row.model}</td>
                <td style={{ padding: "14px 16px", color: "#3fb950", fontWeight: 600 }}>
                  {row.passRate}
                </td>
                <td style={{ padding: "14px 16px" }}>{row.tasksPassed}</td>
                <td style={{ padding: "14px 16px", color: "#8b949e" }}>{row.date}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p
          style={{
            fontSize: "0.9rem",
            color: "#8b949e",
            borderLeft: "3px solid #30363d",
            paddingLeft: "16px",
            marginBottom: "32px",
          }}
        >
          Submit your results by opening a PR with your AEP evidence bundle.
        </p>

        <a
          href="/"
          style={{
            color: "#58a6ff",
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          &larr; Back to home
        </a>
      </div>
    </main>
  );
}
