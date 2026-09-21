import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { FinanceHomeAgent } from "@/components/ui/FinanceAiDock";
import { HOME_FEATURE_GROUPS } from "@/lib/homeFeatures";
import { SelectionReport } from "@/pages/SelectionReport";

export function Home() {
  return (
    <div>
      <h1 className="sr-only">Vibe Research 研究工作台</h1>
      <SelectionReport />
      <div className="mt-8" aria-labelledby="agent-heading">
        <div className="mb-3"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">看不懂就问</p><h2 id="agent-heading" className="mt-1 text-lg font-bold">让 Agent 用白话解释报告</h2></div>
        <FinanceHomeAgent />
      </div>
      <section><details id="home-features" className="mt-8 rounded-xl border border-border bg-muted/15 p-4">
        <summary id="feature-heading" className="cursor-pointer text-sm font-semibold">更多研究工具</summary>
        <p className="mt-2 text-xs text-muted-foreground">初筛之后需要继续查证时再打开这些入口。</p>
        <div data-feature-grid className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {HOME_FEATURE_GROUPS.map((group, index) => (
            <div key={group.title} data-feature-category className="glass min-w-0 rounded-xl border border-primary/20 p-3">
              <div className="mb-2 flex items-center gap-2 border-b border-primary/15 pb-2">
                <span className="text-[10px] font-medium text-primary">0{index + 1}</span>
                <h3 className="text-[13px] font-semibold">{group.title}</h3>
              </div>
              <div className="grid gap-1.5">
                {group.features.map(({ to, title, detail }) => (
                  <Link key={to} to={to} title={detail} className="group flex min-h-10 items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 transition-colors hover:border-primary/40 hover:bg-primary/[0.06]">
                    <span className="min-w-0 flex-1 text-xs font-medium group-hover:text-primary">{title}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details></section>
    </div>
  );
}
