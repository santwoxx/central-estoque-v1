import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, orderBy, query, where, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import { MovementLog, StockItem, Company, UserRole } from "../types";
import {
  compareTireSize,
  formatBRL,
  formatDate,
  mapMovementDoc,
  matchesTireSize,
  toMillis
} from "../utils";
import {
  Search,
  X,
  Loader2,
  AlertTriangle,
  Download,
  RotateCcw,
  Building2,
  CalendarRange,
  TrendingUp,
  TrendingDown,
  Trophy,
  Ruler,
  PackageOpen,
  ArrowRight,
  Boxes
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// HISTÓRICO POR MEDIDA
//
// A pergunta que a loja faz para decidir compra é sempre a mesma: "quanto de
// 205/55R16 saiu no mês passado?". O estoque responde o que TEM, e a auditoria
// lista movimento por movimento, na ordem em que aconteceram — nenhum dos dois
// responde por MEDIDA, que é a unidade em que pneu é comprado.
//
// Esta tela agrupa a saída por medida dentro de um período, ordena pelo que mais
// saiu, compara com o período anterior e cruza com o saldo atual para dizer
// quantos meses de estoque cada medida ainda tem.
//
// ── Por que ela busca os próprios dados ──
// O App mantém em memória apenas os últimos 400 movimentos (MOVEMENTS_WINDOW),
// que numa loja movimentada não cobrem nem duas semanas. Um relatório mensal
// montado em cima daquela janela mostraria números menores que a realidade sem
// avisar ninguém. Aqui a consulta é por FAIXA DE DATA, direto no Firestore, e
// usa os mesmos índices que já existem (`companyId` + `timestamp`).
// ─────────────────────────────────────────────────────────────────

// Teto de segurança da consulta. Existe para o relatório nunca mentir em
// silêncio: ao bater no teto a tela avisa que o período foi cortado, em vez de
// apresentar um total incompleto como se fosse o total.
const FETCH_LIMIT = 4000;

interface SizeHistoryProps {
  // Saldo atual, para o cruzamento "quanto saiu x quanto ainda tem".
  stock: StockItem[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
}

type PeriodPreset = "THIS_MONTH" | "LAST_MONTH" | "L3M" | "L6M" | "L12M" | "THIS_YEAR" | "CUSTOM";
type ExitScope = "SAIDA" | "COM_TRANSFERENCIA";

const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => {
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[Number(m) - 1]?.slice(0, 3) || m}/${y.slice(2)}`;
};

// Um movimento de saída pode ter sido gravado com quantidade negativa (é o que
// o histórico faz) ou positiva, conforme a tela que gravou. O que interessa
// para o relatório é sempre o módulo.
const unitsOf = (m: MovementLog) => Math.abs(Number(m.quantity) || 0);

// Quanto de dinheiro aquele movimento representa. `totalAmount` só existe nas
// operações do módulo de Entradas e Saídas; sem ele o valor é desconhecido e
// vira 0 — nunca um chute a partir do preço de tabela, que mudaria o passado
// toda vez que alguém reajustasse a tabela hoje.
const amountOf = (m: MovementLog) => {
  const total = Number(m.totalAmount) || 0;
  if (total > 0) return total;
  const unit = Number(m.unitPrice) || 0;
  return unit > 0 ? unit * unitsOf(m) : 0;
};

// Motivo legível da saída, para o corte por "Venda / Garantia / Perda...".
// `operationReason` é o campo estruturado; o resto do histórico só tem o texto
// livre de `reason`, então ele entra como reserva.
const reasonOf = (m: MovementLog) => {
  const structured = (m.operationReason || "").trim();
  if (structured) return structured;
  if (m.type.startsWith("TRANSFERENCIA")) return "Transferência entre filiais";
  const raw = (m.reason || "").trim();
  return raw ? raw.split("•")[0].trim().slice(0, 40) : "Não informado";
};

interface SizeRow {
  size: string;
  units: number;
  amount: number;
  operations: number;
  previousUnits: number;
  stockUnits: number;
  topProduct: string;
  topProductUnits: number;
  lastExit: number;
}

export default function SizeHistory({ stock, companies, user }: SizeHistoryProps) {
  const isAdmin = user.role === "admin";
  // Quem não é admin lê apenas a própria loja — é o que as regras do Firestore
  // permitem, então pedir mais devolveria permission-denied em vez de dados.
  const scopedCompanyId = isAdmin ? "" : (user.companyId || "");

  const [preset, setPreset] = useState<PeriodPreset>("THIS_MONTH");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [movements, setMovements] = useState<MovementLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);

  const [sizeSearch, setSizeSearch] = useState("");
  const [selectedSize, setSelectedSize] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [reasonFilter, setReasonFilter] = useState("");
  const [exitScope, setExitScope] = useState<ExitScope>("SAIDA");

  // ── Janela de datas ────────────────────────────────────────────
  // O período ANTERIOR tem exatamente a mesma duração do escolhido: é o que
  // torna a variação % honesta (comparar um mês cheio com meio mês daria um
  // "queda de 50%" que é só calendário).
  const range = useMemo(() => {
    const now = new Date();
    const startOfMonth = (y: number, m: number) => new Date(y, m, 1, 0, 0, 0, 0);

    let start: Date;
    let end: Date;

    switch (preset) {
      case "LAST_MONTH":
        start = startOfMonth(now.getFullYear(), now.getMonth() - 1);
        end = startOfMonth(now.getFullYear(), now.getMonth());
        break;
      case "L3M":
        start = startOfMonth(now.getFullYear(), now.getMonth() - 2);
        end = startOfMonth(now.getFullYear(), now.getMonth() + 1);
        break;
      case "L6M":
        start = startOfMonth(now.getFullYear(), now.getMonth() - 5);
        end = startOfMonth(now.getFullYear(), now.getMonth() + 1);
        break;
      case "L12M":
        start = startOfMonth(now.getFullYear(), now.getMonth() - 11);
        end = startOfMonth(now.getFullYear(), now.getMonth() + 1);
        break;
      case "THIS_YEAR":
        start = startOfMonth(now.getFullYear(), 0);
        end = startOfMonth(now.getFullYear() + 1, 0);
        break;
      case "CUSTOM": {
        const f = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
        const t = customTo ? new Date(`${customTo}T00:00:00`) : null;
        start = f && !Number.isNaN(f.getTime()) ? f : startOfMonth(now.getFullYear(), now.getMonth());
        // A data final é inclusiva para quem preenche: "até 31/03" tem que
        // conter o dia 31 inteiro, então a janela fecha na virada do dia 1º.
        end = t && !Number.isNaN(t.getTime())
          ? new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
          : startOfMonth(now.getFullYear(), now.getMonth() + 1);
        break;
      }
      default:
        start = startOfMonth(now.getFullYear(), now.getMonth());
        end = startOfMonth(now.getFullYear(), now.getMonth() + 1);
    }

    if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 86400000);

    const span = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - span);

    return { start, end, prevStart, span };
  }, [preset, customFrom, customTo]);

  const periodLabel = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString("pt-BR");
    const lastDay = new Date(range.end.getTime() - 86400000);
    if (preset === "THIS_MONTH" || preset === "LAST_MONTH") {
      return `${MONTH_NAMES[range.start.getMonth()]} de ${range.start.getFullYear()}`;
    }
    return `${fmt(range.start)} a ${fmt(lastDay)}`;
  }, [range, preset]);

  // ── Busca no Firestore ─────────────────────────────────────────
  // Traz o período escolhido MAIS o anterior de mesma duração, numa consulta
  // só: os dois são necessários para a variação, e duas idas ao banco custariam
  // o dobro de leituras para o mesmo resultado.
  const loadMovements = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      const base = collection(db, "movements");
      const constraints: any[] = [];
      if (scopedCompanyId) constraints.push(where("companyId", "==", scopedCompanyId));
      constraints.push(where("timestamp", ">=", Timestamp.fromDate(range.prevStart)));
      constraints.push(where("timestamp", "<", Timestamp.fromDate(range.end)));
      constraints.push(orderBy("timestamp", "desc"));
      constraints.push(limit(FETCH_LIMIT));

      const snap = await getDocs(query(base, ...constraints));
      const rows: MovementLog[] = [];
      snap.forEach(d => rows.push(mapMovementDoc(d.id, d.data())));
      setMovements(rows);
      setTruncated(rows.length >= FETCH_LIMIT);
      setLoadedAt(Date.now());
    } catch (err: any) {
      console.error("Erro ao carregar o histórico por medida:", err);
      const code = err?.code;
      if (code === "failed-precondition") {
        setFetchError(
          "O banco pediu um índice que ainda não existe para esta consulta. " +
          "Abra o console do navegador: o Firestore imprime o link que cria o índice em um clique."
        );
      } else if (code === "permission-denied") {
        setFetchError(
          "O banco recusou a leitura do histórico. Se a empresa da sua credencial mudou " +
          "recentemente, saia e entre novamente no sistema."
        );
      } else {
        setFetchError(`Não foi possível carregar o histórico${code ? ` (${code})` : ""}: ${err?.message || err}`);
      }
      setMovements([]);
    } finally {
      setLoading(false);
    }
  }, [range.prevStart, range.end, scopedCompanyId]);

  useEffect(() => {
    loadMovements();
  }, [loadMovements]);

  // ── Só o que SAIU ──────────────────────────────────────────────
  // ENTRADA, IMPORTACAO e AJUSTE não são saída e nunca entram aqui. A
  // transferência de saída é opcional: para decidir compra ela conta (o pneu
  // deixou esta loja), mas para medir VENDA ela é ruído, porque o pneu continua
  // no grupo. Quem decide é quem está olhando.
  const isExit = useCallback(
    (m: MovementLog) =>
      m.type === "SAIDA" || (exitScope === "COM_TRANSFERENCIA" && m.type === "TRANSFERENCIA_SAIDA"),
    [exitScope]
  );

  const exits = useMemo(() => movements.filter(isExit), [movements, isExit]);

  // Universo já filtrado por empresa/marca/motivo — mas AINDA NÃO por medida.
  // A medida é o eixo do relatório: se ela cortasse aqui, o ranking teria uma
  // linha só e a participação % de cada medida seria sempre 100%.
  const scopedExits = useMemo(() => {
    return exits.filter(m => {
      if (companyFilter && m.companyId !== companyFilter) return false;
      if (brandFilter && m.brand !== brandFilter) return false;
      if (reasonFilter && reasonOf(m) !== reasonFilter) return false;
      return true;
    });
  }, [exits, companyFilter, brandFilter, reasonFilter]);

  const startMs = range.start.getTime();
  const endMs = range.end.getTime();

  const inPeriod = useCallback(
    (m: MovementLog) => {
      const t = toMillis(m.timestamp);
      return t >= startMs && t < endMs;
    },
    [startMs, endMs]
  );

  const currentExits = useMemo(() => scopedExits.filter(inPeriod), [scopedExits, inPeriod]);
  const previousExits = useMemo(
    () => scopedExits.filter(m => !inPeriod(m)),
    [scopedExits, inPeriod]
  );

  // ── Saldo atual por medida ─────────────────────────────────────
  const stockBySize = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of stock) {
      if (companyFilter && item.companyId !== companyFilter) continue;
      if (brandFilter && item.brand !== brandFilter) continue;
      if (!isAdmin && scopedCompanyId && item.companyId !== scopedCompanyId) continue;
      const key = item.size || "—";
      map.set(key, (map.get(key) || 0) + (Number(item.quantity) || 0));
    }
    return map;
  }, [stock, companyFilter, brandFilter, isAdmin, scopedCompanyId]);

  // ── Ranking por medida ─────────────────────────────────────────
  const sizeRows = useMemo(() => {
    const acc = new Map<string, {
      units: number;
      amount: number;
      ops: Set<string>;
      products: Map<string, number>;
      lastExit: number;
    }>();

    for (const m of currentExits) {
      const key = m.size || "—";
      let row = acc.get(key);
      if (!row) {
        row = { units: 0, amount: 0, ops: new Set(), products: new Map(), lastExit: 0 };
        acc.set(key, row);
      }
      const units = unitsOf(m);
      row.units += units;
      row.amount += amountOf(m);
      // Uma operação com 10 pneus é UMA saída, não dez: sem agrupar por
      // operationId o "nº de saídas" viraria uma contagem de linhas.
      row.ops.add(m.operationId || m.id);
      const product = `${m.brand} ${m.model}`.trim() || m.sku;
      row.products.set(product, (row.products.get(product) || 0) + units);
      const t = toMillis(m.timestamp);
      if (t > row.lastExit) row.lastExit = t;
    }

    const prev = new Map<string, number>();
    for (const m of previousExits) {
      const key = m.size || "—";
      prev.set(key, (prev.get(key) || 0) + unitsOf(m));
    }

    const rows: SizeRow[] = Array.from(acc.entries()).map(([size, row]) => {
      let topProduct = "";
      let topProductUnits = 0;
      row.products.forEach((units, name) => {
        if (units > topProductUnits) {
          topProduct = name;
          topProductUnits = units;
        }
      });
      return {
        size,
        units: row.units,
        amount: row.amount,
        operations: row.ops.size,
        previousUnits: prev.get(size) || 0,
        stockUnits: stockBySize.get(size) || 0,
        topProduct,
        topProductUnits,
        lastExit: row.lastExit
      };
    });

    return rows.sort((a, b) => b.units - a.units || compareTireSize(a.size, b.size));
  }, [currentExits, previousExits, stockBySize]);

  // Busca de medida: aceita 2056516, 205/65 R16 ou 205 65 16 (ver matchesTireSize).
  const visibleSizeRows = useMemo(() => {
    const term = sizeSearch.trim().toLowerCase();
    if (!term) return sizeRows;
    return sizeRows.filter(r => r.size.toLowerCase().includes(term) || matchesTireSize(r.size, term));
  }, [sizeRows, sizeSearch]);

  const totals = useMemo(() => {
    const units = sizeRows.reduce((a, r) => a + r.units, 0);
    const amount = sizeRows.reduce((a, r) => a + r.amount, 0);
    const operations = new Set(currentExits.map(m => m.operationId || m.id)).size;
    const prevUnits = previousExits.reduce((a, m) => a + unitsOf(m), 0);
    const months = Math.max(1, range.span / (1000 * 60 * 60 * 24 * 30.44));
    return {
      units,
      amount,
      operations,
      prevUnits,
      variation: prevUnits > 0 ? ((units - prevUnits) / prevUnits) * 100 : null,
      avgTicket: units > 0 && amount > 0 ? amount / units : 0,
      distinctSizes: sizeRows.length,
      monthlyRate: units / months,
      months
    };
  }, [sizeRows, currentExits, previousExits, range.span]);

  // ── Evolução mês a mês ─────────────────────────────────────────
  // Só do período escolhido (o anterior serve à variação, não ao gráfico).
  // Quando há uma medida selecionada, o gráfico passa a ser o dela.
  const monthlySeries = useMemo(() => {
    const map = new Map<string, number>();
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    while (cursor.getTime() < range.end.getTime()) {
      map.set(monthKey(cursor), 0);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    for (const m of currentExits) {
      if (selectedSize && m.size !== selectedSize) continue;
      const t = toMillis(m.timestamp);
      if (!t) continue;
      const key = monthKey(new Date(t));
      if (map.has(key)) map.set(key, (map.get(key) || 0) + unitsOf(m));
    }
    const entries = Array.from(map.entries()).map(([key, units]) => ({ key, units }));
    const max = entries.reduce((a, e) => Math.max(a, e.units), 0);
    return { entries, max };
  }, [currentExits, range.start, range.end, selectedSize]);

  // ── Detalhe da medida selecionada ──────────────────────────────
  const sizeDetail = useMemo(() => {
    if (!selectedSize) return null;
    const rows = currentExits.filter(m => (m.size || "—") === selectedSize);

    const group = (keyOf: (m: MovementLog) => string) => {
      const map = new Map<string, { units: number; amount: number }>();
      for (const m of rows) {
        const key = keyOf(m) || "—";
        const cur = map.get(key) || { units: 0, amount: 0 };
        cur.units += unitsOf(m);
        cur.amount += amountOf(m);
        map.set(key, cur);
      }
      return Array.from(map.entries())
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => b.units - a.units);
    };

    return {
      rows: [...rows].sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp)),
      byProduct: group(m => `${m.brand} ${m.model}`.trim() || m.sku),
      byReason: group(reasonOf),
      byCompany: group(m => m.companyName || "—"),
      row: sizeRows.find(r => r.size === selectedSize) || null
    };
  }, [selectedSize, currentExits, sizeRows]);

  // ── Opções dos filtros ─────────────────────────────────────────
  const brandOptions = useMemo(
    () => Array.from(new Set<string>(exits.map(m => m.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [exits]
  );
  const reasonOptions = useMemo(
    () => Array.from(new Set<string>(exits.map(reasonOf))).sort((a, b) => a.localeCompare(b)),
    [exits]
  );
  const companyOptions = useMemo(
    () => companies.filter(c => exits.some(m => m.companyId === c.id)),
    [companies, exits]
  );

  const activeFilters =
    (companyFilter ? 1 : 0) + (brandFilter ? 1 : 0) + (reasonFilter ? 1 : 0) + (selectedSize ? 1 : 0);

  const clearFilters = () => {
    setCompanyFilter("");
    setBrandFilter("");
    setReasonFilter("");
    setSelectedSize("");
    setSizeSearch("");
  };

  const exportCSV = () => {
    if (visibleSizeRows.length === 0) return;
    const headers = [
      "Medida", "Unidades que sairam", "Saidas (operacoes)", "Valor total",
      "Periodo anterior (un)", "Variacao (%)", "Estoque atual (un)",
      "Meses de cobertura", "Produto mais vendido", "Un do produto", "Ultima saida"
    ];
    const rows = visibleSizeRows.map(r => {
      const variation = r.previousUnits > 0 ? ((r.units - r.previousUnits) / r.previousUnits) * 100 : null;
      const rate = r.units / totals.months;
      return [
        r.size, r.units, r.operations, r.amount ? r.amount.toFixed(2) : "",
        r.previousUnits, variation === null ? "" : variation.toFixed(1),
        r.stockUnits, rate > 0 ? (r.stockUnits / rate).toFixed(1) : "",
        r.topProduct, r.topProductUnits,
        r.lastExit ? new Date(r.lastExit).toLocaleDateString("pt-BR") : ""
      ];
    });
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
      .join("\n");
    // BOM: sem ele o Excel abre o CSV como ANSI e os acentos viram lixo.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `historico_por_medida_${monthKey(range.start)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const VariationBadge = ({ current, previous }: { current: number; previous: number }) => {
    if (previous <= 0) {
      return (
        <span className="text-[9px] font-bold text-slate-300 uppercase tracking-wider" title="Nada saiu no período anterior — não há base de comparação.">
          novo
        </span>
      );
    }
    const pct = ((current - previous) / previous) * 100;
    const up = pct >= 0;
    return (
      <span
        className={`inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${
          up ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
        }`}
        title={`Período anterior: ${previous} un`}
      >
        {up ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
        {up ? "+" : ""}{pct.toFixed(0)}%
      </span>
    );
  };

  // Quantos meses o saldo atual aguenta no ritmo do período. É o número que
  // transforma o relatório em decisão de compra.
  const coverageOf = (row: SizeRow) => {
    const rate = row.units / totals.months;
    if (rate <= 0) return null;
    return row.stockUnits / rate;
  };

  return (
    <div className="space-y-4">
      {/* ── Período ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-black text-slate-500 uppercase tracking-wider mr-1">
            <CalendarRange size={13} className="text-gold-600" /> Período
          </span>
          {([
            ["THIS_MONTH", "Este mês"],
            ["LAST_MONTH", "Mês passado"],
            ["L3M", "3 meses"],
            ["L6M", "6 meses"],
            ["L12M", "12 meses"],
            ["THIS_YEAR", "Este ano"],
            ["CUSTOM", "Escolher datas"]
          ] as [PeriodPreset, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPreset(key)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-black border transition-all cursor-pointer ${
                preset === key
                  ? "bg-slate-900 text-gold-400 border-slate-900"
                  : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {preset === "CUSTOM" && (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">De</label>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">Até</label>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-black text-slate-900">{periodLabel}</span>
            <span className="text-[11px] font-bold text-slate-400">
              comparado com os {Math.round(range.span / 86400000)} dias anteriores
            </span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={exitScope}
              onChange={e => setExitScope(e.target.value as ExitScope)}
              className="px-3 py-1.5 text-[11px] font-bold text-slate-700 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
            >
              <option value="SAIDA">Só vendas e baixas</option>
              <option value="COM_TRANSFERENCIA">Incluir transferências</option>
            </select>
            <button
              type="button"
              onClick={loadMovements}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-all cursor-pointer"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Atualizar
            </button>
            <button
              type="button"
              onClick={exportCSV}
              disabled={visibleSizeRows.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-all cursor-pointer"
            >
              <Download size={12} /> CSV
            </button>
          </div>
        </div>
      </div>

      {fetchError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold p-3 rounded-xl">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{fetchError}</span>
        </div>
      )}

      {truncated && !fetchError && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 text-amber-900 text-xs font-semibold p-3 rounded-xl">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            O período tem mais de {FETCH_LIMIT.toLocaleString("pt-BR")} movimentos e foi cortado nos mais
            recentes — os totais abaixo estão <strong>incompletos</strong>. Escolha um período mais curto
            para ver os números fechados.
          </span>
        </div>
      )}

      {/* ── Indicadores ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Pneus que Saíram</span>
          <p className="text-xl font-black text-slate-900 tracking-tight mt-1 flex items-baseline gap-2">
            {totals.units}
            {totals.variation !== null && (
              <span className={`text-[11px] font-black ${totals.variation >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {totals.variation >= 0 ? "+" : ""}{totals.variation.toFixed(0)}%
              </span>
            )}
          </p>
          <span className="text-[10px] font-bold text-slate-400">
            período anterior: {totals.prevUnits} un
          </span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Medidas Diferentes</span>
          <p className="text-xl font-black text-slate-900 tracking-tight mt-1">{totals.distinctSizes}</p>
          <span className="text-[10px] font-bold text-slate-400">em {totals.operations} saída{totals.operations === 1 ? "" : "s"}</span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Valor Movimentado</span>
          <p className="text-xl font-black text-emerald-700 tracking-tight mt-1">{formatBRL(totals.amount)}</p>
          <span className="text-[10px] font-bold text-slate-400">
            {totals.avgTicket > 0 ? `${formatBRL(totals.avgTicket)} por pneu` : "sem valor registrado"}
          </span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)]">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Medida Campeã</span>
          <p className="text-xl font-black text-gold-600 tracking-tight mt-1 truncate" title={sizeRows[0]?.size || ""}>
            {sizeRows[0]?.size || "—"}
          </p>
          <span className="text-[10px] font-bold text-slate-400">
            {sizeRows[0] ? `${sizeRows[0].units} un · ${((sizeRows[0].units / (totals.units || 1)) * 100).toFixed(0)}% do total` : "nada saiu no período"}
          </span>
        </div>
      </div>

      {/* ── Evolução mês a mês ───────────────────────────────────── */}
      {monthlySeries.entries.length > 1 && (
        <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] p-4">
          <div className="flex items-center justify-between gap-2 mb-4">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
              Saída mês a mês {selectedSize ? `— ${selectedSize}` : "— todas as medidas"}
            </span>
            <span className="text-[10px] font-bold text-slate-400">unidades</span>
          </div>
          <div className="flex items-end gap-1.5 h-36">
            {monthlySeries.entries.map(e => {
              const pct = monthlySeries.max > 0 ? (e.units / monthlySeries.max) * 100 : 0;
              return (
                <div key={e.key} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
                  <span className="text-[10px] font-black text-slate-700">{e.units || ""}</span>
                  <div
                    className={`w-full rounded-t transition-all ${e.units > 0 ? "bg-gold-500" : "bg-slate-100"}`}
                    style={{ height: `${Math.max(pct, e.units > 0 ? 4 : 2)}%` }}
                    title={`${monthLabel(e.key)}: ${e.units} un`}
                  />
                  <span className="text-[9px] font-bold text-slate-400 uppercase truncate w-full text-center">
                    {monthLabel(e.key)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Filtros ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="lg:col-span-2">
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Buscar medida</label>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={sizeSearch}
                onChange={e => setSizeSearch(e.target.value)}
                placeholder="2056516, 205/65 R16, 205 65 16..."
                className="w-full pl-9 pr-9 py-2 text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
              />
              {sizeSearch && (
                <button
                  type="button"
                  onClick={() => setSizeSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {companyOptions.length > 1 && (
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Empresa</label>
              <select
                value={companyFilter}
                onChange={e => setCompanyFilter(e.target.value)}
                className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
              >
                <option value="">Todas as lojas</option>
                {companyOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
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
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Motivo da saída</label>
            <select
              value={reasonFilter}
              onChange={e => setReasonFilter(e.target.value)}
              className="w-full px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500"
            >
              <option value="">Todos</option>
              {reasonOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-500">
          <span>
            {visibleSizeRows.length} {visibleSizeRows.length === 1 ? "medida" : "medidas"}
            {loadedAt > 0 && !loading && (
              <span className="text-slate-400 font-semibold"> · atualizado {formatDate(new Date(loadedAt))}</span>
            )}
          </span>
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border border-slate-200 text-slate-500 hover:bg-slate-50 transition-all cursor-pointer"
            >
              <RotateCcw size={12} /> Limpar filtros ({activeFilters})
            </button>
          )}
        </div>
      </div>

      {/* ── Ranking por medida ───────────────────────────────────── */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200/70 py-16 text-center">
          <Loader2 size={26} className="mx-auto text-gold-500 animate-spin mb-3" />
          <p className="text-xs font-bold text-slate-500">Carregando o histórico do período...</p>
        </div>
      ) : visibleSizeRows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200/70 py-16 text-center">
          <PackageOpen size={30} className="mx-auto text-slate-300 mb-3" />
          <h3 className="text-sm font-black text-slate-700">Nenhuma saída neste período</h3>
          <p className="text-xs text-slate-500 font-semibold mt-1">
            {sizeRows.length > 0
              ? "Nenhuma medida bate com a busca — limpe o campo para ver todas."
              : "Nada saiu do estoque com os filtros escolhidos. Tente outro período."}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <Trophy size={14} className="text-gold-600" />
            <span className="text-xs font-black text-slate-900">O que mais saiu — {periodLabel}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 text-slate-400 text-[10px] uppercase tracking-widest font-extrabold">
                <tr>
                  <th className="py-3 px-3 border-b border-slate-100 w-[50px] text-center font-black">#</th>
                  <th className="py-3 px-3 border-b border-slate-100 w-[130px] font-black">Medida</th>
                  <th className="py-3 px-3 border-b border-slate-100 w-[150px] font-black">Saíram</th>
                  <th className="py-3 px-3 border-b border-slate-100 w-[90px] text-center font-black">Saídas</th>
                  <th className="py-3 px-3 border-b border-slate-100 w-[110px] text-right font-black">Valor</th>
                  <th className="py-3 px-3 border-b border-slate-100 font-black">Mais vendido na medida</th>
                  <th className="py-3 px-3 border-b border-slate-100 w-[135px] text-center font-black">Estoque hoje</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleSizeRows.map((row, idx) => {
                  const share = totals.units > 0 ? (row.units / totals.units) * 100 : 0;
                  const coverage = coverageOf(row);
                  const isSelected = selectedSize === row.size;
                  return (
                    <tr
                      key={row.size}
                      onClick={() => setSelectedSize(isSelected ? "" : row.size)}
                      className={`cursor-pointer transition-colors ${isSelected ? "bg-gold-400/10" : "hover:bg-slate-50/60"}`}
                    >
                      <td className="py-2.5 px-3 text-center align-middle">
                        <span className={`inline-flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-black ${
                          idx === 0 ? "bg-gold-500 text-slate-900" : idx < 3 ? "bg-slate-900 text-gold-400" : "bg-slate-100 text-slate-500"
                        }`}>
                          {idx + 1}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 align-middle">
                        <span className="inline-flex items-center gap-1.5 font-mono font-black text-xs text-slate-900">
                          <Ruler size={11} className="text-gold-600 shrink-0" />
                          {row.size}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 align-middle">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-sm text-slate-900 tabular-nums">{row.units}</span>
                          <VariationBadge current={row.units} previous={row.previousUnits} />
                        </div>
                        {/* Barra de participação: mostra de relance se a medida
                            campeã domina a loja ou se a saída é pulverizada. */}
                        <div className="mt-1 h-1 w-full max-w-[110px] bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-gold-500 rounded-full" style={{ width: `${Math.max(share, 2)}%` }} />
                        </div>
                        <span className="text-[9px] font-bold text-slate-400">{share.toFixed(1).replace(".", ",")}% do total</span>
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle">
                        <span className="text-xs font-bold text-slate-600">{row.operations}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right align-middle">
                        <span className="text-xs font-black text-emerald-700">
                          {row.amount > 0 ? formatBRL(row.amount) : <span className="text-slate-300 font-normal">—</span>}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 align-middle">
                        {row.topProduct ? (
                          <span className="text-[11px] font-bold text-slate-700">
                            {row.topProduct}
                            <span className="text-slate-400 font-semibold"> · {row.topProductUnits} un</span>
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle">
                        <span className="text-xs font-bold text-slate-800">{row.stockUnits} un</span>
                        {coverage !== null && (
                          <span
                            className={`block text-[9px] font-black uppercase tracking-wider mt-0.5 ${
                              coverage < 1 ? "text-red-600" : coverage < 2 ? "text-amber-600" : "text-slate-400"
                            }`}
                            title="Quantos meses o saldo atual aguenta no ritmo de saída deste período."
                          >
                            {coverage < 1 ? "menos de 1 mês" : `${coverage.toFixed(1).replace(".", ",")} meses`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2.5 bg-slate-50/60 border-t border-slate-100 text-[10px] font-bold text-slate-400">
            Clique numa medida para abrir o detalhe dela.
          </div>
        </div>
      )}

      {/* ── Detalhe da medida ────────────────────────────────────── */}
      {sizeDetail && sizeDetail.row && (
        <div className="bg-white rounded-2xl border-2 border-gold-500/30 shadow-[0_4px_20px_rgba(212,147,33,0.08)] overflow-hidden">
          <div className="px-4 py-3 bg-[#1e1a12] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Ruler size={15} className="text-gold-400 shrink-0" />
              <span className="font-mono font-black text-sm text-gold-400">{selectedSize}</span>
              <span className="text-[11px] font-bold text-slate-400">
                {sizeDetail.row.units} un em {sizeDetail.row.operations} saída{sizeDetail.row.operations === 1 ? "" : "s"} · {periodLabel}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedSize("")}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
            {([
              ["Por produto", sizeDetail.byProduct],
              ["Por motivo", sizeDetail.byReason],
              ["Por loja", sizeDetail.byCompany]
            ] as [string, { key: string; units: number; amount: number }[]][]).map(([title, group]) => (
              <div key={title}>
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider block mb-2">{title}</span>
                <div className="space-y-1.5">
                  {group.slice(0, 8).map(g => {
                    const pct = sizeDetail.row!.units > 0 ? (g.units / sizeDetail.row!.units) * 100 : 0;
                    return (
                      <div key={g.key} className="space-y-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-bold text-slate-700 truncate" title={g.key}>{g.key}</span>
                          <span className="text-[11px] font-black text-slate-900 shrink-0 tabular-nums">{g.units} un</span>
                        </div>
                        <div className="h-1 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-slate-800 rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  {group.length > 8 && (
                    <span className="text-[10px] font-bold text-slate-400 block pt-1">
                      + {group.length - 8} {group.length - 8 === 1 ? "outro" : "outros"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <Boxes size={13} className="text-slate-400" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                Movimento a movimento ({sizeDetail.rows.length})
              </span>
            </div>
            <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[360px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-400 text-[9px] uppercase tracking-widest font-extrabold sticky top-0">
                  <tr>
                    <th className="py-2 px-3 border-b border-slate-100 w-[130px] font-black">Data</th>
                    <th className="py-2 px-3 border-b border-slate-100 font-black">Produto</th>
                    <th className="py-2 px-3 border-b border-slate-100 w-[60px] text-center font-black">Un</th>
                    <th className="py-2 px-3 border-b border-slate-100 w-[110px] font-black">Motivo</th>
                    <th className="py-2 px-3 border-b border-slate-100 font-black">Cliente / Destino</th>
                    <th className="py-2 px-3 border-b border-slate-100 w-[100px] text-right font-black">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sizeDetail.rows.map(m => (
                    <tr key={m.id} className="hover:bg-slate-50/60">
                      <td className="py-2 px-3 text-[10px] font-semibold text-slate-500 align-middle whitespace-nowrap">
                        {formatDate(m.timestamp)}
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <span className="text-[11px] font-bold text-slate-800">
                          {m.brand} <span className="font-normal text-slate-500">{m.model}</span>
                        </span>
                        <span className="block text-[9px] font-mono font-bold text-slate-400 uppercase">{m.sku}</span>
                      </td>
                      <td className="py-2 px-3 text-center align-middle">
                        <span className="text-[11px] font-black text-slate-900">{unitsOf(m)}</span>
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider border ${
                          m.type.startsWith("TRANSFERENCIA")
                            ? "bg-violet-50 text-violet-700 border-violet-200"
                            : "bg-slate-50 text-slate-600 border-slate-200"
                        }`}>
                          {reasonOf(m)}
                        </span>
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <span className="text-[10px] font-semibold text-slate-600 truncate block max-w-[220px]" title={m.partyName || m.reason}>
                          {m.partyName || <span className="text-slate-300">—</span>}
                        </span>
                        {m.companyName && (
                          <span className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                            <Building2 size={8} /> {m.companyName}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right align-middle">
                        <span className="text-[11px] font-black text-emerald-700">
                          {amountOf(m) > 0 ? formatBRL(amountOf(m)) : <span className="text-slate-300 font-normal">—</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="px-4 py-3 bg-slate-50/60 border-t border-slate-100 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-bold text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <ArrowRight size={11} className="text-slate-400" />
              Estoque hoje: <strong className="text-slate-900">{sizeDetail.row.stockUnits} un</strong>
            </span>
            {coverageOf(sizeDetail.row) !== null && (
              <span className="inline-flex items-center gap-1.5">
                Cobertura:{" "}
                <strong className={coverageOf(sizeDetail.row)! < 1 ? "text-red-600" : "text-slate-900"}>
                  {coverageOf(sizeDetail.row)!.toFixed(1).replace(".", ",")} meses
                </strong>
                <span className="font-semibold text-slate-400">no ritmo deste período</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              Período anterior: <strong className="text-slate-900">{sizeDetail.row.previousUnits} un</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
