/**
 * Custom 404. The Next.js default is a bare "404 — This page could not be
 * found.": clicking on a stale link drops the user there with no way back to
 * either app surface. A two-line page with two real links costs nothing and
 * makes /jobs and / actually navigable from a misfire.
 */
import Link from "next/link";
import { theme } from "@/lib/theme";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "ui-sans-serif, system-ui",
        color: theme.textSecondary,
      }}
    >
      <h1 style={{ fontSize: 24, margin: 0, color: theme.textPrimary }}>404</h1>
      <p style={{ margin: 0, fontSize: 14 }}>That page does not exist.</p>
      <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
        <Link href="/" style={{ color: theme.linkPrimary ?? "#58a6ff" }}>
          ← Home
        </Link>
        <Link href="/jobs" style={{ color: theme.linkPrimary ?? "#58a6ff" }}>
          Jobs dashboard →
        </Link>
      </div>
    </main>
  );
}
