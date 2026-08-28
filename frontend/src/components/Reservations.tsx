import React, { useMemo, useState } from "react";
import {
  Company,
  TransferOrder,
  UserRole,
  isCrossStoreReservation,
  isCustomerReservation
} from "../types";
import { exportToCSV, formatDate, matchesTireSize, toMillis } from "../utils";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Building2,
  Check,
  CheckCheck,
  Clock,
  Download,
  Inbox,
  Loader2,
  Lock,
  Package,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  Truck,
  Unlock,
  User,
  X
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Aba RESERVAS
//
// Uma tela só para o ciclo de vida da reserva de cliente, que antes vivia
// espalhada no meio das transferências entre filiais. São coisas com ritmos
// diferentes: a transferência é logística (assinaturas, motorista, agendamento)
// e a reserva é comercial (um cliente esperando um pneu que já está preso).
//
// O que ela mostra, e a diferença que organiza a tela inteira:
//
//   • RESERVA DA CASA — o pneu está na mesma loja em que o vendedor atende.
//     Uma confirmação (dono da loja ou administrador) e ela vira venda: o pneu
//     sai do estoque na hora e a saída fica registrada em Entradas e Saídas.
//
//   • RESERVA DE OUTRA FILIAL — o pneu está numa loja e o cliente está em
//     outra. Precisa de DOIS avais, o do dono da loja que tem o pneu e o do
//     administrador. Só com os dois ela vira transferência e segue para as
//     assinaturas; a baixa acontece lá, no despacho.
//
// Nos dois casos o pneu já está PRESO desde o instante em que o vendedor abriu
// a reserva — nada aqui é "bloquear o pneu", tudo é decidir o destino dele.
// ─────────────────────────────────────────────────────────────────

interface ReservationsProps {
  reservations: TransferOrder[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  // Confirma uma reserva da própria loja: dá a baixa e registra a venda.
  onConfirmSale: (transferId: string) => Promise<void>;
  // Registra um dos dois avais de uma reserva vinda de outra filial.
  onApproveStep: (transferId: string, step: "SOURCE" | "ADMIN") => Promise<void>;
  onReject: (transferId: string, reason: string) => Promise<void>;
  onCancel: (transferId: string, reason: string) => Promise<void>;
  // Só para administrador: devolve ao estoque um pneu que ficou preso por um
  // pedido já encerrado. Não existe fluxo normal que chegue nesse estado.
  onForceRelease: (transferId: string) => Promise<void>;
  // Apaga o registro de vez. Só vale para reserva recusada ou cancelada.
  onDelete: (transferId: string) => Promise<void>;
}

type ViewFilter = "ACAO" | "ANALISE" | "TRANSFERENCIA" | "CONCLUIDAS" | "ENCERRADAS" | "TODAS";

const VIEW_LABELS: Record<ViewFilter, string> = {
  ACAO: "Aguardando você",
  ANALISE: "Em análise",
  TRANSFERENCIA: "Em transferência",
  CONCLUIDAS: "Concluídas",
  ENCERRADAS: "Recusadas / Canceladas",
  TODAS: "Todas"
};

export default function Reservations({
  reservations,
  companies,
  user,
  onConfirmSale,
  onApproveStep,
  onReject,
  onCancel,
  onForceRelease,
  onDelete
}: ReservationsProps) {
  const isAdmin = user.role === "admin";
  const isVendedor = user.role === "vendedor";
  const myCompanyId = user.companyId || "";

  const [view, setView] = useState<ViewFilter>("ACAO");
  const [searchTerm, setSearchTerm] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [processingId, setProcessingId] = useState("");

  const totalUnitsOf = (t: TransferOrder) =>
    (t.items || []).reduce((acc, i) => acc + (Number(i.quantity) || 0), 0);

  // Reserva "da casa": o pneu está na mesma loja em que o vendedor atende (ou o
  // vendedor não tem loja vinculada, e aí não existe outra ponta).
  const isOwnStoreReservation = (t: TransferOrder) =>
    isCustomerReservation(t) && !isCrossStoreReservation(t);

  const isSourceOwner = (t: TransferOrder) =>
    user.role === "alimentador" && !!myCompanyId && t.sourceCompanyId === myCompanyId;

  // ── Quem pode fazer o quê ────────────────────────────────────────
  // A tela esconde, as regras do Firestore recusam: as duas dizem a mesma coisa,
  // e é a segunda que vale.
  const canConfirmSale = (t: TransferOrder) =>
    isOwnStoreReservation(t) &&
    (t.status === "SOLICITADO" || t.status === "PENDENTE" || t.status === "AGENDADO") &&
    (isAdmin || isSourceOwner(t));

  const canApproveSource = (t: TransferOrder) =>
    isCrossStoreReservation(t) &&
    t.status === "SOLICITADO" &&
    !t.sourceApprovedByUid &&
    (isAdmin || isSourceOwner(t));

  const canApproveAdmin = (t: TransferOrder) =>
    isCrossStoreReservation(t) && t.status === "SOLICITADO" && !t.adminApprovedByUid && isAdmin;

  const canReject = (t: TransferOrder) =>
    isCustomerReservation(t) && t.status === "SOLICITADO" && (isAdmin || isSourceOwner(t));

  // Cancelar vale enquanto o pneu NÃO saiu fisicamente — e não só enquanto está
  // em análise. Limitar a SOLICITADO deixava dois becos sem saída, os dois com
  // pneu preso e ninguém capaz de soltar:
  //   • reserva aprovada por uma versão anterior do sistema, parada em PENDENTE;
  //   • reserva que já virou transferência e o cliente desistiu antes do envio.
  // Depois de EM_TRANSITO o pneu já está na estrada: aí é estorno, não cancelamento.
  const canCancel = (t: TransferOrder) =>
    (t.status === "SOLICITADO" || t.status === "PENDENTE" || t.status === "AGENDADO") &&
    ((isVendedor && t.requestedByUid === user.uid) || isAdmin || isSourceOwner(t));

  // Rede de segurança do administrador: pedido já encerrado (cancelado, recusado
  // ou concluído) que mesmo assim ficou com a reserva ativa. Não deveria existir
  // — toda saída da reserva devolve o saldo na mesma transação —, mas se um dia
  // acontecer (escrita parcial, dado de versão antiga, exclusão manual), o pneu
  // ficaria preso para sempre sem nenhum botão capaz de soltá-lo. Este é o botão.
  const canForceRelease = (t: TransferOrder) =>
    isAdmin &&
    t.reservation?.active === true &&
    (t.status === "CANCELADO" || t.status === "RECUSADO" || t.status === "CONCLUIDO");

  // Apagar o registro. Só o que já morreu: recusada ou cancelada — e nunca com
  // pneu ainda preso, senão some a única pista de por que o saldo está travado.
  // O dono da loja que TEM o pneu é quem faz a faxina da própria fila; o
  // administrador apaga qualquer uma.
  const canDelete = (t: TransferOrder) =>
    (t.status === "RECUSADO" || t.status === "CANCELADO") &&
    t.reservation?.active !== true &&
    (isAdmin || isSourceOwner(t));

  // "Espera uma decisão minha" — o mesmo critério do selo no menu, senão o
  // contador diria 3 e a aba mostraria 2. O pneu travado entra aqui porque é o
  // único estado em que o estoque mente calado: ninguém reclama, e a unidade
  // simplesmente não aparece mais para vender.
  const needsMyAction = (t: TransferOrder) =>
    canConfirmSale(t) || canApproveSource(t) || canApproveAdmin(t) || canForceRelease(t);

  // ── Filtro ───────────────────────────────────────────────────────
  const matchesView = (t: TransferOrder) => {
    switch (view) {
      case "ACAO":
        return needsMyAction(t);
      case "ANALISE":
        return t.status === "SOLICITADO";
      case "TRANSFERENCIA":
        return t.status === "PENDENTE" || t.status === "AGENDADO" || t.status === "EM_TRANSITO";
      case "CONCLUIDAS":
        return t.status === "CONCLUIDO";
      case "ENCERRADAS":
        return t.status === "RECUSADO" || t.status === "CANCELADO";
      default:
        return true;
    }
  };

  const visible = useMemo(() => {
    const lower = searchTerm.trim().toLowerCase();
    return reservations
      .filter(t => {
        if (!matchesView(t)) return false;

        if (companyFilter && t.sourceCompanyId !== companyFilter && t.requestedByCompanyId !== companyFilter) {
          return false;
        }

        if (!lower) return true;
        const haystack = [
          t.customerName,
          t.requestedByName,
          t.sourceCompanyName,
          t.requestedByCompanyName,
          t.destinationCompanyName,
          ...(t.items || []).map(i => `${i.sku} ${i.brand} ${i.model} ${i.size}`)
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(lower) || (t.items || []).some(i => matchesTireSize(i.size, lower));
      })
      .sort((a, b) => {
        // O que espera decisão sobe: é a fila de trabalho da tela.
        const rank = (t: TransferOrder) => (needsMyAction(t) ? 0 : t.status === "SOLICITADO" ? 1 : 2);
        return (
          rank(a) - rank(b) ||
          (toMillis(b.updatedAt) || toMillis(b.requestedAt)) - (toMillis(a.updatedAt) || toMillis(a.requestedAt))
        );
      });
  }, [reservations, view, searchTerm, companyFilter, user]);

  // ── Indicadores do topo ──────────────────────────────────────────
  const kpis = useMemo(() => {
    const analise = reservations.filter(t => t.status === "SOLICITADO");
    return {
      acao: reservations.filter(needsMyAction).length,
      analise: analise.length,
      // Unidades presas no estoque por reserva ainda não decidida: é o número que
      // explica um saldo livre menor do que o pneu que está na prateleira.
      presas: analise.reduce((acc, t) => acc + (t.reservation?.active ? totalUnitsOf(t) : 0), 0),
      transferencia: reservations.filter(
        t => t.status === "PENDENTE" || t.status === "AGENDADO" || t.status === "EM_TRANSITO"
      ).length
    };
  }, [reservations, user]);

  // ── Ações ────────────────────────────────────────────────────────
  const run = async (id: string, fn: () => Promise<void>) => {
    setProcessingId(id);
    try {
      await fn();
    } catch (err: any) {
      alert(err?.message || "Não foi possível concluir a operação.");
    } finally {
      setProcessingId("");
    }
  };

  const handleConfirm = (t: TransferOrder) => {
    const units = totalUnitsOf(t);
    if (
      !window.confirm(
        `Confirmar a reserva de ${units} un para ${t.customerName || "o cliente"}?\n\n` +
          `O pneu SAI do estoque de ${t.sourceCompanyName} agora e a venda fica registrada ` +
          `em Entradas e Saídas no nome do cliente. Só confirme quando o pneu for entregue.`
      )
    ) {
      return;
    }
    run(t.id, () => onConfirmSale(t.id));
  };

  const handleApprove = (t: TransferOrder, step: "SOURCE" | "ADMIN") => {
    const units = totalUnitsOf(t);
    const otherAlreadyIn = step === "SOURCE" ? !!t.adminApprovedByUid : !!t.sourceApprovedByUid;
    const message = otherAlreadyIn
      ? `Este é o SEGUNDO aval: ao confirmar, as ${units} un viram uma TRANSFERÊNCIA de ` +
        `${t.sourceCompanyName} para ${t.requestedByCompanyName || "a loja do vendedor"}.\n\n` +
        `O pneu continua preso na origem e só sai de lá quando o envio for assinado.`
      : `Registrar o seu aval nesta reserva de ${units} un?\n\n` +
        `Ainda falta ${step === "SOURCE" ? "o aval do administrador" : `o aval do dono de ${t.sourceCompanyName}`} ` +
        `para ela virar transferência. Até lá o pneu segue reservado, sem sair do lugar.`;
    if (!window.confirm(message)) return;
    run(t.id, () => onApproveStep(t.id, step));
  };

  const handleReject = (t: TransferOrder) => {
    const reason = window.prompt("Motivo da recusa (o vendedor vê esta mensagem):", "") || "";
    if (!window.confirm("Recusar esta reserva? O pneu volta na hora para o saldo disponível.")) return;
    run(t.id, () => onReject(t.id, reason));
  };

  const handleCancel = (t: TransferOrder) => {
    const reason = window.prompt("Motivo do cancelamento (opcional):", "") || "";
    const extra = isCustomerReservation(t)
      ? ""
      : `\n\nEsta reserva já virou uma transferência para ${t.destinationCompanyName}. ` +
        `Cancelar desfaz o pedido inteiro — avise a outra loja.`;
    if (
      !window.confirm(
        `Cancelar esta reserva? O pneu volta na hora para o saldo disponível de ${t.sourceCompanyName}.${extra}`
      )
    ) {
      return;
    }
    run(t.id, () => onCancel(t.id, reason));
  };

  const handleForceRelease = (t: TransferOrder) => {
    if (
      !window.confirm(
        `Este pedido está ${describeStatus(t).toLowerCase()}, mas ainda consta ${totalUnitsOf(t)} un ` +
          `presas no estoque de ${t.sourceCompanyName}.\n\nDevolver essas unidades ao saldo disponível?`
      )
    ) {
      return;
    }
    run(t.id, () => onForceRelease(t.id));
  };

  const handleDelete = (t: TransferOrder) => {
    if (
      !window.confirm(
        `Apagar de vez o registro desta reserva de ${t.customerName || "cliente"}?\n\n` +
          `Ela já está ${describeStatus(t).toLowerCase()} e o pneu já voltou ao estoque — apagar remove só ` +
          `o histórico do pedido, e isso não tem volta.`
      )
    ) {
      return;
    }
    run(t.id, () => onDelete(t.id));
  };

  // Faxina em lote da aba "Recusadas / Canceladas". Uma a uma, com uma
  // confirmação cada, seria inviável numa fila que acumula meses de pedidos.
  const [bulkBusy, setBulkBusy] = useState(false);
  const deletableInView = visible.filter(canDelete);

  const handleBulkDelete = async () => {
    if (deletableInView.length === 0) return;
    if (
      !window.confirm(
        `Apagar de vez ${deletableInView.length} registro(s) de reserva recusada/cancelada?\n\n` +
          `Os pneus já voltaram ao estoque; some apenas o histórico dos pedidos. Isso não tem volta.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    let failed = 0;
    // Em série, de propósito: cada exclusão é uma transação, e disparar dezenas
    // em paralelo só rende contenção e um erro genérico no fim.
    for (const t of deletableInView) {
      try {
        await onDelete(t.id);
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    if (failed > 0) {
      alert(`${failed} registro(s) não puderam ser apagados. Verifique se você é o dono da loja do pneu.`);
    }
  };

  const handleExport = () => {
    const rows = visible.map(t => ({
      cliente: t.customerName || "—",
      vendedor: t.requestedByName || "—",
      lojaVendedor: t.requestedByCompanyName || "—",
      lojaDoPneu: t.sourceCompanyName,
      tipo: isOwnStoreReservation(t) ? "Reserva da casa" : "Reserva de outra filial",
      itens: (t.items || []).map(i => `${i.quantity}x ${i.sku} ${i.size}`).join(" | "),
      unidades: totalUnitsOf(t),
      situacao: describeStatus(t),
      avalLoja: t.sourceApprovedByName || "—",
      avalAdmin: t.adminApprovedByName || "—",
      aberta: formatDate(t.requestedAt),
      atualizada: formatDate(t.updatedAt)
    }));
    exportToCSV(
      rows,
      [
        { key: "cliente", label: "Cliente" },
        { key: "vendedor", label: "Vendedor" },
        { key: "lojaVendedor", label: "Loja do vendedor" },
        { key: "lojaDoPneu", label: "Loja do pneu" },
        { key: "tipo", label: "Tipo" },
        { key: "itens", label: "Itens" },
        { key: "unidades", label: "Unidades" },
        { key: "situacao", label: "Situação" },
        { key: "avalLoja", label: "Aval da loja" },
        { key: "avalAdmin", label: "Aval do administrador" },
        { key: "aberta", label: "Aberta em" },
        { key: "atualizada", label: "Atualizada em" }
      ],
      `reservas_${new Date().toISOString().slice(0, 10)}`
    );
  };

  return (
    <div className="space-y-5">
      {/* ── Cabeçalho ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-900 flex items-center gap-2">
            <ShoppingBag size={18} className="text-gold-600" /> Reservas de Clientes
          </h2>
          <p className="text-xs text-slate-500 font-semibold mt-1 max-w-2xl">
            Todo pneu reservado por um vendedor aparece aqui e já fica preso no estoque, visível para
            todas as lojas. A baixa só acontece na confirmação.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Faxina em lote: só na aba das encerradas, e só quando há mais de uma
              — para um registro só, o botão do próprio cartão já resolve. */}
          {view === "ENCERRADAS" && deletableInView.length > 1 && (
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkBusy}
              title="Apagar de vez todos os registros recusados/cancelados desta lista"
              className="flex items-center gap-1.5 px-3.5 py-2 border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Limpar {deletableInView.length}
            </button>
          )}
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
      </div>

      {/* ── Indicadores ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Aguardando você"
          value={kpis.acao}
          tone={kpis.acao > 0 ? "gold" : "muted"}
          icon={<Inbox size={16} />}
        />
        <KpiCard label="Em análise" value={kpis.analise} tone="violet" icon={<Clock size={16} />} />
        <KpiCard
          label="Unidades presas"
          value={kpis.presas}
          suffix="un"
          tone="amber"
          icon={<Lock size={16} />}
        />
        <KpiCard label="Em transferência" value={kpis.transferencia} tone="blue" icon={<Truck size={16} />} />
      </div>

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
              {key === "ACAO" && kpis.acao > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                  {kpis.acao}
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
              placeholder="Cliente, vendedor, medida, SKU..."
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

          {companies.length > 1 && (
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
          <Package size={44} className="mx-auto text-slate-300 mb-3" />
          <h3 className="text-base font-black text-slate-700 mb-1">
            {view === "ACAO" ? "Nada esperando por você" : "Nenhuma reserva neste filtro"}
          </h3>
          <p className="text-xs text-slate-500 font-semibold">
            {view === "ACAO"
              ? "Quando um vendedor reservar um pneu que depende da sua confirmação, ele aparece aqui."
              : "Troque o filtro acima para ver as demais reservas."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(t => {
            const busy = processingId === t.id;
            const units = totalUnitsOf(t);
            const ownStore = isOwnStoreReservation(t);
            const crossStore = isCrossStoreReservation(t);
            // Depois de virar transferência o destino já não é mais 'CLIENTE',
            // e é assim que a tela sabe que os dois avais já foram dados.
            const converted = !isCustomerReservation(t);
            const stillHeld = t.reservation?.active === true;
            const hasActions =
              canConfirmSale(t) ||
              canApproveSource(t) ||
              canApproveAdmin(t) ||
              canReject(t) ||
              canCancel(t) ||
              canForceRelease(t) ||
              canDelete(t);

            return (
              <div
                key={t.id}
                className={`bg-white rounded-2xl border border-l-4 shadow-xs transition-all ${accentOf(t)} ${
                  needsMyAction(t) ? "shadow-[0_2px_14px_rgba(212,147,33,0.10)]" : ""
                }`}
              >
                {/* Linha de identificação */}
                <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1.5 text-sm font-black text-slate-900">
                        <User size={14} className="text-gold-600" />
                        {t.customerName || "Cliente não informado"}
                      </span>
                      <StatusBadge transfer={t} />
                      <span
                        className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border ${
                          ownStore
                            ? "bg-gold-50 text-gold-800 border-gold-200"
                            : "bg-indigo-50 text-indigo-800 border-indigo-200"
                        }`}
                      >
                        {ownStore ? "Reserva da casa" : "Outra filial"}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 font-semibold flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="inline-flex items-center gap-1">
                        <Store size={11} /> Pneu em <strong className="text-slate-700">{t.sourceCompanyName}</strong>
                      </span>
                      <span className="text-slate-300">•</span>
                      <span>
                        Vendedor <strong className="text-slate-700">{t.requestedByName}</strong>
                        {t.requestedByCompanyName ? ` (${t.requestedByCompanyName})` : ""}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span>{formatDate(t.requestedAt)}</span>
                    </div>
                  </div>

                  <span className="shrink-0 px-2.5 py-1 rounded-lg bg-slate-900 text-gold-400 text-[11px] font-black">
                    {units} un
                  </span>
                </div>

                {/* Itens */}
                <div className="px-4 py-3 flex flex-wrap gap-1.5">
                  {(t.items || []).map((item, idx) => (
                    <span
                      key={`${t.id}-${item.sourceStockItemId || idx}`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-bold text-slate-700"
                    >
                      <span className="font-mono text-[10px] text-slate-400">{item.sku}</span>
                      {item.size}
                      <span className="font-semibold text-slate-500">
                        {item.brand} {item.model}
                      </span>
                      <span className="text-slate-900 font-black">{item.quantity} un</span>
                    </span>
                  ))}
                </div>

                <div className="px-4 pb-3 space-y-2">
                  {/* Situação do pneu no estoque */}
                  {stillHeld && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
                      <Lock size={13} className="shrink-0 mt-0.5" />
                      <span>
                        <strong>{units} un presas</strong> no estoque de {t.sourceCompanyName} desde{" "}
                        {formatDate(t.reservation?.reservedAt)}. Elas não aparecem como disponíveis para
                        ninguém — e continuam contadas no estoque físico, porque a baixa ainda não aconteceu.
                      </span>
                    </div>
                  )}

                  {/* O que falta, por tipo de reserva */}
                  {t.status === "SOLICITADO" && ownStore && (
                    <div className="flex items-start gap-1.5 text-[11px] text-violet-900 bg-violet-50 border border-violet-200 rounded-xl p-2.5">
                      <Inbox size={13} className="shrink-0 mt-0.5" />
                      <span>
                        Reserva da própria loja. Falta <strong>uma confirmação</strong> — do dono de{" "}
                        {t.sourceCompanyName} ou do administrador. Confirmar dá a{" "}
                        <strong>baixa definitiva</strong> e registra a venda.
                      </span>
                    </div>
                  )}

                  {t.status === "SOLICITADO" && crossStore && (
                    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-2.5 space-y-2">
                      <div className="flex items-start gap-1.5 text-[11px] text-indigo-900">
                        <Truck size={13} className="shrink-0 mt-0.5" />
                        <span>
                          O pneu está em <strong>{t.sourceCompanyName}</strong> e o cliente está em{" "}
                          <strong>{t.requestedByCompanyName || "outra filial"}</strong>: esta reserva vira uma{" "}
                          <strong>transferência</strong>, e por isso depende de <strong>dois avais</strong>.
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <ApprovalChip
                          label={`Dono de ${t.sourceCompanyName}`}
                          who={t.sourceApprovedByName}
                          when={t.sourceApprovedAt}
                          icon={<Building2 size={12} />}
                        />
                        <ApprovalChip
                          label="Administrador"
                          who={t.adminApprovedByName}
                          when={t.adminApprovedAt}
                          icon={<ShieldCheck size={12} />}
                        />
                      </div>
                    </div>
                  )}

                  {converted && t.status !== "CANCELADO" && t.status !== "RECUSADO" && (
                    <div className="flex items-start gap-1.5 text-[11px] text-blue-900 bg-blue-50 border border-blue-200 rounded-xl p-2.5">
                      <Truck size={13} className="shrink-0 mt-0.5" />
                      <span>
                        Os dois avais foram dados e a reserva virou transferência{" "}
                        <strong>
                          {t.sourceCompanyName} <ArrowRight size={10} className="inline" /> {t.destinationCompanyName}
                        </strong>
                        . O acompanhamento das assinaturas fica na aba <strong>Transferências</strong>; a baixa na
                        origem acontece quando o envio for assinado.
                      </span>
                    </div>
                  )}

                  {t.status === "CONCLUIDO" && isCustomerReservation(t) && (
                    <div className="flex items-start gap-1.5 text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-xl p-2.5">
                      <CheckCheck size={13} className="shrink-0 mt-0.5" />
                      <span>
                        Baixa dada por <strong>{t.saleCompletedByName || "—"}</strong> em{" "}
                        {formatDate(t.saleCompletedAt)}. A saída está registrada em Entradas e Saídas no nome do
                        cliente.
                      </span>
                    </div>
                  )}

                  {canForceRelease(t) && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-900 bg-amber-100 border border-amber-400 rounded-xl p-2.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>
                        <strong>Inconsistência:</strong> este pedido está encerrado, mas {units} un continuam
                        presas no estoque de {t.sourceCompanyName}. Use <strong>Destravar pneu</strong> para
                        devolvê-las ao saldo disponível.
                      </span>
                    </div>
                  )}

                  {t.status === "RECUSADO" && (
                    <div className="flex items-start gap-1.5 text-[11px] text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>
                        <strong>{t.rejectedByName || t.sourceCompanyName}</strong> recusou:{" "}
                        {t.rejectReason || "sem motivo informado"}. O pneu voltou para o saldo disponível.
                      </span>
                    </div>
                  )}

                  {t.status === "CANCELADO" && (
                    <div className="flex items-start gap-1.5 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded-xl p-2.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>
                        <strong>{t.cancelledByName || "—"}</strong> cancelou
                        {t.cancelReason ? `: ${t.cancelReason}` : "."} O pneu voltou para o saldo disponível.
                      </span>
                    </div>
                  )}

                  {t.reason && (
                    <p className="text-[11px] text-slate-500 font-semibold italic">Observação: {t.reason}</p>
                  )}
                </div>

                {/* Ações */}
                {hasActions && (
                  <div className="px-4 py-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
                    {canConfirmSale(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleConfirm(t)}
                        title="Dar a baixa no estoque e registrar a venda para este cliente"
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <ShoppingBag size={13} />}{" "}
                        Confirmar e dar baixa
                      </button>
                    )}

                    {canApproveSource(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleApprove(t, "SOURCE")}
                        title={`Aval do dono de ${t.sourceCompanyName} — quem abre mão do pneu`}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-violet-600 hover:bg-violet-700 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Building2 size={13} />} Aprovar pela loja
                      </button>
                    )}

                    {canApproveAdmin(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleApprove(t, "ADMIN")}
                        title="Aval do administrador do sistema"
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-gold-400 font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Aprovar como
                        admin
                      </button>
                    )}

                    {canReject(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleReject(t)}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Ban size={13} /> Recusar
                      </button>
                    )}

                    {canCancel(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleCancel(t)}
                        title={`Desfazer a reserva e devolver o pneu ao saldo de ${t.sourceCompanyName}`}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 text-slate-500 hover:bg-slate-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50"
                      >
                        <X size={13} /> Cancelar reserva
                      </button>
                    )}

                    {canDelete(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleDelete(t)}
                        title="Apagar o registro desta reserva — o pneu já voltou ao estoque"
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Apagar registro
                      </button>
                    )}

                    {canForceRelease(t) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleForceRelease(t)}
                        title="Este pedido está encerrado mas o pneu continua preso — devolver ao saldo"
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-500 hover:bg-amber-600 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Unlock size={13} />} Destravar pneu
                      </button>
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

// ── Peças pequenas ─────────────────────────────────────────────────

// Barra lateral colorida: dá para ler a fila inteira só pela cor da lateral,
// sem parar em cada cartão. Âmbar = pneu preso esperando decisão; azul = já
// virou transferência e anda pelas assinaturas; verde = baixado; rosa = morreu.
function accentOf(t: TransferOrder): string {
  if (t.status === "SOLICITADO") return "border-amber-200 border-l-amber-500 bg-amber-50/30";
  if (t.status === "CONCLUIDO") return "border-emerald-200 border-l-emerald-500";
  if (t.status === "RECUSADO" || t.status === "CANCELADO") return "border-rose-200 border-l-rose-400";
  return "border-blue-200 border-l-blue-500";
}

function describeStatus(t: TransferOrder): string {
  if (t.status === "SOLICITADO") return "Em análise";
  if (t.status === "CONCLUIDO") {
    return isCustomerReservation(t) ? "Vendida (baixa dada)" : "Entregue na loja do vendedor";
  }
  if (t.status === "RECUSADO") return "Recusada";
  if (t.status === "CANCELADO") return "Cancelada";
  if (t.status === "EM_TRANSITO") return "Em trânsito";
  return "Aprovada — em transferência";
}

function StatusBadge({ transfer }: { transfer: TransferOrder }) {
  const label = describeStatus(transfer);
  const tone =
    transfer.status === "SOLICITADO"
      ? "bg-violet-50 text-violet-800 border-violet-200"
      : transfer.status === "CONCLUIDO"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : transfer.status === "RECUSADO" || transfer.status === "CANCELADO"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : "bg-blue-50 text-blue-800 border-blue-200";
  return (
    <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border ${tone}`}>
      {label}
    </span>
  );
}

function ApprovalChip({
  label,
  who,
  when,
  icon
}: {
  label: string;
  who?: string;
  when?: any;
  icon: React.ReactNode;
}) {
  const done = !!who;
  return (
    <div
      className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] ${
        done ? "border-emerald-200 bg-emerald-50/70 text-emerald-900" : "border-slate-200 bg-white text-slate-500"
      }`}
    >
      <span className={`mt-0.5 ${done ? "text-emerald-600" : "text-slate-400"}`}>
        {done ? <Check size={12} /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block font-black uppercase tracking-wide truncate">{label}</span>
        <span className="block font-bold truncate">{done ? `${who} — ${formatDate(when)}` : "Aguardando aval"}</span>
      </span>
    </div>
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
  tone: "gold" | "violet" | "amber" | "blue" | "muted";
  icon: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    gold: "border-gold-300 bg-gold-50/60 text-gold-800",
    violet: "border-violet-200 bg-violet-50/60 text-violet-800",
    amber: "border-amber-200 bg-amber-50/60 text-amber-800",
    blue: "border-blue-200 bg-blue-50/60 text-blue-800",
    muted: "border-slate-200 bg-white text-slate-500"
  };
  return (
    <div className={`rounded-2xl border p-4 flex items-center justify-between gap-2 ${tones[tone]}`}>
      <div className="min-w-0">
        <span className="block text-[10px] font-black uppercase tracking-widest opacity-80 truncate">{label}</span>
        <p className="text-2xl font-black tracking-tight text-slate-900 mt-0.5">
          {value}
          {suffix && <span className="text-xs font-bold text-slate-500"> {suffix}</span>}
        </p>
      </div>
      <span className="shrink-0 opacity-70">{icon}</span>
    </div>
  );
}
