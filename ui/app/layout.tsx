import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "HHGOA Fraud Investigation",
  description: "Agentic fraud investigation — case queue, live investigation, verdicts, approvals.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
              <Link href="/" className="font-semibold text-slate-900">
                HHGOA Fraud Investigation
              </Link>
              <nav className="flex gap-4 text-sm text-slate-600">
                <Link href="/" className="hover:text-slate-900">
                  Case queue
                </Link>
                <Link href="/approvals" className="hover:text-slate-900">
                  Approvals inbox
                </Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
