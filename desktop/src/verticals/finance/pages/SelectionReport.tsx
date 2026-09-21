import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Loader2, Save, Search, XCircle } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { backend, type Evidence, type PageResult } from "@/lib/backend";
import { addNote } from "@/lib/notes";
import { storageGet, storageSet } from "@/lib/storage";
import { useAiPage } from "../../../core/ai/pageContext";

type CalcDisplay = { status: string; value: number | null; unit: string; display?: string | null };
type AffordabilityRow = {
  symbol: string;
  name: string;
  evidence_id: string;
  price: number;
  minimum_shares: number;
  minimum_amount_yuan: number;
  capital_ratio: number;
  affordable: boolean;
  minimum_amount?: CalcDisplay;
  capital_share?: CalcDisplay;
};
type Candidate = AffordabilityRow & {
  reason: string;
  reasonEvidenceId: string;
  priceEvidenceId: string;
  changePct: number | null;
  changeEvidenceId: string | null;
  boardLabel: string;
};
type Decision = "watch" | "drop" | "";

const evidenceOf = (page: PageResult, blockId: string): Evidence[] => {
  const block = page.blocks.find((item) => item.id === blockId);
  return Array.isArray(block?.envelope?.evidence) ? block.envelope.evidence as Evidence[] : [];
};

function nameFromNote(note: string | undefined, symbol: string): string {
  const rest = String(note ?? "").replace(new RegExp(`^${symbol}\\s*`), "");
  return rest.split(/\s+(?:涨幅|换手|成交额)\s/)[0]?.trim() || symbol;
}

function minimumRule(symbol: string): { shares: number; label: string } {
  if (/^(?:688|689)/.test(symbol)) return { shares: 200, label: "上交所科创板最低 200 股" };
  return { shares: 100, label: "沪深北股票最低 100 股" };
}

function buildStockInputs(page: PageResult) {
  const facts = evidenceOf(page, "reason");
  const byCode = new Map<string, { symbol: string; name: string; reason?: Evidence; price?: Evidence; change?: Evidence }>();
  for (const ev of facts) {
    const symbol = String(ev.record_key ?? "").trim();
    if (!/^\d{6}$/.test(symbol)) continue;
    const row = byCode.get(symbol) ?? { symbol, name: nameFromNote(ev.note, symbol) };
    if (ev.field === "strong_stock_reason" && !row.reason) row.reason = ev;
    if (ev.field === "strong_stock_close" && !row.price) row.price = ev;
    if (ev.field === "strong_stock_change_pct" && !row.change) row.change = ev;
    byCode.set(symbol, row);
  }
  const rows = [...byCode.values()].filter((row) => row.reason);
  const calculable = rows.filter((row) => typeof row.price?.value === "number" && Number.isFinite(row.price.value) && row.price.value > 0);
  return {
    rows,
    missingPrice: rows.length - calculable.length,
    calculable,
    inputs: calculable.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      price: row.price!.value,
      minimum_shares: minimumRule(row.symbol).shares,
      evidence_id: row.price!.id,
    })),
  };
}

function sentimentLines(page: PageResult | null): string[] {
  if (!page) return [];
  const labels: Record<string, string> = { limit_up_count: "涨停", break_board_count: "炸板", limit_down_count: "跌停" };
  return evidenceOf(page, "sentiment")
    .filter((ev) => labels[ev.field] && typeof ev.value === "number")
    .map((ev) => `${labels[ev.field]} ${ev.value} ${ev.unit} [${ev.id}]`);
}

export function SelectionReport() {
  const [principal, setPrincipal] = useState(() => storageGet("vr-selection-principal") ?? "10000");
  const [date, setDate] = useState("");
  const [page, setPage] = useState<PageResult | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [tooExpensive, setTooExpensive] = useState(0);
  const [missingPrice, setMissingPrice] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const bizDate = page?.context.review_date ?? "";
  const mood = useMemo(() => sentimentLines(page), [page]);
  const gaps = useMemo(() => page?.blocks.filter((block) => block.status === "missing" || block.status === "failed") ?? [], [page]);

  const reportText = useMemo(() => {
    if (!page) return "";
    const lines = [
      `# 选股初筛报告 · ${bizDate || "业务日未知"}`,
      "",
      `- 模拟本金：${principal} 元（用户填写）`,
      `- 候选范围：A 股；先按最低买入金额做硬筛选，再按线索源返回顺序保留前 5 只`,
      `- 计算口径：收盘价 × 交易所最低申报数量；不含佣金、过户费等交易费用`,
      `- 定位：候选是后续核对线索，不是买入建议`,
      "",
      "## 当日市场情绪",
      "",
      ...(mood.length ? mood.map((line) => `- ${line}`) : ["- 情绪数据未获取"]),
      "- 本版趋势先展示涨停、炸板、跌停数量和候选个股当日涨跌幅；所选日期的大盘指数涨跌尚未接入。",
      "",
      "## 本金筛选结果",
      "",
      "| 股票 | 当日线索 | 收盘价 | 最低申报 | 最低买入金额 | 占模拟本金 | 我的决定 |",
      "|---|---|---:|---:|---:|---:|---|",
      ...candidates.map((c) => {
        const personalNote = notes[c.symbol] ?? "";
        const dailyMove = c.changePct === null ? "未获取" : `${c.changePct}%${c.changeEvidenceId ? ` [${c.changeEvidenceId}]` : ""}`;
        return `| ${c.name} ${c.symbol} | ${c.reason.replace(/\|/g, "／")} [${c.reasonEvidenceId}]；当日涨跌幅 ${dailyMove} | ${c.price} 元 [${c.priceEvidenceId}] | ${c.minimum_shares} 股 | ${c.minimum_amount?.display ?? "未计算"} | ${c.capital_share?.display ?? "未计算"} | ${decisions[c.symbol] === "watch" ? "继续核对" : decisions[c.symbol] === "drop" ? "暂不关注" : "待决定"}${personalNote ? `：${personalNote.replace(/\|/g, "／")}` : ""} |`;
      }),
      "",
      "## 仍需核对",
      "",
      "- 强势原因来自市场题材归因，只能解释它为什么进入线索池，不能证明公司基本面已经改善。",
      "- 每只候选仍需核对财务、估值、公告、产业位置、反证与下一次公开数据时点。",
      `- 因最低买入金额超过本金而排除 ${tooExpensive} 只；因缺少该日有效价格而排除 ${missingPrice} 只。`,
      ...gaps.map((block) => `- 数据缺口：${block.title}——${block.note ?? "本次未取得"}`),
      "",
      "本报告不提供任何投资动作建议（建仓 / 加减仓 / 目标价 / 止损位）。",
    ];
    return lines.join("\n");
  }, [page, bizDate, principal, mood, candidates, decisions, notes, tooExpensive, missingPrice, gaps]);

  useAiPage({
    key: "selection-report",
    title: "选股报告",
    context: reportText || "用户正在填写模拟本金和查看日期，准备生成 A 股选股初筛报告。",
    suggestions: ["帮我看懂这份初筛报告", "这五只下一步各要核对什么", "哪些证据还不够"],
  });

  async function generate() {
    const money = Number(principal);
    if (!Number.isFinite(money) || money <= 0) { setError("请填写大于 0 的模拟本金"); return; }
    setLoading(true); setError(""); setSaved(false); setCandidates([]); setDecisions({}); setNotes({});
    try {
      storageSet("vr-selection-principal", principal);
      const nextPage = await backend.page("review", {
        refresh: true,
        ...(date ? { contextArgs: { date } } : {}),
      });
      const reasonBlock = nextPage.blocks.find((block) => block.id === "reason");
      if (!reasonBlock || (reasonBlock.status !== "ok" && reasonBlock.status !== "partial")) {
        throw new Error(`${nextPage.context.review_date ?? (date || "所选日期")} 的个股线索没有取到`);
      }
      const stocks = buildStockInputs(nextPage);
      if (!stocks.inputs.length) throw new Error("当日线索没有可核对的收盘价，无法执行本金筛选");
      const calc = await backend.runTool<{
        ok: boolean;
        error?: string;
        result?: { status: string; reason?: string; details?: { results?: AffordabilityRow[] } };
      }>("calc", { fn: "minimum_purchase_batch", args: { items: stocks.inputs, principal: money, principal_unit: "元" } });
      if (!calc.ok || calc.result?.status !== "ok") throw new Error(calc.error || calc.result?.reason || "本金筛选计算失败");
      const calcRows = calc.result.details?.results ?? [];
      const original = new Map(stocks.calculable.map((row) => [row.symbol, row]));
      const affordable = calcRows.filter((row) => row.affordable).slice(0, 5).map((row): Candidate => {
        const source = original.get(row.symbol)!;
        return {
          ...row,
          reason: String(source.reason!.value ?? ""),
          reasonEvidenceId: source.reason!.id,
          priceEvidenceId: source.price!.id,
          changePct: typeof source.change?.value === "number" ? source.change.value : null,
          changeEvidenceId: source.change?.id ?? null,
          boardLabel: minimumRule(row.symbol).label,
        };
      });
      setPage(nextPage);
      setCandidates(affordable);
      setTooExpensive(calcRows.filter((row) => !row.affordable).length);
      setMissingPrice(stocks.missingPrice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!reportText) return;
    setSaving(true); setError("");
    try {
      await addNote("选股报告", `选股初筛 · ${bizDate}`, reportText);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="选股报告" subtitle="填模拟本金和查看日期，先排除买不起的股票，再留下最多五只值得继续核对的 A 股线索。" />

      <GlassCard className="mb-5">
        <div className="grid gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto] md:items-end">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">模拟本金（元）</span>
            <input type="number" min="1" step="1" value={principal} onChange={(event) => setPrincipal(event.target.value)}
              className="w-full rounded-lg border border-border bg-background/70 px-3 py-2.5 outline-none focus:border-primary/60" />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">查看日期</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)}
              className="w-full rounded-lg border border-border bg-background/70 px-3 py-2.5 outline-none focus:border-primary/60" />
            <span className="mt-1 block text-xs text-muted-foreground">留空时自动使用最近已收盘交易日</span>
          </label>
          <button onClick={generate} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {loading ? "正在取数和筛选…" : "生成报告"}
          </button>
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">最低买入金额是硬门槛。超过本金或缺少所选日期价格的股票不会进入五只候选；计算暂不含交易费用。</p>
      </GlassCard>

      {error && <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

      {page && (
        <>
          <GlassCard className="mb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">报告业务日</p>
                <p className="mt-1 text-xl font-bold">{bizDate}</p>
                <p className="mt-1 text-xs text-muted-foreground">{page.context.review_reason}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {mood.map((line) => <span key={line} className="rounded-full border border-border bg-muted/40 px-3 py-1.5">{line.replace(/\s\[ev-[^\]]+\]$/, "")}</span>)}
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">本版趋势先看涨停、炸板、跌停数量和候选个股当日涨跌幅；所选日期的大盘指数涨跌尚未接入。</p>
            {gaps.length > 0 && <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">{gaps.map((block) => <p key={block.id}>数据缺口：{block.title}。{block.id === "board_flow" ? "该日没有当时归档，今天的数据未被拿来替代。" : "本次未取得。"}</p>)}</div>}
          </GlassCard>

          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">本金范围内的候选</h2>
              <p className="mt-1 text-sm text-muted-foreground">共显示 {candidates.length} 只；按线索源返回顺序保留，不是投资排名。</p>
            </div>
            <button onClick={save} disabled={saving || !candidates.length} className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saved ? "已保存到研究记录" : "保存报告"}
            </button>
          </div>

          {candidates.length === 0 ? (
            <GlassCard className="mb-5"><p className="text-sm text-muted-foreground">这一天没有找到既有有效价格、又符合当前本金的候选。系统不会为了凑满五只放宽本金门槛。</p></GlassCard>
          ) : (
            <div className="mb-5 grid gap-4 xl:grid-cols-2">
              {candidates.map((candidate, index) => (
                <GlassCard key={candidate.symbol} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-primary">候选 {index + 1}</p>
                      <h3 className="mt-1 text-lg font-bold">{candidate.name} <span className="font-mono text-sm text-muted-foreground">{candidate.symbol}</span></h3>
                    </div>
                    <Link to={`/research?symbol=${candidate.symbol}`} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-primary/50 hover:text-primary">继续查基本面</Link>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-muted/30 p-3"><p className="text-xs text-muted-foreground">该日收盘价</p><p className="mt-1 font-mono font-semibold">{candidate.price} 元</p><p className="mt-1 text-xs text-muted-foreground">当日涨跌幅 {candidate.changePct === null ? "未获取" : `${candidate.changePct}%`}</p><p className="mt-1 break-all text-[10px] text-muted-foreground">价格证据 {candidate.priceEvidenceId}{candidate.changeEvidenceId ? ` · 涨跌幅证据 ${candidate.changeEvidenceId}` : ""}</p></div>
                    <div className="rounded-lg bg-muted/30 p-3"><p className="text-xs text-muted-foreground">最低买入金额</p><p className="mt-1 font-mono font-semibold">{candidate.minimum_amount?.display ?? "未计算"}</p><p className="mt-1 text-[10px] text-muted-foreground">{candidate.boardLabel} · 本金占比 {candidate.capital_share?.display ?? "未计算"}</p></div>
                  </div>

                  <div className="mt-3 rounded-lg border border-border/70 p-3">
                    <p className="text-xs font-semibold">为什么进入线索池</p>
                    <p className="mt-1 text-sm leading-6">{candidate.reason}</p>
                    <p className="mt-1 break-all text-[10px] text-muted-foreground">市场归因证据 {candidate.reasonEvidenceId}，尚未核实为公司基本面事实</p>
                  </div>

                  <div className="mt-3">
                    <p className="mb-2 text-xs font-semibold">你的初步决定</p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setDecisions((old) => ({ ...old, [candidate.symbol]: "watch" }))} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${decisions[candidate.symbol] === "watch" ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground"}`}><CheckCircle2 className="h-3.5 w-3.5" />继续核对</button>
                      <button onClick={() => setDecisions((old) => ({ ...old, [candidate.symbol]: "drop" }))} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${decisions[candidate.symbol] === "drop" ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-border text-muted-foreground"}`}><XCircle className="h-3.5 w-3.5" />暂不关注</button>
                    </div>
                    <textarea value={notes[candidate.symbol] ?? ""} onChange={(event) => setNotes((old) => ({ ...old, [candidate.symbol]: event.target.value.slice(0, 500) }))} placeholder="用自己的话记下原因，例如：看不懂业务，先不碰；或想继续查订单是否真实。" className="mt-2 min-h-20 w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary/50" />
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          <GlassCard className="mb-5 text-sm leading-6">
            <h2 className="font-semibold">这份初筛还没有回答什么</h2>
            <p className="mt-2 text-muted-foreground">它只确认三件事：所选日期确有市场线索、存在当日价格证据、最低买入金额不超过模拟本金。财务是否健康、估值是否合理、题材是否能兑现，都要进入个股研究继续核对。</p>
            <p className="mt-2 text-muted-foreground">本轮另有 {tooExpensive} 只因超过本金被排除，{missingPrice} 只因缺少有效价格被排除。候选不足五只时保持实际数量。</p>
          </GlassCard>
        </>
      )}
      <Disclaimer />
    </div>
  );
}
