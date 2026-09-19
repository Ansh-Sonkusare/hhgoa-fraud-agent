"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, ShieldCheck, Table2 } from "lucide-react";

const NAV = [
  { href: "/", label: "Case queue", icon: Table2 },
  { href: "/approvals", label: "Approvals inbox", icon: Inbox },
];

export function AppHeader() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2.5 font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-white">
            <ShieldCheck size={16} />
          </span>
          <span>
            HHGOA <span className="text-slate-400">Fraud Investigation</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {NAV.map(({ href, label, icon: Icon }) => {
            const isActive = active(href);
            return (
              <Link
                key={href}
                href={href}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors ${
                  isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon size={15} />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}