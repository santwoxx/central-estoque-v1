import React, { useMemo, useState } from "react";
import { StockItem, Company } from "../types";
import { AlertTriangle, Ban, Check, Loader2, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";
import {
  activePromo,
  availableQuantity,
  compareTireSize,
  daysBetweenISO,
  formatBRL,
  formatISODateBR,
  localISODate,
  matchesTireSize,
  normalCashPrice,
  normalInstallmentPrice,
  parsePriceInput,
  promoStatus,
  PromoStatus,
  promoUntilLabel,
  suggestPromoInstallment
} from "../utils";
import { useToday } from "../hooks/useToday";

// ─────────────────────────────────────────────────────────────────
// Aba "Valor promocional" do Estoque Unificado
//
// A promoção é de UM pneu numa LOJA: o preço mora no documento de estoque de
// cada filial, e duas lojas com o mesmo pneu cobram valores diferentes — a
// promoção também. Ela é gravada ao lado do preço normal (StockItem.promoPrice),
// nunca por cima dele; por isso "voltar ao normal" no fim do prazo não precisa
// de nenhuma rotina: passada a data, todas as telas param de usá-la sozinhas.
//
// Quem cria: o administrador (qualquer loja) e o dono da loja (só a dele) — os
// mesmos que já podem editar preço. Cada criação, alteração e encerramento vai
// para a Auditoria pelo mesmo caminho da edição de preço (onUpdateItem).
// ─────────────────────────────────────────────────────────────────

interface PromotionsManagerProps {
  items: StockItem[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: string; companyId?: string };
  onUpdateItem: (itemId: string, updatedFields: Partial<StockItem>, reason: string, quantityDiff?: number) => Promise<void>;
}

type ListFilter = "ATIVAS" | "VENCIDAS" | "SEM_EFEITO" | "TODAS";

const STATUS_STYLE: Record<Exclude<PromoStatus, "SEM_PROMOCAO">, { label: string; className: string }> = {
  ATIVA: { label: "Ativa", className: "bg-rose-600 text-white border-rose-700" },
  VENCIDA: { label: "Vencida", className: "bg-slate-100 text-slate-500 border-slate-200" },
  SEM_EFEITO: { label: "Sem efeito", className: "bg-amber-50 text-amber-800 border-amber-200" }
};

// "299.9" → "299,90": o campo mostra o número como a pessoa digitaria.
const toInput = (v?: number) => (v && v > 0 ? v.toFixed(2).replace(".", ",") : "");

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localISODate(new Date(y, m - 1, d + days));
}

export default function PromotionsManager({ items, companies, user, onUpdateItem }: PromotionsManagerProps) {
  const today = useToday();
  const isAdmin = user.role === "admin";

  // Mesma regra de quem edita preço na planilha unificada.
  const canEdit = (companyId?: string) =>
    user.role !== "vendedor" && (isAdmin || (!!user.companyId && companyId === user.companyId));

  const companyName = (doc: StockItem) =>
    companies.find(c => c.id === doc.companyId)?.name || doc.companyName || "—";

  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string>("ALL");
  const [listFilter, setListFilter] = useState<ListFilter>("ATIVAS");
  const [notice, setNotice] = useState("");
  const [busyDocId, setBusyDocId] = useState("");

  // Editor: `docId` vazio = ainda escolhendo o pneu.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDocId, setEditorDocId] = useState("");
  const [pickSearch, setPickSearch] = useState("");
  const [promoCashStr, setPromoCashStr] = useState("");
  const [promoInstStr, setPromoInstStr] = useState("");
  // Enquanto ninguém mexe no a prazo, ele acompanha o à vista na proporção do
  // preço normal. Digitou, vale o digitado.
  const [instTouched, setInstTouched] = useState(false);
  const [validity, setValidity] = useState<"DATA" | "SEM_PRAZO">("DATA");
  const [untilDate, setUntilDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const editable = useMemo(
    () => items.filter(d => canEdit(d.companyId) && (companyFilter === "ALL" || d.companyId === companyFilter)),
    [items, companyFilter, user.role, user.companyId]
  );

  // Lojas que esta pessoa pode filtrar: o admin escolhe; o dono só tem a dele.
  const filterCompanies = useMemo(
    () => companies.filter(c => canEdit(c.id) && items.some(d => d.companyId === c.id)),
    [companies, items, user.role, user.companyId]
  );

  const matchesSearch = (doc: StockItem, term: string) => {
    if (!term) return true;
    const lower = term.toLowerCase();
    return (
      doc.sku.toLowerCase().includes(lower) ||
      doc.size.toLowerCase().includes(lower) ||
      doc.brand.toLowerCase().includes(lower) ||
      doc.model.toLowerCase().includes(lower) ||
      (doc.description || "").toLowerCase().includes(lower) ||
      matchesTireSize(doc.size, lower)
    );
  };

  // Todas as promoções gravadas (ativas, vencidas e sem efeito).
  const promotions = useMemo(() => {
    const rank: Record<string, number> = { ATIVA: 0, SEM_EFEITO: 1, VENCIDA: 2 };
    return editable
      .filter(d => (Number(d.promoPrice) || 0) > 0)
      .map(doc => ({ doc, status: promoStatus(doc, today), promo: activePromo(doc, today) }))
      .sort((a, b) =>
        rank[a.status] - rank[b.status] ||
        // Ativas: a que vence primeiro no topo; sem prazo por último.
        (a.doc.promoUntil || "9999-12-31").localeCompare(b.doc.promoUntil || "9999-12-31") ||
        compareTireSize(a.doc.size, b.doc.size)
      );
  }, [editable, today]);

  const counts = useMemo(() => {
    const active = promotions.filter(p => p.status === "ATIVA");
    return {
      active: active.length,
      endingSoon: active.filter(p => p.doc.promoUntil && daysBetweenISO(today, p.doc.promoUntil) <= 3).length,
      expired: promotions.filter(p => p.status === "VENCIDA").length,
      noEffect: promotions.filter(p => p.status === "SEM_EFEITO").length
    };
  }, [promotions, today]);

  const visiblePromotions = promotions.filter(p =>
    matchesSearch(p.doc, search) &&
    (listFilter === "TODAS" ||
      (listFilter === "ATIVAS" && p.status === "ATIVA") ||
      (listFilter === "VENCIDAS" && p.status === "VENCIDA") ||
      (listFilter === "SEM_EFEITO" && p.status === "SEM_EFEITO"))
  );

  // Candidatos da "Nova promoção": quem tem saldo primeiro, medida crescente.
  const pickResults = useMemo(() => {
    if (!editorOpen || editorDocId) return [];
    return editable
      .filter(d => matchesSearch(d, pickSearch.trim()))
      .sort((a, b) =>
        (availableQuantity(b) > 0 ? 1 : 0) - (availableQuantity(a) > 0 ? 1 : 0) ||
        compareTireSize(a.size, b.size) ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, 60);
  }, [editable, editorOpen, editorDocId, pickSearch]);

  const editorDoc = editorDocId ? items.find(d => d.id === editorDocId) || null : null;

  const loadForm = (doc: StockItem) => {
    const has = (Number(doc.promoPrice) || 0) > 0;
    const expired = promoStatus(doc, today) === "VENCIDA";
    setEditorDocId(doc.id);
    // Promoção vencida reaberta = renovar: os valores voltam, a data não.
    setPromoCashStr(has ? toInput(doc.promoPrice) : "");
    setPromoInstStr(has ? toInput(doc.promoPriceInstallment) : "");
    setInstTouched(has && (Number(doc.promoPriceInstallment) || 0) > 0);
    setValidity(has && !doc.promoUntil ? "SEM_PRAZO" : "DATA");
    setUntilDate(has && doc.promoUntil && !expired ? doc.promoUntil : addDaysISO(today, 7));
    setFormError("");
  };

  const openNew = () => {
    setEditorOpen(true);
    setEditorDocId("");
    setPickSearch("");
    setFormError("");
  };

  const openEdit = (doc: StockItem) => {
    setEditorOpen(true);
    loadForm(doc);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditorOpen(false);
    setEditorDocId("");
  };

  // ── Conta do formulário (prévia ao vivo) ──────────────────────────
  const form = useMemo(() => {
    if (!editorDoc) return null;
    const normalCash = normalCashPrice(editorDoc);
    const normalInst = normalInstallmentPrice(editorDoc);
    const cash = parsePriceInput(promoCashStr);
    const suggestedInst = cash && cash > 0 ? suggestPromoInstallment(normalCash, normalInst, cash) : 0;
    const inst = instTouched ? parsePriceInput(promoInstStr) : suggestedInst;
    const cost = Number(editorDoc.costPrice) || 0;
    return { normalCash, normalInst, cash, inst, suggestedInst, cost };
  }, [editorDoc, promoCashStr, promoInstStr, instTouched]);

  const save = async () => {
    if (!editorDoc || !form) return;
    const { normalCash, normalInst, cash, inst } = form;
    const store = companyName(editorDoc);

    if (normalCash <= 0) {
      setFormError(
        `Este pneu está sem preço normal à vista em ${store}. Cadastre o preço antes de criar a promoção — ` +
        `sem ele não há de onde dar desconto.`
      );
      return;
    }
    if (cash === null || cash <= 0) {
      setFormError("Informe o preço promocional à vista (ex: 299,90).");
      return;
    }
    if (cash >= normalCash) {
      setFormError(`O preço promocional precisa ser menor que o preço normal à vista (${formatBRL(normalCash)}).`);
      return;
    }
    if (inst === null || inst <= 0) {
      setFormError("Informe o preço promocional a prazo — ou apague o campo para usar o sugerido.");
      return;
    }
    if (inst < cash) {
      setFormError("O preço a prazo da promoção não pode ser menor que o à vista.");
      return;
    }
    if (inst > Math.max(normalInst, normalCash)) {
      setFormError(`O preço a prazo da promoção não pode passar do a prazo normal (${formatBRL(normalInst)}).`);
      return;
    }
    let until: string | null = null;
    if (validity === "DATA") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
        setFormError("Escolha o último dia da promoção — ou marque \"Sem prazo\".");
        return;
      }
      if (untilDate < today) {
        setFormError("O último dia da promoção não pode estar no passado.");
        return;
      }
      until = untilDate;
    }

    setSaving(true);
    setFormError("");
    try {
      const wasActive = promoStatus(editorDoc, today) === "ATIVA";
      const validityText = until ? `até ${formatISODateBR(until)}` : "sem prazo";
      await onUpdateItem(
        editorDoc.id,
        {
          promoPrice: cash,
          promoPriceInstallment: inst,
          promoUntil: until,
          promoSetAt: new Date().toISOString(),
          promoSetBy: user.displayName || user.email
        },
        `${wasActive ? "Promoção alterada" : "Promoção criada"}: à vista ${formatBRL(cash)} ` +
          `(normal ${formatBRL(normalCash)}), a prazo ${formatBRL(inst)} — ${validityText}`,
        0
      );
      setNotice(
        `Promoção salva: ${editorDoc.size} ${editorDoc.brand} ${editorDoc.model} em ${store} por ` +
        `${formatBRL(cash)} à vista, ${validityText}. Os vendedores já veem o preço promocional no catálogo.`
      );
      setListFilter("ATIVAS");
      setEditorOpen(false);
      setEditorDocId("");
    } catch (err: any) {
      setFormError(err?.message || "Não foi possível salvar a promoção.");
    } finally {
      setSaving(false);
    }
  };

  const endPromotion = async (doc: StockItem, status: PromoStatus) => {
    const store = companyName(doc);
    const expired = status === "VENCIDA";
    const ok = window.confirm(
      expired
        ? `Remover da lista a promoção vencida de ${doc.sku} (${store})? Ela já não vale desde ${formatISODateBR(doc.promoUntil)}.`
        : `Encerrar agora a promoção de ${doc.sku} em ${store}?\n\nO preço volta ao normal (${formatBRL(normalCashPrice(doc))} à vista) na hora, para todos os vendedores.`
    );
    if (!ok) return;
    setBusyDocId(doc.id);
    try {
      await onUpdateItem(
        doc.id,
        {
          promoPrice: 0,
          promoPriceInstallment: 0,
          promoUntil: null,
          promoSetAt: new Date().toISOString(),
          promoSetBy: user.displayName || user.email
        },
        `${expired ? "Promoção vencida removida" : "Promoção encerrada"} (era ${formatBRL(Number(doc.promoPrice) || 0)} à vista)`,
        0
      );
      setNotice(expired ? `Promoção vencida de ${doc.sku} removida.` : `Promoção de ${doc.sku} encerrada — o preço voltou ao normal.`);
    } catch (err: any) {
      alert(err?.message || "Não foi possível encerrar a promoção.");
    } finally {
      setBusyDocId("");
    }
  };

  const summaryCards = [
    { label: "Ativas", value: counts.active, hint: "valendo agora", className: "border-rose-200 bg-rose-50 text-rose-800" },
    { label: "Vencem em até 3 dias", value: counts.endingSoon, hint: "renove ou deixe acabar", className: "border-orange-200 bg-orange-50 text-orange-800" },
    { label: "Vencidas", value: counts.expired, hint: "o preço já voltou ao normal", className: "border-slate-200 bg-slate-50 text-slate-700" },
    { label: "Sem efeito", value: counts.noEffect, hint: "promoção ≥ preço normal", className: "border-amber-200 bg-amber-50 text-amber-800" }
  ];

  const listFilters: { key: ListFilter; label: string; count: number }[] = [
    { key: "ATIVAS", label: "Ativas", count: counts.active },
    { key: "SEM_EFEITO", label: "Sem efeito", count: counts.noEffect },
    { key: "VENCIDAS", label: "Vencidas", count: counts.expired },
    { key: "TODAS", label: "Todas", count: promotions.length }
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide flex items-center gap-1.5">
            <Tag size={15} className="text-rose-600" /> Valor promocional
          </h3>
          <p className="text-[11px] font-semibold text-slate-500 mt-1 max-w-2xl leading-relaxed">
            Coloque um pneu em promoção numa loja. Enquanto ela vale, o catálogo dos vendedores mostra o pneu em
            destaque com o preço promocional, e as vendas já abrem com ele. No fim do prazo o preço volta ao
            normal sozinho — ou deixe sem prazo e encerre quando quiser.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-extrabold rounded-xl text-xs shadow-sm transition-all cursor-pointer"
        >
          <Plus size={14} className="stroke-[3px]" /> Nova promoção
        </button>
      </div>

      {notice && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-800">
          <Check size={14} className="shrink-0 mt-px" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="shrink-0 text-emerald-700 hover:text-emerald-900 cursor-pointer" aria-label="Fechar aviso">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {summaryCards.map(card => (
          <div key={card.label} className={`rounded-xl border px-3 py-2 ${card.className}`}>
            <span className="block text-[9px] font-black uppercase tracking-widest opacity-80">{card.label}</span>
            <span className="block text-lg font-black font-mono">{card.value}</span>
            <span className="block text-[9px] font-bold opacity-70">{card.hint}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center gap-2">
        <div className="flex items-center border border-slate-200 px-3 py-2 rounded-xl lg:max-w-xs w-full focus-within:ring-2 focus-within:ring-rose-500/20 focus-within:border-rose-400 transition-all">
          <Search size={15} className="text-slate-400 mr-2" />
          <input
            type="text"
            placeholder="Buscar promoção por medida, marca, código..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full outline-none text-xs text-slate-800 bg-transparent font-semibold"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {listFilters.map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => setListFilter(f.key)}
              className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-black uppercase tracking-wider cursor-pointer transition-colors ${
                listFilter === f.key
                  ? "bg-slate-900 border-slate-900 text-white"
                  : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label} <span className="font-mono">{f.count}</span>
            </button>
          ))}
        </div>

        {isAdmin && filterCompanies.length > 1 && (
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            aria-label="Filtrar por loja"
            className="lg:ml-auto px-3 py-2 rounded-xl border border-slate-200 bg-white text-[11px] font-bold text-slate-700 outline-none cursor-pointer"
          >
            <option value="ALL">Todas as lojas</option>
            {filterCompanies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>

      {visiblePromotions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-10 text-center">
          <Tag size={26} className="mx-auto text-slate-300" />
          <p className="mt-2 text-xs font-bold text-slate-500">
            {promotions.length === 0
              ? "Nenhuma promoção ainda. Clique em \"Nova promoção\" para colocar um pneu em oferta."
              : "Nenhuma promoção neste filtro."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {visiblePromotions.map(({ doc, status, promo }) => {
            const normalCash = normalCashPrice(doc);
            const normalInst = normalInstallmentPrice(doc);
            const style = STATUS_STYLE[status as Exclude<PromoStatus, "SEM_PROMOCAO">];
            const daysLeft = doc.promoUntil ? daysBetweenISO(today, doc.promoUntil) : null;
            const busy = busyDocId === doc.id;
            const free = availableQuantity(doc);
            return (
              <div
                key={doc.id}
                className={`rounded-2xl border p-3.5 flex flex-col gap-2.5 ${
                  status === "ATIVA" ? "border-rose-200 bg-white" : "border-slate-200 bg-slate-50/60"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wider ${style.className}`}>
                        {status === "ATIVA" && <Tag size={9} className="stroke-[3px]" />} {style.label}
                      </span>
                      <span className="font-mono text-[10px] font-bold text-slate-400">{doc.sku}</span>
                    </div>
                    <p className="mt-1 text-sm font-black text-slate-900 leading-tight">{doc.size}</p>
                    <p className="text-[11px] font-bold text-slate-600 leading-snug">
                      <span className="uppercase">{doc.brand}</span> {doc.model}
                    </p>
                    <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                      {companyName(doc)} · {free > 0 ? `${free} un livres` : "sem saldo livre"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="block text-[10px] font-bold text-slate-400 line-through">{formatBRL(normalCash)}</span>
                    <span className={`block text-lg font-black leading-none ${status === "ATIVA" ? "text-rose-600" : "text-slate-500"}`}>
                      {formatBRL(Number(doc.promoPrice) || 0)}
                    </span>
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-0.5">à vista</span>
                    {promo && (
                      <span className="mt-1 inline-block px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-[10px] font-black text-rose-700">
                        −{String(promo.discountPct).replace(".", ",")}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-slate-500 border-t border-slate-100 pt-2">
                  <span>
                    A prazo: <span className="line-through text-slate-400">{formatBRL(normalInst)}</span>{" "}
                    <span className="text-slate-800">{formatBRL(promo ? promo.installment : Number(doc.promoPriceInstallment) || normalInst)}</span>
                  </span>
                  <span
                    className={
                      status === "ATIVA" && daysLeft !== null && daysLeft <= 3
                        ? "text-orange-700"
                        : ""
                    }
                  >
                    {promoUntilLabel(doc.promoUntil, today)}
                    {status === "ATIVA" && daysLeft !== null && daysLeft > 0 && ` (${daysLeft} ${daysLeft === 1 ? "dia" : "dias"})`}
                  </span>
                  {doc.promoSetBy && <span className="text-slate-400">por {doc.promoSetBy}</span>}
                </div>

                {status === "SEM_EFEITO" && (
                  <p className="flex items-start gap-1.5 text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    <AlertTriangle size={12} className="shrink-0 mt-px" />
                    O preço promocional não é menor que o preço normal à vista ({formatBRL(normalCash)}) — o preço normal
                    mudou depois da promoção. Ela não aparece para ninguém: ajuste o valor ou encerre.
                  </p>
                )}

                <div className="flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => openEdit(doc)}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[10px] font-black uppercase tracking-wider cursor-pointer disabled:opacity-50"
                  >
                    <Pencil size={11} /> {status === "VENCIDA" ? "Renovar" : "Editar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => endPromotion(doc, status)}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 text-[10px] font-black uppercase tracking-wider cursor-pointer disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : status === "VENCIDA" ? <Trash2 size={11} /> : <Ban size={11} />}
                    {status === "VENCIDA" ? "Remover" : "Encerrar"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editorOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide flex items-center gap-1.5">
                <Tag size={15} className="text-rose-600" />
                {editorDoc
                  ? (Number(editorDoc.promoPrice) || 0) > 0 && promoStatus(editorDoc, today) !== "VENCIDA"
                    ? "Editar promoção"
                    : "Nova promoção"
                  : "Nova promoção — escolha o pneu"}
              </h3>
              <button type="button" onClick={closeEditor} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer" aria-label="Fechar">
                <X size={18} />
              </button>
            </div>

            {!editorDoc ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-5 pt-4 pb-2 shrink-0">
                  <div className="flex items-center border border-slate-200 px-3 py-2 rounded-xl focus-within:ring-2 focus-within:ring-rose-500/20 focus-within:border-rose-400">
                    <Search size={15} className="text-slate-400 mr-2" />
                    <input
                      autoFocus
                      type="text"
                      placeholder="Medida, marca, modelo ou código..."
                      value={pickSearch}
                      onChange={e => setPickSearch(e.target.value)}
                      className="w-full outline-none text-xs text-slate-800 bg-transparent font-semibold"
                    />
                  </div>
                  <p className="mt-1.5 text-[10px] font-bold text-slate-400">
                    {isAdmin ? "Cada linha é o pneu numa loja — a promoção vale só nela." : "Pneus da sua loja."}
                  </p>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-1.5">
                  {pickResults.length === 0 ? (
                    <p className="py-8 text-center text-[11px] font-bold text-slate-400">Nenhum pneu encontrado.</p>
                  ) : (
                    pickResults.map(doc => {
                      const status = promoStatus(doc, today);
                      const free = availableQuantity(doc);
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => loadForm(doc)}
                          className="w-full text-left flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-200 hover:border-rose-300 hover:bg-rose-50/40 transition-colors cursor-pointer"
                        >
                          <span className="min-w-0">
                            <span className="block text-[12px] font-black text-slate-900 leading-tight">
                              {doc.size} <span className="font-bold text-slate-600">{doc.brand} {doc.model}</span>
                            </span>
                            <span className="block text-[10px] font-bold text-slate-400 truncate">
                              {doc.sku} · {companyName(doc)} · {free > 0 ? `${free} un` : "sem saldo"}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block text-[11px] font-black text-slate-700">
                              {normalCashPrice(doc) > 0 ? formatBRL(normalCashPrice(doc)) : "sem preço"}
                            </span>
                            {status === "ATIVA" && (
                              <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-rose-600 text-white text-[8px] font-black uppercase tracking-wider">
                                Em promoção
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })
                  )}
                  {pickResults.length === 60 && (
                    <p className="pt-1 text-center text-[10px] font-bold text-slate-400">Mostrando os 60 primeiros — refine a busca.</p>
                  )}
                </div>
              </div>
            ) : form && (
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                <div className="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                  <p className="text-[13px] font-black text-slate-900 leading-tight">
                    {editorDoc.size} <span className="text-slate-600">{editorDoc.brand} {editorDoc.model}</span>
                  </p>
                  <p className="text-[10px] font-bold text-slate-500 mt-0.5">
                    {editorDoc.sku} · {companyName(editorDoc)} · {availableQuantity(editorDoc)} un livres
                  </p>
                  <p className="text-[11px] font-bold text-slate-600 mt-1.5">
                    Preço normal: <span className="text-slate-900">{form.normalCash > 0 ? formatBRL(form.normalCash) : "sem preço"}</span> à vista
                    {form.normalInst !== form.normalCash && (
                      <> · <span className="text-slate-900">{formatBRL(form.normalInst)}</span> a prazo</>
                    )}
                    {form.cost > 0 && <span className="text-slate-400"> · custo {formatBRL(form.cost)}</span>}
                  </p>
                  {(Number(editorDoc.promoPrice) || 0) > 0 && (
                    <p className="text-[10px] font-bold text-slate-400 mt-1">
                      {promoStatus(editorDoc, today) === "VENCIDA" ? "Renovando a promoção vencida." : "Alterando a promoção que já vale."}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">
                      Promocional à vista
                    </label>
                    <div className="flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-500/20">
                      <span className="text-[11px] font-black text-slate-400">R$</span>
                      <input
                        autoFocus
                        inputMode="decimal"
                        value={promoCashStr}
                        onChange={e => { setPromoCashStr(e.target.value); setFormError(""); }}
                        placeholder="0,00"
                        className="w-full outline-none text-sm font-black text-rose-700 bg-transparent"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">
                      Promocional a prazo
                    </label>
                    <div className="flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-500/20">
                      <span className="text-[11px] font-black text-slate-400">R$</span>
                      <input
                        inputMode="decimal"
                        value={instTouched ? promoInstStr : toInput(form.suggestedInst)}
                        onChange={e => {
                          // Apagar tudo devolve o campo ao cálculo automático.
                          setInstTouched(e.target.value.trim() !== "");
                          setPromoInstStr(e.target.value);
                          setFormError("");
                        }}
                        placeholder="automático"
                        className="w-full outline-none text-sm font-black text-slate-800 bg-transparent"
                      />
                    </div>
                    <p className="mt-1 text-[9px] font-bold text-slate-400 leading-snug">
                      {instTouched
                        ? "Valor digitado."
                        : form.normalInst > form.normalCash
                          ? "Na mesma proporção do preço normal."
                          : "Igual ao à vista, como no preço normal."}
                    </p>
                  </div>
                </div>

                {form.cash !== null && form.cash > 0 && form.normalCash > 0 && (
                  <div className="space-y-1.5">
                    {form.cash < form.normalCash ? (
                      <p className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                        Desconto de {String(Math.round((1 - form.cash / form.normalCash) * 1000) / 10).replace(".", ",")}% ·{" "}
                        {formatBRL(form.normalCash - form.cash)} a menos que o preço normal.
                      </p>
                    ) : (
                      <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        O preço promocional precisa ser menor que o normal ({formatBRL(form.normalCash)}).
                      </p>
                    )}
                    {/* Mesma conta do MarginHint do cadastro: o erro de uma casa a
                        mais ou a menos aparece ANTES de alguém gravar. */}
                    {form.cost > 0 && (
                      form.cash < form.cost ? (
                        <p className="flex items-start gap-1.5 text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                          <AlertTriangle size={13} className="shrink-0 mt-px" />
                          Abaixo do custo: cada pneu vendido nesta promoção dá {formatBRL(form.cost - form.cash)} de prejuízo.
                        </p>
                      ) : (
                        <p className="text-[11px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          Lucro por pneu na promoção: {formatBRL(form.cash - form.cost)} ·{" "}
                          {String((((form.cash - form.cost) / form.cash) * 100).toFixed(1)).replace(".", ",")}%
                        </p>
                      )
                    )}
                  </div>
                )}

                <div>
                  <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5">Validade</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => { setValidity("DATA"); setFormError(""); }}
                      className={`px-3 py-2 rounded-xl border text-[11px] font-black cursor-pointer transition-colors ${
                        validity === "DATA" ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      Até uma data
                    </button>
                    <button
                      type="button"
                      onClick={() => { setValidity("SEM_PRAZO"); setFormError(""); }}
                      className={`px-3 py-2 rounded-xl border text-[11px] font-black cursor-pointer transition-colors ${
                        validity === "SEM_PRAZO" ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      Sem prazo
                    </button>
                  </div>
                  {validity === "DATA" ? (
                    <div className="mt-2">
                      <input
                        type="date"
                        value={untilDate}
                        min={today}
                        onChange={e => { setUntilDate(e.target.value); setFormError(""); }}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-800 outline-none focus:border-rose-400"
                      />
                      <p className="mt-1 text-[10px] font-bold text-slate-400">
                        Vale até o fim do dia {formatISODateBR(untilDate) || "escolhido"}. No dia seguinte o preço volta ao normal sozinho.
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-[10px] font-bold text-slate-400">
                      Vale até alguém encerrar a promoção nesta aba.
                    </p>
                  )}
                </div>

                {formError && (
                  <p className="text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl p-2.5">{formError}</p>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 px-5 py-4 border-t border-slate-100 shrink-0">
              {editorDoc && !((Number(editorDoc.promoPrice) || 0) > 0 && promoStatus(editorDoc, today) !== "VENCIDA") && (
                <button
                  type="button"
                  onClick={() => setEditorDocId("")}
                  disabled={saving}
                  className="mr-auto px-3 py-2 rounded-xl text-[11px] font-black text-slate-500 hover:text-slate-800 cursor-pointer disabled:opacity-50"
                >
                  ← Trocar pneu
                </button>
              )}
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-black uppercase tracking-wider cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              {editorDoc && (
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] font-black uppercase tracking-wider cursor-pointer"
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Salvar promoção
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
