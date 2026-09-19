import type { Metadata } from "next";
import "./globals.css";
import { AppHeader } from "../components/AppHeader";

export const metadata: Metadata = {
  title: "HHGOA Fraud Investigation",
  description: "Agentic fraud investigation — case queue, live investigation, verdicts, approvals.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col">
          <AppHeader />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
          <footer className="mx-auto w-full max-w-7xl px-4 pb-6 text-xs text-slate-400">
            HHGOA — agentic fraud investigation · TigerGraph Hacker House Goa
          </footer>
        </div>
      </body>
    </html>
  );
}