import React, { useMemo, useState } from "react";
import { StockItem, Company, UserRole } from "../types";
import { compareTireSize, formatBRL, matchesTireSize, parsePriceInput } from "../utils";
import {
  Search,
  SlidersHorizontal,
  X,
  Check,
  Loader2,
  AlertTriangle,
  Download,
  RotateCcw,
  Building2,
  Percent,
  Coins,
  TrendingDown,
  Pencil
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// CUSTO vs À VISTA vs A PRAZO
//
// As três pontas do mesmo pneu viviam em telas diferentes: o custo na ficha do
// produto, os dois preços de venda na planilha unificada. Comparar exigia abrir
// as duas e fazer a conta de cabeça, pneu por pneu — e é justamente a conta que
// diz se a loja está ganhando dinheiro em cada item.
//
// Aqui as três ficam na mesma linha, com o lucro já calculado ao lado de cada
// preço de venda, e o custo é editável no lugar: quem descobre a margem errada
// corrige na mesma tela onde descobriu, sem navegar para outra aba.
//
// Só abre para quem responde pela loja (dono ou administrador) — custo não é
// assunto do vendedor, que nem enxerga esta aba.
// ─────────────────────────────────────────────────────────────────

interface PriceComparisonProps {
  // Já chega no escopo de quem está logado: o dono recebe só a própria loja,
  // o administrador recebe todas (ver `ownScopedStock` em App.tsx).
  items: StockItem[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  isAdmin: boolean;
  onUpdateItem: (
    itemId: string,
    updatedFields: Partial<StockItem>,
    movementReason: string,
    quantityDiff?: number,
    extraMovementFields?: Record<string, any>
  ) => Promise<void>;
}

type CostSituation = "ALL" | "SEM_CUSTO" | "COM_CUSTO";
type MarginFilter = "ALL" | "PREJUIZO" | "ABAIXO" | "ACIMA";
type SortKey =
  | "MEDIDA"
  | "SKU"
  | "MARCA"
  | "MARGEM_ASC"
  | "MARGEM_DESC"
  | "CUSTO_DESC"
  | "CUSTO_ASC"
  | "PARADO_DESC";

// Preço de venda efetivo. Os documentos antigos só têm o campo legado `price`,
// então ler `priceCash` cru mostraria zero num pneu que tem preço.
const cashOf = (i: StockItem) => Number(i.priceCash) || Number(i.price) || 0;
const instOf = (i: StockItem) => Number(i.priceInstallment) || cashOf(i);
const costOf = (i: StockItem) => Number(i.costPrice) || 0;

// Margem sobre o PREÇO DE VENDA — é a leitura que o comércio usa ("margem de
// 30%" significa que 30% do que o cliente paga sobra). Devolve null quando não
// há custo informado: sem custo não existe margem, e mostrar 0% ou 100% ali
// seria inventar um número que ninguém digitou.
function marginPct(sale: number, cost: number): number | null {
  if (!(cost > 0) || !(sale > 0)) return null;
  return ((sale - cost) / sale) * 100;
}

// ─────────────────────────────────────────────────────────────────
// As células ficam FORA do componente de propósito.
//
// Declaradas dentro dele, elas viravam um tipo novo a cada render — e como o
// render acontece a cada tecla digitada no custo, o React desmontava e remontava
// o <input>, que perdia o foco letra por letra. Aqui o tipo é estável e o campo
// sobrevive à digitação.
// ─────────────────────────────────────────────────────────────────

// Preço de venda com o lucro logo abaixo: é a comparação que a tela existe para
// fazer, então os dois números ficam grudados em vez de o lucro virar mais uma
// coluna distante.
function SaleCell({
  sale,
  cost,
  accent,
  threshold
}: {
  sale: number;
  cost: number;
  accent: "cash" | "inst";
  threshold: number;
}) {
  const m = marginPct(sale, cost);
  const profit = cost > 0 ? sale - cost : null;
  const negative = profit !== null && profit < 0;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`font-black text-xs ${accent === "cash" ? "text-emerald-700" : "text-slate-900"}`}>
        {sale > 0 ? formatBRL(sale) : <span className="text-slate-300 font-normal">—</span>}
      </span>
      {m === null ? (
        <span className="text-[9px] font-bold text-slate-300 uppercase tracking-wider">sem custo</span>
      ) : (
        <span
          className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${
            negative
              ? "bg-red-50 text-red-700 border-red-200"
              : m < threshold
              ? "bg-amber-50 text-amber-800 border-amber-200"
              : "bg-emerald-50 text-emerald-700 border-emerald-200"
          }`}
          title={`Lucro por unidade: ${formatBRL(profit as number)}`}
        >
          {formatBRL(profit as number)} · {m.toFixed(1).replace(".", ",")}%
        </span>
      )}
    </div>
  );
}

function CostCell({
  cost,
  editable,
  isEditing,
  isSaving,
  justSaved,
  value,
  onStart,
  onChange,
  onCommit,
  onCancel,
  onKeyDown
}: {
  cost: number;
  editable: boolean;
  isEditing: boolean;
  isSaving: boolean;
  justSaved: boolean;
  value: string;
  onStart: () => void;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-1 justify-end">
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          value={value}
          placeholder="Em branco = sem custo"
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isSaving}
          className="w-28 px-2 py-1 border border-amber-400 rounded text-xs font-bold text-right outline-none focus:ring-2 focus:ring-amber-500/30 bg-white text-amber-900"
        />
        <button
          type="button"
          onClick={onCommit}
          disabled={isSaving}
          title="Gravar (Enter)"
          className="p-1 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 cursor-pointer"
        >
          {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          title="Cancelar (Esc)"
          className="p-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onStart}
      disabled={!editable}
      title={editable ? "Clique para alterar o preço de custo" : "Este pneu é de outra loja — só o dono dela altera o custo."}
      className={`w-full flex items-center justify-end gap-1.5 px-2 py-1 rounded transition-colors ${
        editable ? "cursor-pointer hover:bg-amber-50 hover:ring-1 hover:ring-amber-200" : "cursor-not-allowed opacity-70"
      }`}
    >
      {justSaved && <Check size={11} className="text-emerald-600 shrink-0" />}
      {cost > 0 ? (
        <span className="font-black text-xs text-amber-700">{formatBRL(cost)}</span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
          <AlertTriangle size={9} /> informar
        </span>
      )}
      {editable && <Pencil size={10} className="text-slate-300 shrink-0" />}
    </button>
  );
}

export default function PriceComparison({
  items,
  companies,
  user,
  isAdmin,
  onUpdateItem
}: PriceComparisonProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // ── Filtro específico ──────────────────────────────────────────
  const [companyFilter, setCompanyFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [costSituation, setCostSituation] = useState<CostSituation>("ALL");
  const [marginFilter, setMarginFilter] = useState<MarginFilter>("ALL");
  // Régua da margem: o que é "baixa" muda de loja para loja, então é a pessoa
  // que diz o número em vez de o sistema decidir por ela.
  const [marginThreshold, setMarginThreshold] = useState("20");
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [priceFrom, setPriceFrom] = useState("");
  const [priceTo, setPriceTo] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("MEDIDA");

  // ── Edição do custo na própria linha ───────────────────────────
  const [editingId, setEditingId] = useState("");
  const [editValue, setEditValue] = useState("");
  const [savingId, setSavingId] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [savedId, setSavedId] = useState("");

  // Quais lojas esta pessoa pode alterar. O dono só mexe na dele mesmo que o
  // administrador tenha aberto a lista para ele por engano.
  const canEditItem = (item: StockItem) =>
    isAdmin || (!!user.companyId && item.companyId === user.companyId);

  // A coluna Empresa e o filtro de empresa só fazem sentido para quem enxerga
  // mais de uma loja — para o dono de uma filial só, seria uma coluna com o
  // mesmo nome repetido em todas as linhas.
  const visibleCompanyIds = useMemo(
    () => Array.from(new Set(items.map(i => i.companyId).filter(Boolean))) as string[],
    [items]
  );
  const showCompanyColumn = visibleCompanyIds.length > 1;

  const brandOptions = useMemo(
    () => Array.from(new Set(items.map(i => i.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [items]
  );
  const sizeOptions = useMemo(
    () => Array.from(new Set(items.map(i => i.size).filter(Boolean))).sort(compareTireSize),
    [items]
  );

  const thresholdValue = useMemo(() => {
    const n = parseFloat((marginThreshold || "").replace(",", "."));
    return Number.isFinite(n) ? n : 20;
  }, [marginThreshold]);

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const from = parsePriceInput(priceFrom);
    const to = parsePriceInput(priceTo);

    const rows = items.filter(item => {
      if (term) {
        const hit =
          item.sku.toLowerCase().includes(term) ||
          item.brand.toLowerCase().includes(term) ||
          item.model.toLowerCase().includes(term) ||
          item.size.toLowerCase().includes(term) ||
          (item.companyName || "").toLowerCase().includes(term) ||
          matchesTireSize(item.size, term);
        if (!hit) return false;
      }

      if (companyFilter && item.companyId !== companyFilter) return false;
      if (brandFilter && item.brand !== brandFilter) return false;
      if (sizeFilter && item.size !== sizeFilter) return false;
      if (onlyInStock && !(Number(item.quantity) > 0)) return false;

      const cost = costOf(item);
      if (costSituation === "SEM_CUSTO" && cost > 0) return false;
      if (costSituation === "COM_CUSTO" && !(cost > 0)) return false;

      const cash = cashOf(item);
      if (from !== null && cash < from) return false;
      if (to !== null && cash > to) return false;

      if (marginFilter !== "ALL") {
        const m = marginPct(cash, cost);
        // Sem custo não há margem para julgar: o pneu sai de qualquer filtro de
        // margem, senão ele apareceria como "prejuízo" só por estar incompleto.
        if (m === null) return false;
        if (marginFilter === "PREJUIZO" && m >= 0) return false;
        if (marginFilter === "ABAIXO" && !(m >= 0 && m < thresholdValue)) return false;
        if (marginFilter === "ACIMA" && m < thresholdValue) return false;
      }

      return true;
    });

    const byMargin = (i: StockItem) => {
      const m = marginPct(cashOf(i), costOf(i));
      return m === null ? Infinity : m; // sem custo vai para o fim das duas ordens
    };

    const sorted = [...rows];
    switch (sortKey) {
      case "SKU":
        sorted.sort((a, b) => a.sku.localeCompare(b.sku));
        break;
      case "MARCA":
        sorted.sort((a, b) => a.brand.localeCompare(b.brand) || compareTireSize(a.size, b.size));
        break;
      case "MARGEM_ASC":
        sorted.sort((a, b) => byMargin(a) - byMargin(b));
        break;
      case "MARGEM_DESC":
        sorted.sort((a, b) => {
          const ma = byMargin(a);
          const mb = byMargin(b);
          if (ma === Infinity && mb === Infinity) return 0;
          if (ma === Infinity) return 1;
          if (mb === Infinity) return -1;
          return mb - ma;
        });
        break;
      case "CUSTO_DESC":
        sorted.sort((a, b) => costOf(b) - costOf(a));
        break;
      case "CUSTO_ASC":
        sorted.sort((a, b) => costOf(a) - costOf(b));
        break;
      case "PARADO_DESC":
        sorted.sort(
          (a, b) => costOf(b) * (Number(b.quantity) || 0) - costOf(a) * (Number(a.quantity) || 0)
        );
        break;
      default:
        sorted.sort(
          (a, b) =>
            compareTireSize(a.size, b.size) ||
            a.brand.localeCompare(b.brand) ||
            a.model.localeCompare(b.model)
        );
    }
    return sorted;
  }, [
    items,
    searchTerm,
    companyFilter,
    brandFilter,
    sizeFilter,
    costSituation,
    marginFilter,
    thresholdValue,
    onlyInStock,
    priceFrom,
    priceTo,
    sortKey
  ]);

  // ── Totais do que está na tela ─────────────────────────────────
  // Só o que TEM custo entra nas somas de dinheiro. Misturar o resto faria o
  // lucro potencial parecer maior do que é, que é o erro mais caro possível
  // numa tela de margem.
  const totals = useMemo(() => {
    let costSum = 0;
    let cashSum = 0;
    let units = 0;
    let withCost = 0;
    let negative = 0;

    for (const item of filtered) {
      const qty = Number(item.quantity) || 0;
      const cost = costOf(item);
      const cash = cashOf(item);
      units += qty;
      if (cost > 0) {
        withCost++;
        costSum += cost * qty;
        cashSum += cash * qty;
        if (cash > 0 && cash < cost) negative++;
      }
    }

    return {
      costSum,
      cashSum,
      profit: cashSum - costSum,
      avgMargin: cashSum > 0 ? ((cashSum - costSum) / cashSum) * 100 : null,
      units,
      withCost,
      withoutCost: filtered.length - withCost,
      negative
    };
  }, [filtered]);

  const activeFilterCount =
    (companyFilter ? 1 : 0) +
    (brandFilter ? 1 : 0) +
    (sizeFilter ? 1 : 0) +
    (costSituation !== "ALL" ? 1 : 0) +
    (marginFilter !== "ALL" ? 1 : 0) +
    (onlyInStock ? 1 : 0) +
    (priceFrom ? 1 : 0) +
    (priceTo ? 1 : 0);

  const clearFilters = () => {
    setCompanyFilter("");
    setBrandFilter("");
    setSizeFilter("");
    setCostSituation("ALL");
    setMarginFilter("ALL");
    setOnlyInStock(false);
    setPriceFrom("");
    setPriceTo("");
    setSearchTerm("");
  };

  // ── Gravar o custo ─────────────────────────────────────────────
  const startEdit = (item: StockItem) => {
    if (!canEditItem(item)) return;
    setErrorMsg("");
    setSavedId("");
    setEditingId(item.id);
    setEditValue(costOf(item) > 0 ? String(costOf(item)).replace(".", ",") : "");
  };

  const commitEdit = async (item: StockItem) => {
    const raw = editValue.trim();
    // Vazio apaga o custo de propósito (volta para "não informado"); texto
    // inválido é RECUSADO em vez de virar zero, que seria um custo errado
    // gravado sem ninguém perceber.
    const value = raw === "" ? 0 : parsePriceInput(raw);
    if (value === null) {
      setErrorMsg(`"${raw}" não é um valor válido. Use apenas números, com vírgula nos centavos (ex: 289,90).`);
      return;
    }
    if (value === costOf(item)) {
      setEditingId("");
      return;
    }

    setSavingId(item.id);
    setErrorMsg("");
    try {
      await onUpdateItem(item.id, { costPrice: value }, "Atualização do preço de custo", 0);
      setEditingId("");
      setSavedId(item.id);
      window.setTimeout(() => setSavedId(current => (current === item.id ? "" : current)), 2500);
    } catch (err: any) {
      setErrorMsg(err?.message || "Erro ao gravar o preço de custo.");
    } finally {
      setSavingId("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, item: StockItem) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(item);
    } else if (e.key === "Escape") {
      setEditingId("");
      setErrorMsg("");
    }
  };

  // Props da célula de custo de uma linha. As duas visões (tabela e cartão)
  // montam a mesma célula, então o cabo de ligação fica num lugar só.
  const costCellProps = (item: StockItem) => ({
    cost: costOf(item),
    editable: canEditItem(item),
    isEditing: editingId === item.id,
    isSaving: savingId === item.id,
    justSaved: savedId === item.id,
    value: editingId === item.id ? editValue : "",
    onStart: () => startEdit(item),
    onChange: setEditValue,
    onCommit: () => { commitEdit(item); },
    onCancel: () => { setEditingId(""); setErrorMsg(""); },
    onKeyDown: (e: React.KeyboardEvent) => handleKeyDown(e, item)
  });

  const exportCSV = () => {
    if (filtered.length === 0) return;
    const headers = [
      "SKU", "Marca", "Modelo", "Medida", "Empresa", "Quantidade",
      "Custo", "A Vista", "Lucro a Vista", "Margem a Vista (%)",
      "A Prazo", "Lucro a Prazo", "Margem a Prazo (%)"
    ];
    const rows = filtered.map(item => {
      const cost = costOf(item);
      const cash = cashOf(item);
      const inst = instOf(item);
      const mCash = marginPct(cash, cost);
      const mInst = marginPct(inst, cost);
      return [
        item.sku, item.brand, item.model, item.size,
        item.companyName || "", item.quantity,
        cost || "", cash || "",
        cost > 0 ? (cash - cost).toFixed(2) : "",
        mCash === null ? "" : mCash.toFixed(1),
        inst || "",
        cost > 0 ? (inst - cost).toFixed(2) : "",
        mInst === null ? "" : mInst.toFixed(1)
      ];
    });
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
      .join("\n");
    // BOM: sem ele o Excel abre o CSV como ANSI e os acentos viram lixo.
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `custo_vs_precos_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* ── Indicadores ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Custo do Estoque</span>
          <p className="text-lg font-black text-amber-700 tracking-tight mt-1">{formatBRL(totals.costSum)}</p>
          <span className="text-[10px] font-bold text-slate-400">{totals.units} un no filtro</span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Se Vender À Vista</span>
          <p className="text-lg font-black text-emerald-700 tracking-tight mt-1">{formatBRL(totals.cashSum)}</p>
          <span className="text-[10px] font-bold text-slate-400">só os pneus com custo</span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Lucro Potencial</span>
          <p className={`text-lg font-black tracking-tight mt-1 ${totals.profit < 0 ? "text-red-600" : "text-slate-900"}`}>
            {formatBRL(totals.profit)}
          </p>
          <span className="text-[10px] font-bold text-slate-400">
            margem média {totals.avgMargin === null ? "—" : `${totals.avgMargin.toFixed(1).replace(".", ",")}%`}
          </span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Pendências</span>
          <p className="text-lg font-black text-slate-900 tracking-tight mt-1">{totals.withoutCost}</p>
          <span className="text-[10px] font-bold text-slate-400">
            sem custo{totals.negative > 0 ? ` · ${totals.negative} abaixo do custo` : ""}
          </span>
        </div>
      </div>

      {/* ── Busca e filtros ──────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Buscar por SKU, marca, modelo ou medida (2056516, 205/65 R16...)"
              className="w-full pl-9 pr-9 py-2.5 text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowFilters(v => !v)}
            className={`flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-black border transition-all cursor-pointer ${
              showFilters || activeFilterCount > 0
                ? "bg-slate-900 text-gold-400 border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            <SlidersHorizontal size={14} /> Filtro específico
            {activeFilterCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                {activeFilterCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={exportCSV}
            disabled={filtered.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-all cursor-pointer"
          >
            <Download size={14} /> CSV
          </button>
        </div>

        {showFilters && (
          <div className="pt-3 border-t border-slate-100 space-y-3 animate-fadeIn">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {showCompanyColumn && (
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Empresa</label>
                  <select
                    value={companyFilter}
                    onChange={e => setCompanyFilter(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                  >
                    <option value="">Todas as lojas</option>
                    {companies
                      .filter(c => visibleCompanyIds.includes(c.id))
                      .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Marca</label>
                <select
                  value={brandFilter}
                  onChange={e => setBrandFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                >
                  <option value="">Todas</option>
                  {brandOptions.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Medida</label>
                <select
                  value={sizeFilter}
                  onChange={e => setSizeFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                >
                  <option value="">Todas</option>
                  {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Situação do custo</label>
                <select
                  value={costSituation}
                  onChange={e => setCostSituation(e.target.value as CostSituation)}
                  className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                >
                  <option value="ALL">Todos os pneus</option>
                  <option value="SEM_CUSTO">Só os sem custo informado</option>
                  <option value="COM_CUSTO">Só os com custo</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Margem à vista</label>
                <select
                  value={marginFilter}
                  onChange={e => setMarginFilter(e.target.value as MarginFilter)}
                  className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                >
                  <option value="ALL">Qualquer margem</option>
                  <option value="PREJUIZO">Vendendo abaixo do custo</option>
                  <option value="ABAIXO">Abaixo da margem alvo</option>
                  <option value="ACIMA">Na margem alvo ou acima</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Margem alvo (%)
                </label>
                <div className="relative">
                  <Percent size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={marginThreshold}
                    onChange={e => setMarginThreshold(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Preço à vista de / até
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={priceFrom}
                    onChange={e => setPriceFrom(e.target.value)}
                    placeholder="mín."
                    className="w-full px-2.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={priceTo}
                    onChange={e => setPriceTo(e.target.value)}
                    placeholder="máx."
                    className="w-full px-2.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Ordenar por</label>
                <select
                  value={sortKey}
                  onChange={e => setSortKey(e.target.value as SortKey)}
                  className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
                >
                  <option value="MEDIDA">Medida (crescente)</option>
                  <option value="SKU">SKU</option>
                  <option value="MARCA">Marca</option>
                  <option value="MARGEM_ASC">Menor margem primeiro</option>
                  <option value="MARGEM_DESC">Maior margem primeiro</option>
                  <option value="CUSTO_DESC">Custo mais alto</option>
                  <option value="CUSTO_ASC">Custo mais baixo</option>
                  <option value="PARADO_DESC">Mais dinheiro parado</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyInStock}
                  onChange={e => setOnlyInStock(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900 cursor-pointer"
                />
                Só pneus com saldo em estoque
              </label>
              <button
                type="button"
                onClick={clearFilters}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border border-slate-200 text-slate-500 hover:bg-slate-50 transition-all cursor-pointer"
              >
                <RotateCcw size={12} /> Limpar tudo
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-slate-500">
          <span>
            {filtered.length} {filtered.length === 1 ? "pneu" : "pneus"}
            {filtered.length !== items.length && <span className="text-slate-400"> de {items.length}</span>}
          </span>
          {totals.negative > 0 && (
            <span className="inline-flex items-center gap-1 text-red-700">
              <TrendingDown size={12} /> {totals.negative} vendendo abaixo do custo
            </span>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold p-3 rounded-xl">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* ── Tabela ───────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200/70 py-16 text-center">
          <Coins size={30} className="mx-auto text-slate-300 mb-3" />
          <h3 className="text-sm font-black text-slate-700">Nenhum pneu neste filtro</h3>
          <p className="text-xs text-slate-500 font-semibold mt-1">
            {items.length === 0
              ? "Cadastre produtos para comparar custo e preços de venda."
              : "Ajuste a busca ou limpe o filtro específico."}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-400 text-[10px] uppercase tracking-widest font-extrabold sticky top-0 z-10">
                  <tr>
                    <th className="py-3 px-3 border-b border-slate-100 w-[110px] font-black">ID / SKU</th>
                    <th className="py-3 px-3 border-b border-slate-100 font-black">Produto</th>
                    {showCompanyColumn && (
                      <th className="py-3 px-3 border-b border-slate-100 w-[130px] font-black">Empresa</th>
                    )}
                    <th className="py-3 px-3 border-b border-slate-100 w-[70px] text-center font-black">Qtd</th>
                    <th className="py-3 px-3 border-b border-slate-100 w-[150px] text-right font-black text-amber-600">Custo</th>
                    <th className="py-3 px-3 border-b border-slate-100 w-[135px] text-right font-black text-emerald-600">À Vista</th>
                    <th className="py-3 px-3 border-b border-slate-100 w-[135px] text-right font-black">A Prazo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(item => {
                    const cost = costOf(item);
                    return (
                      <tr key={item.id} className="hover:bg-slate-50/60 transition-colors">
                        <td className="py-2.5 px-3 align-middle">
                          <span className="inline-block px-2 py-0.5 text-gold-700 bg-gold-400/10 rounded-lg border border-gold-500/20 font-mono tracking-wider text-[11px] font-extrabold uppercase">
                            {item.sku}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 align-middle">
                          <span className="font-bold text-slate-900 uppercase text-xs">
                            <span className="text-gold-600 font-extrabold mr-1.5">{item.size}</span>
                            {item.brand} <span className="font-normal text-slate-500">{item.model}</span>
                          </span>
                        </td>
                        {showCompanyColumn && (
                          <td className="py-2.5 px-3 align-middle">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[9px] font-black bg-[#1e1a12] text-gold-400 border border-gold-500/30 uppercase tracking-wider leading-none max-w-full truncate">
                              <Building2 size={9} className="shrink-0" />
                              <span className="truncate">{item.companyName || "—"}</span>
                            </span>
                          </td>
                        )}
                        <td className="py-2.5 px-3 text-center align-middle">
                          <span className="text-xs font-bold text-slate-700">{item.quantity}</span>
                        </td>
                        <td className="py-2.5 px-3 align-middle">
                          <CostCell {...costCellProps(item)} />
                        </td>
                        <td className="py-2.5 px-3 align-middle">
                          <SaleCell sale={cashOf(item)} cost={cost} accent="cash" threshold={thresholdValue} />
                        </td>
                        <td className="py-2.5 px-3 align-middle">
                          <SaleCell sale={instOf(item)} cost={cost} accent="inst" threshold={thresholdValue} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Celular */}
          <div className="md:hidden space-y-2.5">
            {filtered.map(item => {
              const cost = costOf(item);
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-slate-200/70 p-3.5 space-y-3 shadow-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-bold text-slate-900 uppercase text-xs block">
                        <span className="text-gold-600 font-extrabold mr-1">{item.size}</span>
                        {item.brand}
                      </span>
                      <span className="text-[11px] text-slate-500 font-semibold block truncate">{item.model}</span>
                      <span className="inline-block mt-1 px-1.5 py-0.5 text-gold-700 bg-gold-400/10 rounded border border-gold-500/20 font-mono text-[9px] font-extrabold uppercase">
                        {item.sku}
                      </span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider block">Qtd</span>
                      <span className="text-sm font-black text-slate-800">{item.quantity}</span>
                    </div>
                  </div>

                  {showCompanyColumn && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[9px] font-black bg-[#1e1a12] text-gold-400 border border-gold-500/30 uppercase tracking-wider">
                      <Building2 size={9} /> {item.companyName || "—"}
                    </span>
                  )}

                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
                    <div>
                      <span className="text-[9px] font-black text-amber-600 uppercase tracking-wider block mb-1">Custo</span>
                      <CostCell {...costCellProps(item)} />
                    </div>
                    <div>
                      <span className="text-[9px] font-black text-emerald-600 uppercase tracking-wider block mb-1">À Vista</span>
                      <SaleCell sale={cashOf(item)} cost={cost} accent="cash" threshold={thresholdValue} />
                    </div>
                    <div>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider block mb-1">A Prazo</span>
                      <SaleCell sale={instOf(item)} cost={cost} accent="inst" threshold={thresholdValue} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
