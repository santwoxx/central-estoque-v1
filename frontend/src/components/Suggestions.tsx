import React, { useMemo, useState } from "react";
import { Company, Suggestion, SuggestionStatus, UserRole } from "../types";
import { exportToCSV, formatDate, matchesTireSize, suggestionTime } from "../utils";
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCheck,
  Download,
  Inbox,
  Lightbulb,
  Loader2,
  Package,
  Phone,
  Search,
  Store,
  Trash2,
  TrendingUp,
  User,
  X
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Aba SUGESTÕES
//
// A demanda que o estoque não atendeu. O vendedor é a única pessoa que ouve
// "vocês têm 205/55 R16?" quando a resposta é não — e antes daqui essa frase
// morria no balcão. Ela vira um recado endereçado ao DONO DA LOJA, que é quem
// decide a próxima compra.
//
// Esta tela NÃO mexe em estoque: nada aqui reserva, dá baixa ou trava saldo.
// É uma fila de recados com desfecho — atendida (o pneu foi comprado / o
// cliente foi atendido) ou arquivada (não vale a pena comprar).
//
// A medida repetida é o número que importa: quatro pessoas pedindo a mesma
// medida na semana é um pedido de compra, não quatro recados soltos. Por isso
// o topo da tela mostra as medidas mais procuradas, e não só a contagem.
// ─────────────────────────────────────────────────────────────────

interface SuggestionsProps {
  suggestions: Suggestion[];
  companies: Company[];
  user: { uid: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  onResolve: (id: string, status: SuggestionStatus, note: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

type ViewFilter = "ABERTAS" | "ATENDIDAS" | "ARQUIVADAS" | "TODAS";

const VIEW_LABELS: Record<ViewFilter, string> = {
  ABERTAS: "Em aberto",
  ATENDIDAS: "Atendidas",
  ARQUIVADAS: "Arquivadas",
  TODAS: "Todas"
};

function statusLabel(status: SuggestionStatus): string {
  if (status === "ATENDIDA") return "Atendida";
  if (status === "ARQUIVADA") return "Arquivada";
  return "Em aberto";
}

export default function Suggestions({
  suggestions,
  companies,
  user,
  onResolve,
  onDelete
}: SuggestionsProps) {
  const [view, setView] = useState<ViewFilter>("ABERTAS");
  const [searchTerm, setSearchTerm] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [processingId, setProcessingId] = useState("");

  // Desfecho com um recado de volta para o vendedor ("encomendei, chega
  // quinta"). Opcional: o caso comum é só marcar e seguir, então o campo só
  // aparece quando alguém clica em responder.
  const [noteTarget, setNoteTarget] = useState<{ id: string; status: SuggestionStatus } | null>(null);
  const [noteText, setNoteText] = useState("");

  const isAdmin = user.role === "admin";

  const sorted = useMemo(
    () => [...suggestions].sort((a, b) => suggestionTime(b) - suggestionTime(a)),
    [suggestions]
  );

  const counts = useMemo(() => {
    const abertas = sorted.filter(s => s.status === "ABERTA");
    return {
      abertas: abertas.length,
      // Unidades pedidas e ainda não resolvidas: é o tamanho da compra que
      // está sendo deixada na mesa, não o número de recados.
      unidades: abertas.reduce((sum, s) => sum + (s.quantity || 0), 0),
      atendidas: sorted.filter(s => s.status === "ATENDIDA").length,
      arquivadas: sorted.filter(s => s.status === "ARQUIVADA").length
    };
  }, [sorted]);

  // As medidas mais pedidas entre as sugestões AINDA EM ABERTO — a lista de
  // compras que a tela existe para produzir.
  const topSizes = useMemo(() => {
    const map = new Map<string, { size: string; pedidos: number; unidades: number }>();
    sorted
      .filter(s => s.status === "ABERTA" && s.size)
      .forEach(s => {
        const key = s.size.trim().toUpperCase();
        const entry = map.get(key) || { size: s.size.trim(), pedidos: 0, unidades: 0 };
        entry.pedidos += 1;
        entry.unidades += s.quantity || 0;
        map.set(key, entry);
      });
    return Array.from(map.values())
      .sort((a, b) => b.unidades - a.unidades || b.pedidos - a.pedidos)
      .slice(0, 6);
  }, [sorted]);

  const visible = useMemo(() => {
    const lower = searchTerm.trim().toLowerCase();
    return sorted.filter(s => {
      if (view === "ABERTAS" && s.status !== "ABERTA") return false;
      if (view === "ATENDIDAS" && s.status !== "ATENDIDA") return false;
      if (view === "ARQUIVADAS" && s.status !== "ARQUIVADA") return false;
      if (companyFilter && s.companyId !== companyFilter) return false;
      if (!lower) return true;
      return (
        s.size.toLowerCase().includes(lower) ||
        matchesTireSize(s.size, lower) ||
        (s.brand || "").toLowerCase().includes(lower) ||
        (s.model || "").toLowerCase().includes(lower) ||
        (s.customerName || "").toLowerCase().includes(lower) ||
        (s.customerContact || "").toLowerCase().includes(lower) ||
        (s.requestedByName || "").toLowerCase().includes(lower) ||
        (s.note || "").toLowerCase().includes(lower)
      );
    });
  }, [sorted, view, companyFilter, searchTerm]);

  // Quem decide o destino do recado: o admin, ou o dono da loja destinatária.
  // Um dono não fecha a sugestão endereçada à filial do vizinho.
  const canDecide = (s: Suggestion) =>
    isAdmin || (user.role === "alimentador" && (!user.companyId || s.companyId === user.companyId));

  const runResolve = async (id: string, status: SuggestionStatus, note: string) => {
    setProcessingId(id);
    try {
      await onResolve(id, status, note);
      setNoteTarget(null);
      setNoteText("");
    } catch (err: any) {
      alert(err?.message || "Não foi possível atualizar a sugestão.");
    } finally {
      setProcessingId("");
    }
  };

  const handleDelete = async (s: Suggestion) => {
    if (!confirm(`Apagar de vez a sugestão de ${s.size}${s.customerName ? ` (${s.customerName})` : ""}?`)) return;
    setProcessingId(s.id);
    try {
      await onDelete(s.id);
    } catch (err: any) {
      alert(err?.message || "Não foi possível apagar a sugestão.");
    } finally {
      setProcessingId("");
    }
  };

  const handleExport = () => {
    exportToCSV(
      visible.map(s => ({
        criadoEm: formatDate(s.createdAt),
        loja: s.companyName,
        medida: s.size,
        marca: s.brand || "",
        modelo: s.model || "",
        quantidade: s.quantity,
        cliente: s.customerName || "",
        contato: s.customerContact || "",
        observacao: s.note || "",
        vendedor: s.requestedByName,
        status: statusLabel(s.status),
        resolvidoEm: s.resolvedAt ? formatDate(s.resolvedAt) : "",
        resposta: s.resolutionNote || ""
      })),
      [
        { key: "criadoEm", label: "Recebida em" },
        { key: "loja", label: "Loja" },
        { key: "medida", label: "Medida" },
        { key: "marca", label: "Marca" },
        { key: "modelo", label: "Modelo" },
        { key: "quantidade", label: "Qtd" },
        { key: "cliente", label: "Cliente" },
        { key: "contato", label: "Contato" },
        { key: "observacao", label: "Observação" },
        { key: "vendedor", label: "Vendedor" },
        { key: "status", label: "Situação" },
        { key: "resolvidoEm", label: "Resolvida em" },
        { key: "resposta", label: "Resposta" }
      ],
      `sugestoes_${new Date().toISOString().slice(0, 10)}`
    );
  };

  return (
    <div className="space-y-5">
      {/* ── Cabeçalho ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-900 flex items-center gap-2">
            <Lightbulb size={18} className="text-gold-600" /> Sugestões dos Vendedores
          </h2>
          <p className="text-xs text-slate-500 font-semibold mt-1 max-w-2xl">
            O que o cliente procurou e a loja não tinha. Cada recado vem do balcão, com a medida,
            o cliente e quem atendeu — é a sua lista de compras, montada por quem ouviu o pedido.
          </p>
        </div>
        {visible.length > 0 && (
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer"
          >
            <Download size={13} /> Exportar CSV
          </button>
        )}
      </div>

      {/* ── Indicadores ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Esperando você"
          value={counts.abertas}
          tone={counts.abertas > 0 ? "gold" : "muted"}
          icon={<Inbox size={16} />}
        />
        <KpiCard label="Unidades pedidas" value={counts.unidades} suffix="un" tone="amber" icon={<Package size={16} />} />
        <KpiCard label="Atendidas" value={counts.atendidas} tone="emerald" icon={<CheckCheck size={16} />} />
        <KpiCard label="Arquivadas" value={counts.arquivadas} tone="muted" icon={<Archive size={16} />} />
      </div>

      {/* ── Medidas mais procuradas ─────────────────────────────── */}
      {topSizes.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-3">
            <TrendingUp size={12} className="text-gold-600" /> Medidas mais procuradas (em aberto)
          </h3>
          <div className="flex flex-wrap gap-2">
            {topSizes.map(t => (
              <button
                key={t.size}
                type="button"
                onClick={() => {
                  setSearchTerm(t.size);
                  setView("ABERTAS");
                }}
                title={`Ver os ${t.pedidos} pedidos desta medida`}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gold-200 bg-gold-50/70 hover:bg-gold-100 transition-all cursor-pointer"
              >
                <span className="font-mono font-black text-xs text-slate-900">{t.size}</span>
                <span className="text-[10px] font-black text-gold-800 bg-white/70 border border-gold-200 rounded-md px-1.5 py-0.5">
                  {t.unidades} un
                </span>
                <span className="text-[10px] font-bold text-slate-500">
                  {t.pedidos} {t.pedidos === 1 ? "pedido" : "pedidos"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Filtros ─────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl p-3 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(VIEW_LABELS) as ViewFilter[]).map(key => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer ${
                view === key
                  ? "bg-slate-900 text-gold-400 border-slate-900 shadow-sm"
                  : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              {VIEW_LABELS[key]}
              {key === "ABERTAS" && counts.abertas > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                  {counts.abertas}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px] flex items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 focus-within:border-gold-500 focus-within:ring-2 focus-within:ring-gold-500/15 transition-all">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Medida, marca, cliente, vendedor..."
              className="w-full outline-none text-xs font-semibold text-slate-800 bg-transparent"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Só o admin enxerga mais de uma loja aqui — para o dono, a lista já
              chega filtrada na dele, e o seletor seria um filtro de um item só. */}
          {isAdmin && companies.length > 1 && (
            <select
              value={companyFilter}
              onChange={e => setCompanyFilter(e.target.value)}
              className="text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none cursor-pointer focus:border-gold-500"
            >
              <option value="">Todas as lojas</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ── Lista ───────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className="bg-white rounded-3xl p-14 text-center shadow-sm border border-slate-200">
          <Lightbulb size={44} className="mx-auto text-slate-300 mb-3" />
          <h3 className="text-base font-black text-slate-700 mb-1">
            {view === "ABERTAS" ? "Nenhuma sugestão em aberto" : "Nada neste filtro"}
          </h3>
          <p className="text-xs text-slate-500 font-semibold max-w-md mx-auto">
            {view === "ABERTAS"
              ? "Quando um vendedor registrar um pneu que o cliente procurou e a loja não tinha, ele aparece aqui."
              : "Troque o filtro acima para ver as demais sugestões."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(s => {
            const busy = processingId === s.id;
            const decide = canDecide(s);
            const open = s.status === "ABERTA";
            const answering = noteTarget?.id === s.id;

            return (
              <div
                key={s.id}
                className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${
                  open ? "border-gold-200" : "border-slate-200"
                }`}
              >
                <div className="p-4 space-y-3">
                  {/* Linha 1: o pneu procurado + situação */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-base font-black text-slate-900">{s.size}</span>
                        {(s.brand || s.model) && (
                          <span className="text-xs font-bold text-slate-600 truncate">
                            {[s.brand, s.model].filter(Boolean).join(" ")}
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-slate-900 text-gold-400">
                          {s.quantity} un
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 font-semibold mt-1">
                        Recebida em {formatDate(s.createdAt)}
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>

                  {/* Linha 2: de onde veio o recado */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-semibold text-slate-600">
                    <span className="inline-flex items-center gap-1.5">
                      <Store size={12} className="text-slate-400" /> {s.companyName || "Loja não informada"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <User size={12} className="text-slate-400" /> {s.requestedByName}
                      {s.requestedByCompanyName && s.requestedByCompanyId !== s.companyId && (
                        <span className="text-slate-400">(de {s.requestedByCompanyName})</span>
                      )}
                    </span>
                    {s.customerName && (
                      <span className="inline-flex items-center gap-1.5 text-slate-800">
                        <User size={12} className="text-gold-600" /> Cliente: {s.customerName}
                      </span>
                    )}
                    {s.customerContact && (
                      <a
                        href={`tel:${s.customerContact.replace(/[^\d+]/g, "")}`}
                        className="inline-flex items-center gap-1.5 text-slate-800 hover:text-gold-700"
                      >
                        <Phone size={12} className="text-gold-600" /> {s.customerContact}
                      </a>
                    )}
                  </div>

                  {s.note && (
                    <p className="text-xs text-slate-700 font-medium bg-slate-50 border border-slate-100 rounded-xl p-2.5">
                      {s.note}
                    </p>
                  )}

                  {/* Desfecho já dado */}
                  {!open && (
                    <div
                      className={`text-[11px] font-semibold rounded-xl p-2.5 border ${
                        s.status === "ATENDIDA"
                          ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                          : "bg-slate-50 border-slate-200 text-slate-600"
                      }`}
                    >
                      {statusLabel(s.status)}
                      {s.resolvedByName ? ` por ${s.resolvedByName}` : ""}
                      {s.resolvedAt ? ` em ${formatDate(s.resolvedAt)}` : ""}
                      {s.resolutionNote && <span className="block mt-1 font-bold">“{s.resolutionNote}”</span>}
                    </div>
                  )}

                  {/* Resposta opcional antes de fechar */}
                  {answering && (
                    <div className="space-y-2 bg-gold-50/60 border border-gold-200 rounded-xl p-3">
                      <label className="block text-[10px] font-black uppercase tracking-widest text-gold-800">
                        Recado para {s.requestedByName}{" "}
                        <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                      </label>
                      <input
                        type="text"
                        value={noteText}
                        onChange={e => setNoteText(e.target.value)}
                        placeholder={
                          noteTarget.status === "ATENDIDA"
                            ? "Ex: encomendei, chega quinta — pode avisar o cliente"
                            : "Ex: fornecedor não trabalha mais com esta medida"
                        }
                        className="w-full px-3 py-2 border border-gold-200 rounded-xl text-xs font-semibold outline-none focus:ring-2 focus:ring-gold-400/30 bg-white"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setNoteTarget(null);
                            setNoteText("");
                          }}
                          className="px-3 py-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-800 cursor-pointer"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => runResolve(s.id, noteTarget.status, noteText.trim())}
                          className="px-3.5 py-1.5 rounded-lg text-[11px] font-black text-white bg-slate-900 hover:bg-slate-800 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          Confirmar {noteTarget.status === "ATENDIDA" ? "atendida" : "arquivamento"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Ações */}
                {decide && !answering && (
                  <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50/70">
                    {open ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => runResolve(s.id, "ARQUIVADA", "")}
                          title="Não vale a pena comprar — sai da fila sem virar compra"
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-500 border border-slate-200 bg-white hover:bg-slate-100 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          <Archive size={12} /> Arquivar
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setNoteTarget({ id: s.id, status: "ATENDIDA" });
                            setNoteText("");
                          }}
                          title="Responder o vendedor antes de fechar"
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-600 border border-slate-200 bg-white hover:bg-slate-100 cursor-pointer disabled:opacity-50"
                        >
                          Responder
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => runResolve(s.id, "ATENDIDA", "")}
                          className="px-3.5 py-1.5 rounded-lg text-[11px] font-black text-white bg-emerald-600 hover:bg-emerald-700 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Marcar
                          atendida
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => runResolve(s.id, "ABERTA", "")}
                          title="Devolver para a fila de compras"
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-600 border border-slate-200 bg-white hover:bg-slate-100 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          <ArchiveRestore size={12} /> Reabrir
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDelete(s)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-rose-600 border border-rose-200 bg-white hover:bg-rose-50 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Apagar
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SuggestionStatus }) {
  const tone =
    status === "ATENDIDA"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "ARQUIVADA"
      ? "bg-slate-100 text-slate-500 border-slate-200"
      : "bg-gold-50 text-gold-800 border-gold-200";
  return (
    <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border ${tone}`}>
      {statusLabel(status)}
    </span>
  );
}

function KpiCard({
  label,
  value,
  suffix,
  tone,
  icon
}: {
  label: string;
  value: number;
  suffix?: string;
  tone: "gold" | "amber" | "emerald" | "muted";
  icon: React.ReactNode;
}) {
  const tones = {
    gold: "bg-gold-50 border-gold-200 text-gold-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    muted: "bg-white border-slate-200 text-slate-500"
  } as const;
  return (
    <div className={`rounded-2xl border p-3.5 flex items-center gap-3 ${tones[tone]}`}>
      <div className="shrink-0 opacity-80">{icon}</div>
      <div className="min-w-0">
        <span className="block text-[10px] font-black uppercase tracking-widest opacity-80 truncate">{label}</span>
        <span className="block text-xl font-black leading-tight">
          {value}
          {suffix && <span className="text-xs font-bold ml-1 opacity-70">{suffix}</span>}
        </span>
      </div>
    </div>
  );
}
