import React, { useMemo, useState } from "react";
import {
  Company,
  StockExitOrigin,
  StockExitRequest,
  StockExitStatus,
  StockItem,
  UserRole,
  canReviewStockExit
} from "../types";
import { formatBRL, formatDate, formatRelativeTime, matchesTireSize, toMillis } from "../utils";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  Clock,
  Hourglass,
  Loader2,
  Package,
  Search,
  ShieldCheck,
  Store,
  User,
  X
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Aba APROVAÇÕES — a fila de baixa
//
// Nenhuma saída sai do estoque sozinha. Quem atende o balcão abre um pedido, o
// pneu é PRESO no mesmo instante, e uma SEGUNDA pessoa confere e libera.
//
// A regra que dá sentido a tudo: QUEM PEDE NÃO APROVA. Por isso o próprio
// pedido de quem está olhando aparece aqui em cinza, com "aguardando outra
// pessoa" — e não com botão de aprovar. É a diferença entre um sistema com
// conferência e um sistema com um clique a mais.
//
// A coluna que mais importa nesta tela não é a quantidade pedida: é o AVISO de
// que o saldo mudou depois que o pedido foi aberto. É ele que pega o pedido
// feito sobre um número velho — o caso em que aprovar no automático deixaria o
// estoque errado.
// ─────────────────────────────────────────────────────────────────

interface ExitApprovalsProps {
  exits: StockExitRequest[];
  stock: StockItem[];
  companies: Company[];
  user: { uid: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  onApprove: (exitId: string) => Promise<any>;
  onReject: (exitId: string, note: string) => Promise<void>;
  onCancel: (exitId: string, note: string) => Promise<void>;
}

type ViewFilter = "PENDENTES" | "MEUS" | "DECIDIDOS" | "TODOS";

const VIEW_LABELS: Record<ViewFilter, string> = {
  PENDENTES: "Esperando decisão",
  MEUS: "Meus pedidos",
  DECIDIDOS: "Já decididos",
  TODOS: "Todos"
};

const ORIGIN_LABELS: Record<StockExitOrigin, string> = {
  BALCAO: "Balcão / Saída",
  RAPIDA: "Baixa rápida",
  CONTAGEM: "Contagem",
  EXCLUSAO: "Exclusão"
};

function statusLabel(status: StockExitStatus): string {
  if (status === "APROVADO") return "Aprovado";
  if (status === "RECUSADO") return "Recusado";
  if (status === "CANCELADO") return "Cancelado";
  return "Aguardando";
}

function statusClasses(status: StockExitStatus): string {
  if (status === "APROVADO") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "RECUSADO") return "bg-red-50 text-red-700 border-red-200";
  if (status === "CANCELADO") return "bg-slate-100 text-slate-500 border-slate-200";
  return "bg-gold-50 text-gold-800 border-gold-300";
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
  tone: "gold" | "emerald" | "red" | "muted";
  icon: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    gold: "bg-gold-50 text-gold-700 border-gold-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    red: "bg-red-50 text-red-600 border-red-100",
    muted: "bg-slate-50 text-slate-500 border-slate-200"
  };
  return (
    <div className="bg-white p-4 rounded-2xl border border-slate-200 flex items-center justify-between">
      <div>
        <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">{label}</span>
        <span className="text-xl font-black text-slate-900 mt-1 block font-mono">
          {value}
          {suffix ? <span className="text-xs font-bold text-slate-400 ml-1">{suffix}</span> : null}
        </span>
      </div>
      <div className={`h-10 w-10 rounded-xl border flex items-center justify-center shrink-0 ${tones[tone]}`}>
        {icon}
      </div>
    </div>
  );
}

export default function ExitApprovals({
  exits,
  stock,
  companies,
  user,
  onApprove,
  onReject,
  onCancel
}: ExitApprovalsProps) {
  const [view, setView] = useState<ViewFilter>("PENDENTES");
  const [searchTerm, setSearchTerm] = useState("");
  const [busyId, setBusyId] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  // Modal de recusa — recusar sem dizer por quê deixa quem pediu no escuro, e
  // o motivo é o que evita o mesmo pedido errado voltar em cinco minutos.
  const [rejecting, setRejecting] = useState<StockExitRequest | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  // Saldo ATUAL de cada pneu, para comparar com o saldo de quando o pedido foi
  // aberto. É daqui que sai o aviso de "o estoque mudou desde o pedido".
  const currentQty = useMemo(() => {
    const map = new Map<string, number>();
    stock.forEach(item => map.set(item.id, Number(item.quantity) || 0));
    return map;
  }, [stock]);

  const companyName = (id: string) => companies.find(c => c.id === id)?.name || "";

  // ── Pedido que parece repetido ──────────────────────────────────
  // A planilha unificada chegou a gerar DOIS pedidos para um mesmo Enter (a
  // célula salvava no Enter e de novo ao perder o foco). Aprovar os dois tira
  // do estoque o dobro do que saiu de verdade — é pneu perdido no sistema.
  //
  // Então todo pedido pendente idêntico a outro pendente anterior — mesma
  // pessoa, mesma loja, mesmos pneus nas mesmas quantidades, aberto até 2
  // minutos depois — sai marcado. Não bloqueia (duas vendas iguais seguidas
  // podem ser legítimas): avisa, e o botão de recusar vem com o motivo pronto.
  const duplicateOf = useMemo(() => {
    const signature = (e: StockExitRequest) =>
      [
        e.requestedByUid,
        e.companyId,
        (e.items || [])
          .map(i => `${i.stockItemId}:${i.quantity}`)
          .sort()
          .join(",")
      ].join("|");

    const pending = exits
      .filter(e => e.status === "PENDENTE")
      .slice()
      .sort((a, b) => toMillis(a.requestedAt) - toMillis(b.requestedAt));

    const firstBySig = new Map<string, StockExitRequest>();
    const result = new Map<string, StockExitRequest>();
    for (const e of pending) {
      const sig = signature(e);
      const first = firstBySig.get(sig);
      if (first && toMillis(e.requestedAt) - toMillis(first.requestedAt) <= 2 * 60 * 1000) {
        result.set(e.id, first);
      } else {
        firstBySig.set(sig, e);
      }
    }
    return result;
  }, [exits]);

  const counts = useMemo(() => {
    let paraDecidir = 0;
    let unidades = 0;
    let meusPendentes = 0;
    let aprovados = 0;
    exits.forEach(e => {
      if (e.status === "PENDENTE") {
        if (canReviewStockExit(e, user)) {
          paraDecidir += 1;
          unidades += Number(e.totalUnits) || 0;
        }
        if (e.requestedByUid === user.uid) meusPendentes += 1;
      }
      if (e.status === "APROVADO") aprovados += 1;
    });
    return { paraDecidir, unidades, meusPendentes, aprovados };
  }, [exits, user]);

  const visible = useMemo(() => {
    const lower = searchTerm.trim().toLowerCase();
    return exits.filter(e => {
      if (view === "PENDENTES" && e.status !== "PENDENTE") return false;
      if (view === "MEUS" && e.requestedByUid !== user.uid) return false;
      if (view === "DECIDIDOS" && e.status === "PENDENTE") return false;

      if (!lower) return true;
      const haystack = [
        e.requestedByName,
        e.companyName,
        e.reason,
        e.partyName,
        e.vehiclePlate,
        e.docNumber
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (haystack.includes(lower)) return true;
      return (e.items || []).some(
        i =>
          i.sku.toLowerCase().includes(lower) ||
          i.brand.toLowerCase().includes(lower) ||
          i.model.toLowerCase().includes(lower) ||
          i.size.toLowerCase().includes(lower) ||
          matchesTireSize(i.size, lower)
      );
    });
  }, [exits, view, searchTerm, user.uid]);

  const runApprove = async (exit: StockExitRequest) => {
    setBusyId(exit.id);
    setErrorMsg("");
    setOkMsg("");
    try {
      await onApprove(exit.id);
      setOkMsg(
        `Baixa aprovada: ${exit.totalUnits} un saíram do estoque de ${exit.companyName || "—"}. ` +
          `O movimento já está na Auditoria.`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || "Não foi possível aprovar este pedido.");
    } finally {
      setBusyId("");
    }
  };

  const runReject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    setErrorMsg("");
    setOkMsg("");
    try {
      await onReject(rejecting.id, rejectNote);
      setOkMsg(`Pedido recusado. As ${rejecting.totalUnits} un voltaram ao saldo livre.`);
      setRejecting(null);
      setRejectNote("");
    } catch (err: any) {
      setErrorMsg(err?.message || "Não foi possível recusar este pedido.");
    } finally {
      setBusyId("");
    }
  };

  const runCancel = async (exit: StockExitRequest) => {
    if (!window.confirm("Cancelar este pedido? Os pneus voltam ao saldo livre e nada sai do estoque.")) return;
    setBusyId(exit.id);
    setErrorMsg("");
    setOkMsg("");
    try {
      await onCancel(exit.id, "Cancelado por quem abriu o pedido");
      setOkMsg("Pedido cancelado. Os pneus voltaram ao saldo livre.");
    } catch (err: any) {
      setErrorMsg(err?.message || "Não foi possível cancelar este pedido.");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="space-y-5 animate-fadeIn">
      {/* ── Explicação da regra ───────────────────────────────────── */}
      <div className="bg-slate-900 text-white rounded-2xl p-4 flex items-start gap-3">
        <ShieldCheck size={18} className="text-gold-400 shrink-0 mt-0.5" />
        <div className="text-[11px] leading-relaxed">
          <p className="font-black uppercase tracking-widest text-gold-400 text-[10px] mb-1">
            Como a baixa funciona agora
          </p>
          <p className="text-slate-300">
            Nenhum pneu sai do estoque sozinho. Quem atende abre o pedido e o pneu fica{" "}
            <b className="text-white">preso na hora</b> — ninguém consegue vender o mesmo pneu duas vezes.
            A baixa é um <b className="text-white">segundo passo</b>, feito pelo dono da loja ou por um
            administrador, e o histórico grava quem pediu e quem liberou. Vendedor não dá baixa: ele reserva,
            e quem fecha a venda da reserva é o dono.
          </p>
        </div>
      </div>

      {/* ── Números ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Esperando você"
          value={counts.paraDecidir}
          tone={counts.paraDecidir > 0 ? "gold" : "muted"}
          icon={<Hourglass size={16} />}
        />
        <KpiCard label="Unidades paradas" value={counts.unidades} suffix="un" tone="red" icon={<Package size={16} />} />
        <KpiCard
          label="Meus pedidos abertos"
          value={counts.meusPendentes}
          tone="muted"
          icon={<Clock size={16} />}
        />
        <KpiCard label="Baixas aprovadas" value={counts.aprovados} tone="emerald" icon={<CheckCheck size={16} />} />
      </div>

      {/* ── Avisos ────────────────────────────────────────────────── */}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs font-bold flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg("")} className="cursor-pointer shrink-0" aria-label="Fechar aviso">
            <X size={14} />
          </button>
        </div>
      )}
      {okMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-xs font-bold flex items-start gap-2">
          <Check size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">{okMsg}</span>
          <button type="button" onClick={() => setOkMsg("")} className="cursor-pointer shrink-0" aria-label="Fechar aviso">
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Filtros ───────────────────────────────────────────────── */}
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
              {key === "PENDENTES" && counts.paraDecidir > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                  {counts.paraDecidir}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 focus-within:border-gold-500 focus-within:ring-2 focus-within:ring-gold-500/15 transition-all">
          <Search size={14} className="text-slate-400 shrink-0" />
          <input
            id="exit-search"
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Buscar por pneu, medida, quem pediu, cliente ou placa..."
            className="flex-1 text-xs font-bold text-slate-900 outline-none bg-transparent"
          />
        </div>
      </div>

      {/* ── Lista ─────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <Hourglass size={26} className="text-slate-300 mx-auto mb-3" />
          <p className="text-xs font-black text-slate-600 uppercase tracking-wider">
            {view === "PENDENTES" ? "Nenhuma baixa esperando decisão" : "Nada por aqui"}
          </p>
          <p className="text-[11px] text-slate-400 font-bold mt-1">
            {view === "PENDENTES"
              ? "Quando alguém pedir uma saída, ela aparece aqui para você conferir."
              : "Troque o filtro acima para ver outros pedidos."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(exit => {
            const canDecide = canReviewStockExit(exit, user);
            const isMine = exit.requestedByUid === user.uid;
            const isPending = exit.status === "PENDENTE";
            const busy = busyId === exit.id;

            // O aviso que mais importa: o saldo mudou desde que o pedido foi
            // aberto? Se mudou, aprovar no automático deixa o estoque errado.
            const drifted = (exit.items || []).filter(i => {
              const now = currentQty.get(i.stockItemId);
              return now !== undefined && now !== i.balanceAtRequest;
            });

            return (
              <div
                key={exit.id}
                className={`bg-white border rounded-2xl overflow-hidden ${
                  isPending ? "border-gold-300 shadow-[0_2px_12px_rgba(0,0,0,0.04)]" : "border-slate-200"
                }`}
              >
                {/* Cabeçalho do pedido */}
                <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span
                    className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-md border ${statusClasses(
                      exit.status
                    )}`}
                  >
                    {statusLabel(exit.status)}
                  </span>
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                    {ORIGIN_LABELS[exit.origin] || exit.origin}
                  </span>
                  <span className="font-mono font-black text-sm text-slate-900">
                    {exit.totalUnits} un
                  </span>
                  {Number(exit.totalAmount) > 0 && (
                    <span className="text-[11px] font-black text-emerald-700">{formatBRL(exit.totalAmount)}</span>
                  )}
                  <span className="flex-1" />
                  <span className="text-[10px] font-bold text-slate-400" title={formatDate(exit.requestedAt)}>
                    {formatRelativeTime(toMillis(exit.requestedAt))}
                  </span>
                </div>

                {/* Quem, onde, por quê */}
                <div className="px-4 py-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] font-bold text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <User size={12} className="text-slate-400" />
                    Pedido por <b className="text-slate-900">{exit.requestedByName}</b>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Store size={12} className="text-slate-400" />
                    {exit.companyName || companyName(exit.companyId) || "—"}
                  </span>
                  <span className="text-slate-500">
                    Motivo: <b className="text-slate-900">{exit.reason}</b>
                  </span>
                  {exit.partyName && (
                    <span className="text-slate-500">
                      Cliente: <b className="text-slate-900">{exit.partyName}</b>
                    </span>
                  )}
                  {exit.vehiclePlate && (
                    <span className="text-slate-500">
                      Placa: <b className="font-mono text-slate-900">{exit.vehiclePlate}</b>
                    </span>
                  )}
                  {exit.docNumber && (
                    <span className="text-slate-500">
                      Doc: <b className="font-mono text-slate-900">{exit.docNumber}</b>
                    </span>
                  )}
                </div>

                {/* Itens */}
                <div className="px-4 pb-3">
                  <div className="border border-slate-100 rounded-xl overflow-x-auto">
                    <table className="w-full text-[11px] min-w-[440px]">
                      <thead>
                        <tr className="bg-slate-50 text-[9px] uppercase tracking-widest text-slate-400 font-black">
                          <th className="text-left px-3 py-2">Código</th>
                          <th className="text-left px-3 py-2">Medida</th>
                          <th className="text-left px-3 py-2">Descrição</th>
                          <th className="text-right px-3 py-2">Baixa</th>
                          <th className="text-right px-3 py-2">Saldo hoje</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(exit.items || []).map(item => {
                          const now = currentQty.get(item.stockItemId);
                          const changed = now !== undefined && now !== item.balanceAtRequest;
                          return (
                            <tr key={item.stockItemId} className="border-t border-slate-100">
                              <td className="px-3 py-2 font-mono font-bold text-slate-900">{item.sku}</td>
                              <td className="px-3 py-2 font-mono font-bold text-slate-700">{item.size}</td>
                              <td className="px-3 py-2 font-bold text-slate-600">
                                {`${item.brand} ${item.model}`.trim()}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-black text-red-700">
                                −{item.quantity}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-bold">
                                {now === undefined ? (
                                  <span className="text-slate-400">excluído</span>
                                ) : changed ? (
                                  <span className="text-amber-700">
                                    {now} <span className="text-slate-400">(era {item.balanceAtRequest})</span>
                                  </span>
                                ) : (
                                  <span className="text-slate-700">{now}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {isPending && duplicateOf.has(exit.id) && (
                    <div className="mt-2 bg-red-50 border border-red-300 text-red-800 rounded-lg px-3 py-2 text-[11px] font-bold flex items-start gap-2">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>
                        Parece <b>repetido</b>: mesma pessoa, mesmos pneus e mesmas quantidades de outro pedido
                        aberto {formatRelativeTime(toMillis(duplicateOf.get(exit.id)!.requestedAt))}. Aprovar os dois
                        tira do estoque o <b>dobro</b> do que saiu. Se foi um clique só, recuse este.
                      </span>
                    </div>
                  )}

                  {isPending && drifted.length > 0 && (
                    <div className="mt-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2 text-[11px] font-bold flex items-start gap-2">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>
                        O saldo de {drifted.length === 1 ? "um pneu" : `${drifted.length} pneus`} mudou depois que este
                        pedido foi aberto. Confira antes de aprovar — a baixa vai usar o saldo de agora, não o de quando
                        o pedido foi feito.
                      </span>
                    </div>
                  )}

                  {exit.observation && (
                    <p className="mt-2 text-[11px] font-bold text-slate-500 italic">“{exit.observation}”</p>
                  )}
                </div>

                {/* Decisão */}
                <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex flex-wrap items-center gap-2">
                  {isPending && canDecide && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => runApprove(exit)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[11px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        Aprovar baixa
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRejecting(exit);
                          setRejectNote(
                            duplicateOf.has(exit.id)
                              ? "Pedido repetido — o mesmo pedido já estava na fila (gerado duas vezes pelo mesmo Enter)."
                              : ""
                          );
                        }}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 text-red-700 text-[11px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                      >
                        <Ban size={13} />
                        Recusar
                      </button>
                    </>
                  )}

                  {/* Quem abriu vê de quem é o pedido mesmo quando pode aprovar:
                      confirmar a própria baixa é legítimo, mas tem que estar à
                      vista de quem clica — e fica gravado no histórico. */}
                  {isPending && isMine && (
                    <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5">
                      <Hourglass size={12} className="text-gold-600" />
                      {canDecide ? "Pedido seu — você confirma a baixa da sua loja." : "Você abriu este pedido."}
                    </span>
                  )}

                  {isPending && isMine && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runCancel(exit)}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50 text-slate-600 text-[10px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                      Cancelar pedido
                    </button>
                  )}

                  {isPending && !canDecide && !isMine && (
                    <span className="text-[11px] font-bold text-slate-400">
                      Aguardando o dono da loja ou um administrador.
                    </span>
                  )}

                  {!isPending && (
                    <span className="text-[11px] font-bold text-slate-500">
                      {statusLabel(exit.status)}
                      {exit.reviewedByName ? ` por ${exit.reviewedByName}` : ""}
                      {exit.reviewedAt ? ` — ${formatDate(exit.reviewedAt)}` : ""}
                      {exit.reviewNote ? ` · “${exit.reviewNote}”` : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Modal de recusa ───────────────────────────────────────── */}
      {rejecting && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4">
            <div>
              <h3 className="text-sm font-black text-slate-900">Recusar este pedido de baixa</h3>
              <p className="text-[11px] font-bold text-slate-500 mt-1">
                As {rejecting.totalUnits} un voltam ao saldo livre e nada sai do estoque.{" "}
                {rejecting.requestedByName} vê o motivo na lista dele.
              </p>
            </div>

            <div>
              <label htmlFor="reject-note" className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-1.5">
                Por que está recusando
              </label>
              <textarea
                id="reject-note"
                value={rejectNote}
                onChange={e => setRejectNote(e.target.value)}
                rows={3}
                placeholder="Ex: quantidade errada, pneu já foi vendido, falta a nota fiscal..."
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/15 transition-all resize-none"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="px-4 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-black uppercase tracking-wider cursor-pointer transition-colors"
              >
                Voltar
              </button>
              <button
                type="button"
                disabled={busyId === rejecting.id}
                onClick={runReject}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-[11px] font-black uppercase tracking-wider cursor-pointer transition-colors"
              >
                {busyId === rejecting.id ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                Recusar pedido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
