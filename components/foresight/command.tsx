"use client";
// Underground now: who is down, who is overdue, and the actions to take.
// Concerns, responses and scenarios live in their own sections; this page
// only links to them when something there needs attention.
import { ArrowRight, ShieldCheck, FileText, ShieldAlert } from "lucide-react";
import type { ViewProps } from "./shared";
import { UndergroundNow } from "./underground";
import { concernCounts } from "./concerns";
export function CommandCentre(props: ViewProps) {
  const { data, zone } = props;
  const counts = concernCounts(data, zone);
  const elsewhere = [
    counts.concerns > 0 && {
      href: "#concerns?tab=queue",
      Icon: ShieldCheck,
      text: `${counts.concerns} concern${counts.concerns === 1 ? "" : "s"} to review`,
    },
    counts.reports > 0 && {
      href: "#concerns?tab=reports",
      Icon: FileText,
      text: `${counts.reports} report${counts.reports === 1 ? "" : "s"} to check`,
    },
    counts.responses > 0 && {
      href: "#concerns?tab=responses",
      Icon: ShieldAlert,
      text: `${counts.responses} response${counts.responses === 1 ? "" : "s"} open`,
    },
  ].filter(Boolean) as { href: string; Icon: typeof ShieldCheck; text: string }[];
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <h1>Underground now</h1>
          <p>
            Who is declared underground, who is overdue, and what to do about
            it.
          </p>
        </div>
      </div>
      {elsewhere.length > 0 && (
        <nav className="fs-elsewhere" aria-label="Needs attention in other sections">
          <span>Also needs attention:</span>
          {elsewhere.map((e) => (
            <a key={e.href} href={e.href}>
              <e.Icon size={15} aria-hidden /> {e.text} <ArrowRight size={14} aria-hidden />
            </a>
          ))}
        </nav>
      )}
      <UndergroundNow {...props} />
    </>
  );
}
