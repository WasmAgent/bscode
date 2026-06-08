import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BSCode — AI Coding Assistant",
  description: "Coding assistant powered by agentkit-js on Cloudflare",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
