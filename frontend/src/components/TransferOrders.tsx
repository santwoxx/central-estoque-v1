import { useMemo, useState } from "react";
import { StockItem, Company, TransferOrder, TransferStatus, UserRole, SignatureRecord, SignatureMethod } from "../types";
import { exportToCSV, formatDate, matchesTireSize, toMillis } from "../utils";
import SignaturePad from "./SignaturePad";
import DriverSignature from "./DriverSignature";
import {
  Plus,
  X,
  Search,
  ArrowRight,
  ArrowLeftRight,
  Calendar,
  Clock,
  Truck,
  PackageCheck,
  Loader2,
  Download,
  Printer,
  Ban,
  RotateCcw,
  User,
  Building2,
  AlertTriangle,
  PenLine,
  Trash2,
} from "lucide-react";

interface TransferOrdersProps {
  transfers: TransferOrder[];
  stock: StockItem[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  onCreateTransfer: (data: {
    items: { sourceStockItemId: string; sku: string; brand: string; model: string; size: string; quantity: number; }[];
    sourceCompanyId: string;
    sourceCompanyName: string;
    destinationCompanyId: string;
    destinationCompanyName: string;
    reason: string;
    scheduledFor: Date | null;
  }) => Promise<void>;
  onCancelTransfer: (transferId: string, reason: string) => Promise<void>;
  // A saida e a chegada acontecem em DUAS vias cada: primeiro a assinatura
  // interna (grava na hora), depois a do motorista (link publico ou foto do
  // papel). O estoque so se move na segunda.
  onSignSenderDispatch: (transferId: string, signatureDataUrl: string) => Promise<void>;
  onCompleteDispatch: (transferId: string, driverSignature: string, driverName: string, method: SignatureMethod) => Promise<void>;
  onSignReceiverArrival: (transferId: string, signatureDataUrl: string) => Promise<void>;
  onCompleteArrival: (transferId: string, driverSignature: string, driverName: string, method: SignatureMethod) => Promise<void>;
  onReverseTransfer?: (transferId: string) => Promise<void>;
  onDeleteTransfer?: (transferId: string) => Promise<void>;
}

const STATUS_LABELS: Record<TransferStatus, string> = {
  AGENDADO: "Agendado",
  PENDENTE: "Aguardando Entrega",
  EM_TRANSITO: "Em Trânsito",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado"
};

// Como a via do motorista foi coletada — vai para o CSV e para o comprovante.
const METHOD_LABELS: Record<string, string> = {
  DESENHO: "Assinou na tela",
  LINK: "Assinou por link no celular",
  FOTO: "Papel assinado (foto anexada)"
};

const STATUS_BADGE_STYLES: Record<TransferStatus, string> = {
  AGENDADO: "bg-slate-100 text-slate-700 border-slate-200",
  PENDENTE: "bg-amber-50 text-amber-800 border-amber-200",
  EM_TRANSITO: "bg-blue-50 text-blue-800 border-blue-200",
  CONCLUIDO: "bg-emerald-50 text-emerald-800 border-emerald-200",
  CANCELADO: "bg-red-50 text-red-700 border-red-200"
};

export default function TransferOrders({
  transfers,
  stock,
  companies,
  user,
  onCreateTransfer,
  onCancelTransfer,
  onSignSenderDispatch,
  onCompleteDispatch,
  onSignReceiverArrival,
  onCompleteArrival,
  onReverseTransfer,
  onDeleteTransfer
}: TransferOrdersProps) {
  const isAdmin = user.role === "admin";
  const isVendedor = user.role === "vendedor";
  const isAlimentador = user.role === "alimentador";
  const canCreate = isAdmin || isAlimentador;

  // ── Filters ─────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACAO_NECESSARIA" | TransferStatus>("ALL");

  // ── Filtro de período e de empresa do histórico ──────────────────
  // Alimenta a lista, o CSV e o relatório impresso — os três leem
  // filteredTransfers, então nunca divergem do que está na tela.
  const [periodFilter, setPeriodFilter] = useState<"ALL" | "TODAY" | "7D" | "30D" | "CUSTOM">("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");

  const periodRange = useMemo(() => {
    if (periodFilter === "ALL") return { start: 0, end: Infinity };

    if (periodFilter === "CUSTOM") {
      const start = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : 0;
      // 23:59:59.999 do dia final, senão "até 10/03" excluiria o próprio dia 10.
      const end = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Infinity;
      return { start: Number.isNaN(start) ? 0 : start, end: Number.isNaN(end) ? Infinity : end };
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (periodFilter === "TODAY") return { start: startOfToday.getTime(), end: Infinity };
    const days = periodFilter === "7D" ? 7 : 30;
    return { start: Date.now() - days * 24 * 60 * 60 * 1000, end: Infinity };
  }, [periodFilter, dateFrom, dateTo]);

  const periodLabel = useMemo(() => {
    const fmt = (v: string) => (v ? v.split("-").reverse().join("/") : "");
    if (periodFilter === "ALL") return "Todo o período";
    if (periodFilter === "TODAY") return "Hoje";
    if (periodFilter === "7D") return "Últimos 7 dias";
    if (periodFilter === "30D") return "Últimos 30 dias";
    return `De ${fmt(dateFrom) || "início"} até ${fmt(dateTo) || "hoje"}`;
  }, [periodFilter, dateFrom, dateTo]);

  // ── Create modal state ──────────────────────────────────────────
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formSourceCompanyId, setFormSourceCompanyId] = useState(isAlimentador ? user.companyId || "" : "");
  const [formStockSearch, setFormStockSearch] = useState("");
  const [formSelectedStockItemId, setFormSelectedStockItemId] = useState("");
  const [formDestinationCompanyId, setFormDestinationCompanyId] = useState("");
  const [formQuantity, setFormQuantity] = useState<string>("");
  const [formItems, setFormItems] = useState<{ sourceStockItemId: string; sku: string; brand: string; model: string; size: string; quantity: number; }[]>([]);
  const [formReason, setFormReason] = useState("");
  const [formIsScheduled, setFormIsScheduled] = useState(false);
  const [formScheduledFor, setFormScheduledFor] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");

  // ── Signature modal state ───────────────────────────────────────
  const [signatureTarget, setSignatureTarget] = useState<{ transfer: TransferOrder; mode: "delivery" | "receipt" } | null>(null);
  const [driverTarget, setDriverTarget] = useState<{ transfer: TransferOrder; stage: "DISPATCH" | "ARRIVAL" } | null>(null);
  const [processingId, setProcessingId] = useState("");

  const isGlobalAdmin = isAdmin && (!user.companyId || user.email === "brisasofc@gmail.com" || user.email === "isaacbomfim.te@gmail.com" || user.email === "isaacbomfim.00@gmail.com");
  const isSourceOf = (t: TransferOrder) => isGlobalAdmin || user.companyId === t.sourceCompanyId;
  const isDestinationOf = (t: TransferOrder) => isGlobalAdmin || user.companyId === t.destinationCompanyId;
  // Cada ponta tem duas etapas: assinar (interna) e coletar a via do motorista.
  const canSignSender = (t: TransferOrder) => t.status === "PENDENTE" && isSourceOf(t) && !t.dispatch?.sender;
  const canCollectDispatchDriver = (t: TransferOrder) =>
    t.status === "PENDENTE" && isSourceOf(t) && !!t.dispatch?.sender && !t.dispatch?.driver;
  const canSignReceiver = (t: TransferOrder) => t.status === "EM_TRANSITO" && isDestinationOf(t) && !t.arrival?.receiver;
  const canCollectArrivalDriver = (t: TransferOrder) =>
    t.status === "EM_TRANSITO" && isDestinationOf(t) && !!t.arrival?.receiver && !t.arrival?.driver;

  // "Aguardando minha ação" cobre as quatro etapas.
  const canSignDelivery = (t: TransferOrder) => canSignSender(t) || canCollectDispatchDriver(t);
  const canSignReceipt = (t: TransferOrder) => canSignReceiver(t) || canCollectArrivalDriver(t);
  const canCancel = (t: TransferOrder) => (t.status === "AGENDADO" || t.status === "PENDENTE") && (isSourceOf(t) || isDestinationOf(t));
  const canReverse = (t: TransferOrder) => t.status === "EM_TRANSITO" && isGlobalAdmin;

  // ── Derived: item list available for the create form ───────────
  const effectiveSourceCompanyId = formSourceCompanyId;
  const effectiveSourceCompanyName = companies.find(c => c.id === effectiveSourceCompanyId)?.name || "";

  const sourceStockOptions = useMemo(() => {
    if (!effectiveSourceCompanyId) return [];
    const lower = formStockSearch.toLowerCase();
    return stock
      .filter(item => item.companyId === effectiveSourceCompanyId && item.quantity > 0)
      .filter(item =>
        !lower ||
        item.sku.toLowerCase().includes(lower) ||
        item.brand.toLowerCase().includes(lower) ||
        item.model.toLowerCase().includes(lower) ||
        item.size.toLowerCase().includes(lower) ||
        matchesTireSize(item.size, lower)
      )
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .slice(0, 60);
  }, [stock, effectiveSourceCompanyId, formStockSearch]);

  const selectedStockItem = stock.find(item => item.id === formSelectedStockItemId) || null;
  const destinationOptions = companies.filter(c => c.id !== effectiveSourceCompanyId);

  // ── Filtering / sorting the transfer list ───────────────────────
  const filteredTransfers = useMemo(() => {
    return transfers.filter(t => {
      const itemStr = (t.items || []).map(i => i.sku + i.brand + i.model + i.size).join("").toLowerCase();
      const matchesSearch =
        searchTerm === "" ||
        itemStr.includes(searchTerm.toLowerCase()) ||
        (t.items || []).some(i => matchesTireSize(i.size, searchTerm)) ||
        t.sourceCompanyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.destinationCompanyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.requestedByName.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "ALL" ||
        (statusFilter === "ACAO_NECESSARIA" ? canSignDelivery(t) || canSignReceipt(t) : t.status === statusFilter);

      // Data do pedido: e a data que o usuario reconhece como "quando isso aconteceu".
      const requestedMillis = toMillis(t.requestedAt);
      const matchesPeriod =
        periodFilter === "ALL" ||
        (requestedMillis >= periodRange.start && requestedMillis <= periodRange.end);

      // Empresa envolvida, seja como origem ou como destino.
      const matchesCompany =
        !companyFilter ||
        t.sourceCompanyId === companyFilter ||
        t.destinationCompanyId === companyFilter;

      return matchesSearch && matchesStatus && matchesPeriod && matchesCompany;
    });
  }, [transfers, searchTerm, statusFilter, periodFilter, periodRange, companyFilter]);

  // ── Reset / open create modal ───────────────────────────────────
  const openCreateModal = () => {
    setFormSourceCompanyId(isAlimentador ? user.companyId || "" : "");
    setFormStockSearch("");
    setFormSelectedStockItemId("");
    setFormDestinationCompanyId("");
    setFormQuantity("");
    setFormItems([]);
    setFormReason("");
    setFormIsScheduled(false);
    setFormScheduledFor("");
    setCreateError("");
    setShowCreateModal(true);
  };

  const handleAddItem = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    if (!selectedStockItem) {
      setCreateError("Selecione um item.");
      return;
    }
    const qty = parseInt(String(formQuantity), 10);
    if (isNaN(qty) || qty <= 0) {
      setCreateError("Informe uma quantidade válida.");
      return;
    }
    const maxQty = Number(selectedStockItem.quantity);
    if (qty > maxQty) {
      setCreateError(`Quantidade indisponível. Saldo atual: ${maxQty} un.`);
      return;
    }
    
    if (formItems.find(i => i.sourceStockItemId === selectedStockItem.id)) {
      setCreateError("Este item já foi adicionado à lista. Remova-o abaixo se desejar alterar a quantidade.");
      return;
    }

    setFormItems(prev => [...prev, {
      sourceStockItemId: selectedStockItem.id,
      sku: selectedStockItem.sku || "",
      brand: selectedStockItem.brand || "",
      model: selectedStockItem.model || "",
      size: selectedStockItem.size || "",
      quantity: qty
    }]);
    
    setFormSelectedStockItemId("");
    setFormQuantity("");
    setFormStockSearch("");
    setCreateError("");
  };

  const handleRemoveItem = (sourceId: string) => {
    setFormItems(formItems.filter(i => i.sourceStockItemId !== sourceId));
  };

  const handleSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");

    if (formItems.length === 0) {
      setCreateError("Adicione pelo menos um item ao pedido.");
      return;
    }
    if (!formDestinationCompanyId) {
      setCreateError("Selecione a empresa de destino.");
      return;
    }
    if (!isGlobalAdmin && effectiveSourceCompanyId !== user.companyId && formDestinationCompanyId !== user.companyId) {
      setCreateError("Você só pode criar transferências que envolvam a sua própria loja.");
      return;
    }

    let scheduledDate: Date | null = null;
    if (formIsScheduled) {
      if (!formScheduledFor) {
        setCreateError("Selecione a data e hora do agendamento.");
        return;
      }
      scheduledDate = new Date(formScheduledFor);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        setCreateError("A data agendada precisa estar no futuro.");
        return;
      }
    }

    const destinationCompany = companies.find(c => c.id === formDestinationCompanyId);

    setCreateLoading(true);
    try {
      await onCreateTransfer({
        items: formItems,
        sourceCompanyId: effectiveSourceCompanyId,
        sourceCompanyName: effectiveSourceCompanyName,
        destinationCompanyId: formDestinationCompanyId,
        destinationCompanyName: destinationCompany?.name || "",
        reason: formReason,
        scheduledFor: scheduledDate
      });
      setShowCreateModal(false);
    } catch (err: any) {
      setCreateError(err.message || "Erro ao criar pedido de transferência.");
    } finally {
      setCreateLoading(false);
    }
  };

  // ── Row actions ──────────────────────────────────────────────────
  // Via 1: assinatura interna. Ao confirmar, ja emenda no painel do motorista —
  // e o "assino, daí ja confirma, abre outro campo" do fluxo de balcao.
  const handleConfirmInternalSignature = async (signatureDataUrl: string) => {
    if (!signatureTarget) return;
    const { transfer, mode } = signatureTarget;
    setProcessingId(transfer.id);
    try {
      if (mode === "delivery") {
        await onSignSenderDispatch(transfer.id, signatureDataUrl);
      } else {
        await onSignReceiverArrival(transfer.id, signatureDataUrl);
      }
      setSignatureTarget(null);
      setDriverTarget({ transfer, stage: mode === "delivery" ? "DISPATCH" : "ARRIVAL" });
    } catch (err: any) {
      throw new Error(err?.message || "Erro ao registrar assinatura.");
    } finally {
      setProcessingId("");
    }
  };

  // Via 2: a do motorista. E aqui que o estoque efetivamente se move.
  const handleCompleteDriverSignature = async (signatureDataUrl: string, driverName: string, method: SignatureMethod) => {
    if (!driverTarget) return;
    const { transfer, stage } = driverTarget;
    setProcessingId(transfer.id);
    try {
      if (stage === "DISPATCH") {
        await onCompleteDispatch(transfer.id, signatureDataUrl, driverName, method);
      } else {
        await onCompleteArrival(transfer.id, signatureDataUrl, driverName, method);
      }
      setDriverTarget(null);
    } catch (err: any) {
      throw new Error(err?.message || "Erro ao concluir a operação.");
    } finally {
      setProcessingId("");
    }
  };

  const handleCancelClick = async (t: TransferOrder) => {
    const reason = window.prompt("Motivo do cancelamento (opcional):", "") || "";
    if (!window.confirm("Confirma o cancelamento deste pedido de transferência?")) return;
    setProcessingId(t.id);
    try {
      await onCancelTransfer(t.id, reason);
    } catch (err: any) {
      alert(err.message || "Erro ao cancelar pedido.");
    } finally {
      setProcessingId("");
    }
  };

  const handleReverseClick = async (t: TransferOrder) => {
    if (!onReverseTransfer) return;
    if (!window.confirm("Estornar esta transferência? O estoque será devolvido para a empresa de origem e o pedido será cancelado.")) return;
    setProcessingId(t.id);
    try {
      await onReverseTransfer(t.id);
    } catch (err: any) {
      alert(err.message || "Erro ao estornar transferência.");
    } finally {
      setProcessingId("");
    }
  };

  const handleDeleteClick = async (t: TransferOrder) => {
    if (!onDeleteTransfer) return;
    if (!window.confirm("Excluir permanentemente este pedido de transferência? Esta ação não pode ser desfeita.")) return;
    setProcessingId(t.id);
    try {
      await onDeleteTransfer(t.id);
    } catch (err: any) {
      alert(err.message || "Erro ao excluir pedido.");
    } finally {
      setProcessingId("");
    }
  };

  // Resolve as 4 assinaturas do pedido (remetente + motorista na saida, motorista +
  // recebedor na chegada), caindo para o par legado delivery/receipt nos pedidos
  // antigos, criados antes do fluxo de 4 vias existir.
  const resolveSignatures = (t: TransferOrder) => [
    { label: "Entrega — Responsável da Origem", sig: t.dispatch?.sender || t.delivery || null },
    { label: "Entrega — Motorista (retirada)", sig: t.dispatch?.driver || null },
    { label: "Recebimento — Motorista (entrega)", sig: t.arrival?.driver || null },
    { label: "Recebimento — Responsável do Destino", sig: t.arrival?.receiver || t.receipt || null }
  ];

  const totalUnitsOf = (t: TransferOrder) =>
    (t.items || []).reduce((acc, i) => acc + (Number(i.quantity) || 0), 0);

  // ── Comprovante individual: itens + as 4 assinaturas ──
  const handlePrintReceipt = (t: TransferOrder) => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const renderSignatureBlock = (label: string, sig?: SignatureRecord | null) => {
      // Foto de papel assinado precisa de mais altura que um rabisco de tela,
      // senao sai ilegivel no comprovante.
      const height = sig?.method === "FOTO" ? 170 : 70;
      const img = sig?.signatureDataUrl
        ? `<img src="${sig.signatureDataUrl}" alt="${label}" style="max-width:100%;height:${height}px;object-fit:contain;display:block;margin:0 auto;" />`
        : `<div style="height:70px;display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;">Assinatura pendente</div>`;
      const origin =
        sig?.method === "FOTO" ? " • via papel assinado (foto)"
        : sig?.method === "LINK" ? " • assinado por link no celular"
        : "";
      const meta = sig ? `${sig.signedByName || "—"} — ${formatDate(sig.signedAt)}${origin}` : "—";
      return `
        <div class="sig-block">
          <div class="sig-title">${label}</div>
          ${img}
          <div class="sig-meta">${meta}</div>
        </div>
      `;
    };

    const itemRows = (t.items || []).map(i => `
      <tr>
        <td class="mono">${i.sku || "—"}</td>
        <td>${i.brand || ""} ${i.model || ""}</td>
        <td class="mono">${i.size || "—"}</td>
        <td class="num">${i.quantity} un</td>
      </tr>
    `).join("");

    printWindow.document.write(`
      <html>
        <head>
          <title>Comprovante de Transferência - Central Stoque</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; max-width: 520px; margin: auto; padding: 24px; }
            .header { text-align: center; border-bottom: 2px dashed #ccc; padding-bottom: 12px; margin-bottom: 16px; }
            .title { font-weight: bold; font-size: 16px; text-transform: uppercase; }
            .status { display: inline-block; margin-top: 6px; padding: 3px 10px; border: 1px solid #cbd5e1; border-radius: 999px; font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: .5px; }
            .row { display: flex; justify-content: space-between; margin: 4px 0; gap: 12px; }
            .label { color: #64748b; font-weight: bold; white-space: nowrap; }
            .divider { border-top: 1px dashed #ccc; margin: 14px 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 6px; }
            th { text-align: left; font-size: 10px; text-transform: uppercase; color: #64748b; border-bottom: 1px solid #e2e8f0; padding: 5px 4px; }
            td { padding: 5px 4px; border-bottom: 1px solid #f1f5f9; font-size: 11px; }
            .mono { font-family: monospace; }
            .num { text-align: right; font-weight: bold; white-space: nowrap; }
            .total { text-align: right; font-weight: bold; margin-top: 8px; font-size: 13px; }
            .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
            .sig-block { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
            .sig-title { font-weight: bold; font-size: 10px; text-transform: uppercase; color: #475569; margin-bottom: 4px; }
            .sig-meta { font-size: 10px; color: #64748b; margin-top: 4px; text-align: center; }
            .btn-print { display: block; width: 100%; padding: 10px; background: #0f172a; color: #fff; border: none; font-weight: bold; text-align: center; cursor: pointer; margin-top: 18px; text-transform: uppercase; border-radius: 6px; }
            @media print { .btn-print { display: none; } body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">Comprovante de Transferência entre Empresas</div>
            <div>Central Stoque</div>
            <div class="status">${STATUS_LABELS[t.status] || t.status}</div>
          </div>

          <div class="row"><span class="label">Origem:</span><span>${t.sourceCompanyName || "—"}</span></div>
          <div class="row"><span class="label">Destino:</span><span>${t.destinationCompanyName || "—"}</span></div>
          <div class="row"><span class="label">Solicitado por:</span><span>${t.requestedByName || "—"}</span></div>
          <div class="row"><span class="label">Data do pedido:</span><span>${formatDate(t.requestedAt)}</span></div>
          ${t.scheduledFor ? `<div class="row"><span class="label">Agendado para:</span><span>${formatDate(t.scheduledFor)}</span></div>` : ""}
          <div class="row"><span class="label">Motivo:</span><span>${t.reason || "—"}</span></div>
          ${t.status === "CANCELADO" ? `<div class="row"><span class="label">Cancelado por:</span><span>${t.cancelledByName || "—"} — ${t.cancelReason || "sem motivo"}</span></div>` : ""}

          <div class="divider"></div>

          <table>
            <thead><tr><th>SKU</th><th>Pneu</th><th>Medida</th><th style="text-align:right">Qtde</th></tr></thead>
            <tbody>${itemRows || `<tr><td colspan="4">Nenhum item</td></tr>`}</tbody>
          </table>
          <div class="total">Total: ${totalUnitsOf(t)} un em ${(t.items || []).length} ${(t.items || []).length === 1 ? "produto" : "produtos"}</div>

          <div class="divider"></div>

          <div class="sig-grid">
            ${resolveSignatures(t).map(s => renderSignatureBlock(s.label, s.sig)).join("")}
          </div>

          <button class="btn-print" onclick="window.print()">Imprimir</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // ── Relatorio do historico inteiro (a lista filtrada em uma folha so) ──
  const handlePrintReport = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const signerOf = (t: TransferOrder, kind: "out" | "in") =>
      kind === "out"
        ? (t.dispatch?.sender?.signedByName || t.delivery?.signedByName || "—")
        : (t.arrival?.receiver?.signedByName || t.receipt?.signedByName || "—");

    const driverOf = (t: TransferOrder) =>
      t.dispatch?.driver?.signedByName || t.arrival?.driver?.signedByName || "—";

    const rows = filteredTransfers.map(t => `
      <tr>
        <td class="mono">${formatDate(t.requestedAt)}</td>
        <td><span class="badge">${STATUS_LABELS[t.status] || t.status}</span></td>
        <td>${t.sourceCompanyName || "—"} <span class="arrow">&rarr;</span> ${t.destinationCompanyName || "—"}</td>
        <td>${(t.items || []).map(i => `${i.quantity}x ${i.sku} ${i.brand} ${i.model} (${i.size})`).join("<br/>") || "—"}</td>
        <td class="num">${totalUnitsOf(t)}</td>
        <td>${t.requestedByName || "—"}</td>
        <td>${signerOf(t, "out")}</td>
        <td>${driverOf(t)}</td>
        <td>${signerOf(t, "in")}</td>
      </tr>
    `).join("");

    const totalUnits = filteredTransfers.reduce((acc, t) => acc + totalUnitsOf(t), 0);
    const concluded = filteredTransfers.filter(t => t.status === "CONCLUIDO").length;
    const inTransit = filteredTransfers.filter(t => t.status === "EM_TRANSITO").length;

    printWindow.document.write(`
      <html>
        <head>
          <title>Relatório de Transferências - Central Stoque</title>
          <style>
            @page { size: A4 landscape; margin: 12mm; }
            body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1e293b; padding: 16px; }
            .header { border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
            .title { font-weight: bold; font-size: 17px; text-transform: uppercase; }
            .sub { color: #64748b; font-size: 11px; margin-top: 3px; }
            .summary { display: flex; gap: 22px; margin-bottom: 12px; }
            .kpi { border: 1px solid #e2e8f0; border-radius: 6px; padding: 7px 12px; }
            .kpi b { display: block; font-size: 16px; }
            .kpi span { font-size: 9px; text-transform: uppercase; color: #64748b; letter-spacing: .5px; }
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; font-size: 9px; text-transform: uppercase; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; padding: 6px 5px; }
            td { padding: 6px 5px; border: 1px solid #e2e8f0; vertical-align: top; font-size: 10px; }
            tr { page-break-inside: avoid; }
            .mono { font-family: monospace; white-space: nowrap; }
            .num { text-align: right; font-weight: bold; }
            .arrow { color: #94a3b8; }
            .badge { display: inline-block; padding: 2px 7px; border: 1px solid #cbd5e1; border-radius: 999px; font-size: 9px; font-weight: bold; text-transform: uppercase; white-space: nowrap; }
            .footer { margin-top: 14px; font-size: 9px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 8px; }
            .btn-print { display: block; width: 220px; padding: 10px; background: #0f172a; color: #fff; border: none; font-weight: bold; text-align: center; cursor: pointer; margin: 18px auto 0; text-transform: uppercase; border-radius: 6px; }
            @media print { .btn-print { display: none; } body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="title">Relatório de Transferências entre Empresas</div>
              <div class="sub">Central Stoque — emitido em ${formatDate(new Date())} por ${user.displayName}</div>
              <div class="sub">Período: ${periodLabel} | Empresa: ${companyFilter ? (companies.find(c => c.id === companyFilter)?.name || "—") : "Todas"} | Status: ${statusFilter === "ALL" ? "Todos" : statusFilter === "ACAO_NECESSARIA" ? "Aguardando minha ação" : (STATUS_LABELS[statusFilter as TransferStatus] || statusFilter)}</div>
            </div>
            <div class="sub">${filteredTransfers.length} ${filteredTransfers.length === 1 ? "pedido" : "pedidos"}</div>
          </div>

          <div class="summary">
            <div class="kpi"><b>${filteredTransfers.length}</b><span>Pedidos</span></div>
            <div class="kpi"><b>${totalUnits}</b><span>Pneus movimentados</span></div>
            <div class="kpi"><b>${concluded}</b><span>Concluídos</span></div>
            <div class="kpi"><b>${inTransit}</b><span>Em trânsito</span></div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Data do Pedido</th>
                <th>Status</th>
                <th>Origem &rarr; Destino</th>
                <th>Itens</th>
                <th style="text-align:right">Qtde</th>
                <th>Solicitante</th>
                <th>Assin. Entrega</th>
                <th>Motorista</th>
                <th>Assin. Recebimento</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="9">Nenhuma transferência no filtro atual.</td></tr>`}</tbody>
          </table>

          <div class="footer">
            Documento gerado pelo Central Stoque — histórico auditado de transferências entre empresas.
          </div>

          <button class="btn-print" onclick="window.print()">Imprimir Relatório</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // ── CSV export of the transfer ledger itself (requester + both signers) ──
  const handleExportCSV = () => {
    const columns = [
      { key: "requestedAtFormatted", label: "Data do Pedido" },
      { key: "items", label: "Itens" },
      { key: "totalUnits", label: "Total de Pneus" },
      { key: "sourceCompanyName", label: "Empresa Origem" },
      { key: "destinationCompanyName", label: "Empresa Destino" },
      { key: "requestedByName", label: "Solicitado Por" },
      { key: "statusLabel", label: "Status" },
      { key: "scheduledForFormatted", label: "Agendado Para" },
      { key: "deliverySignerName", label: "Assinatura Entrega - Nome" },
      { key: "deliverySignedAtFormatted", label: "Assinatura Entrega - Data" },
      { key: "driverPickupName", label: "Motorista - Retirada" },
      { key: "driverPickupMethod", label: "Retirada - Forma da Assinatura" },
      { key: "driverDropoffName", label: "Motorista - Entrega" },
      { key: "driverDropoffMethod", label: "Entrega - Forma da Assinatura" },
      { key: "receiptSignerName", label: "Assinatura Recebimento - Nome" },
      { key: "receiptSignedAtFormatted", label: "Assinatura Recebimento - Data" },
      { key: "reason", label: "Motivo" }
    ];

    // Deliberately excludes the raw base64 signature images — only presence/name/time.
    const dataToExport = filteredTransfers.map(t => ({
      requestedAtFormatted: formatDate(t.requestedAt),
      items: (t.items || []).map(i => `${i.quantity}x [${i.sku}] ${i.brand} ${i.model} (${i.size})`).join(" | "),
      totalUnits: totalUnitsOf(t),
      sourceCompanyName: t.sourceCompanyName,
      destinationCompanyName: t.destinationCompanyName,
      requestedByName: t.requestedByName,
      statusLabel: STATUS_LABELS[t.status] || t.status,
      scheduledForFormatted: t.scheduledFor ? formatDate(t.scheduledFor) : "",
      deliverySignerName: t.dispatch?.sender?.signedByName || t.delivery?.signedByName || "",
      deliverySignedAtFormatted: t.dispatch?.sender ? formatDate(t.dispatch.sender.signedAt) : (t.delivery ? formatDate(t.delivery.signedAt) : ""),
      driverPickupName: t.dispatch?.driver?.signedByName || "",
      driverPickupMethod: METHOD_LABELS[t.dispatch?.driver?.method || ""] || "",
      driverDropoffName: t.arrival?.driver?.signedByName || "",
      driverDropoffMethod: METHOD_LABELS[t.arrival?.driver?.method || ""] || "",
      receiptSignerName: t.arrival?.receiver?.signedByName || t.receipt?.signedByName || "",
      receiptSignedAtFormatted: t.arrival?.receiver ? formatDate(t.arrival.receiver.signedAt) : (t.receipt ? formatDate(t.receipt.signedAt) : ""),
      reason: t.reason
    }));

    exportToCSV(dataToExport, columns, `Central_Stoque_Transferencias_${Date.now()}`);
  };

  return (
    <div className="space-y-6">
      {/* Control bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 font-sans">
        <div className="relative flex-1 max-w-md">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
            <Search size={16} className="text-gold-600" />
          </div>
          <input
            type="text"
            placeholder="Pesquise por SKU, medida, empresa ou solicitante..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-9 pr-3 py-2 w-full border border-slate-200 rounded-xl bg-slate-50/50 text-slate-900 font-semibold text-xs focus:bg-white focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as any)}
            className="bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-slate-900 font-bold text-xs cursor-pointer"
          >
            <option value="ALL">Todos os Status</option>
            <option value="ACAO_NECESSARIA">Aguardando Minha Ação</option>
            <option value="AGENDADO">Agendados</option>
            <option value="PENDENTE">Aguardando Envio</option>
            <option value="EM_TRANSITO">Em Trânsito</option>
            <option value="CONCLUIDO">Concluídos</option>
            <option value="CANCELADO">Cancelados</option>
          </select>

          <button
            onClick={handleExportCSV}
            disabled={filteredTransfers.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2 font-black text-xs rounded-xl text-white bg-gradient-to-r from-gold-600 to-amber-500 hover:from-gold-700 hover:to-amber-600 disabled:opacity-40 border border-gold-400/20 transition-all shadow-md shadow-gold-500/10 cursor-pointer hover:scale-[1.01]"
          >
            <Download size={14} className="stroke-[2.5px]" /> Exportar CSV
          </button>

          <button
            onClick={handlePrintReport}
            disabled={filteredTransfers.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2 font-black text-xs rounded-xl text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 transition-all shadow-sm cursor-pointer hover:scale-[1.01]"
            title="Imprimir o histórico de transferências conforme os filtros atuais"
          >
            <Printer size={14} className="stroke-[2.5px]" /> Imprimir Histórico
          </button>

          {canCreate && (
            <button
              onClick={openCreateModal}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer"
            >
              <Plus size={14} className="stroke-[3px]" /> Nova Transferência
            </button>
          )}
        </div>
      </div>

      {/* Filtros de período e empresa do histórico */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col lg:flex-row lg:items-center gap-3 font-sans">
        <div className="flex items-center gap-2 shrink-0">
          <Calendar size={15} className="text-gold-600" />
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">Período</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {([
            { value: "ALL", label: "Tudo" },
            { value: "TODAY", label: "Hoje" },
            { value: "7D", label: "7 dias" },
            { value: "30D", label: "30 dias" },
            { value: "CUSTOM", label: "Escolher datas" }
          ] as const).map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPeriodFilter(opt.value)}
              className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-colors cursor-pointer ${
                periodFilter === opt.value
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {periodFilter === "CUSTOM" && (
          <div className="flex items-center gap-2 animate-fadeIn">
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={e => setDateFrom(e.target.value)}
              className="px-2.5 py-1.5 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-semibold"
            />
            <span className="text-[10px] font-black text-slate-400 uppercase">até</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={e => setDateTo(e.target.value)}
              className="px-2.5 py-1.5 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-semibold"
            />
          </div>
        )}

        <div className="flex items-center gap-2 lg:ml-auto shrink-0">
          <Building2 size={15} className="text-gold-600" />
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-slate-900 font-bold text-[11px] cursor-pointer max-w-[220px]"
            title="Mostra apenas as transferências em que esta empresa é a origem ou o destino"
          >
            <option value="">Todas as empresas</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Transfer list */}
      {filteredTransfers.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-14 flex flex-col items-center justify-center text-center text-slate-400">
          <ArrowLeftRight size={44} className="stroke-[1.5px] text-slate-200 mb-2" />
          <p className="font-bold text-slate-800 text-base">Nenhuma transferência encontrada</p>
          <p className="text-xs text-slate-500 mt-1 px-4 max-w-sm">
            Pedidos de transferência de estoque entre empresas, com assinatura de quem entrega e de quem recebe, aparecerão aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTransfers.map(t => {
            const isProcessing = processingId === t.id;
            return (
              <div key={t.id} className={`bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4 transition-opacity ${isProcessing ? "opacity-60" : ""}`}>
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 w-full">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span className={`inline-block px-2 py-0.5 rounded-lg text-[9px] font-black border uppercase tracking-wider ${STATUS_BADGE_STYLES[t.status]}`}>
                        {STATUS_LABELS[t.status]}
                      </span>
                    </div>

                    <div className="flex flex-col gap-1.5 w-full">
                      {(t.items || []).map((item, idx) => (
                        <div key={idx} className="flex items-start justify-between w-full p-2 bg-slate-50/50 rounded-lg border border-slate-100">
                          <div className="flex flex-col">
                            <span className="font-mono text-xs font-black text-slate-800">
                              {item.sku}
                            </span>
                            <span className="text-[11px] font-bold text-slate-700">
                              {item.brand} {item.model} <span className="font-mono text-slate-400">({item.size})</span>
                            </span>
                          </div>
                          <span className="ml-2 px-2 py-0.5 bg-white border border-slate-200 rounded text-[11px] font-mono font-bold text-slate-700 shrink-0 shadow-sm">
                            {item.quantity} un
                          </span>
                        </div>
                      ))}
                    </div>
                    
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600 flex-wrap mt-2">
                      <Building2 size={13} className="text-slate-400 shrink-0" /> {t.sourceCompanyName}
                      <ArrowRight size={13} className="text-gold-500 shrink-0" />
                      <Building2 size={13} className="text-slate-400 shrink-0" /> {t.destinationCompanyName}
                    </div>
                  </div>

                  <div className="text-right text-[10px] text-slate-400 font-semibold space-y-0.5 shrink-0">
                    <div className="flex items-center gap-1 justify-end">
                      <User size={11} className="text-gold-600" /> {t.requestedByName}
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                      <Calendar size={11} className="text-gold-600" /> {formatDate(t.requestedAt)}
                    </div>
                    {t.status === "AGENDADO" && t.scheduledFor && (
                      <div className="flex items-center gap-1 justify-end text-amber-600 font-bold">
                        <Clock size={11} /> Agendado: {formatDate(t.scheduledFor)}
                      </div>
                    )}
                  </div>
                </div>

                {t.reason && (
                  <p className="text-xs text-slate-500 font-medium border-l-2 border-slate-200 pl-2.5">{t.reason}</p>
                )}

                {/* Signature status strip: mostra as DUAS vias de cada ponta,
                    inclusive o estado intermediario "interna assinada, motorista
                    pendente" — antes esta faixa lia dispatch.driver direto e
                    quebrava assim que a via interna existia sozinha. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {([
                    {
                      key: "dispatch",
                      label: "Assinaturas de Envio",
                      icon: <Truck size={16} />,
                      internal: t.dispatch?.sender || t.delivery || null,
                      internalRole: "Remetente",
                      driver: t.dispatch?.driver || null,
                      legacy: !t.dispatch && !!t.delivery
                    },
                    {
                      key: "arrival",
                      label: "Assinaturas de Recebimento",
                      icon: <PackageCheck size={16} />,
                      internal: t.arrival?.receiver || t.receipt || null,
                      internalRole: "Recebedor",
                      driver: t.arrival?.driver || null,
                      legacy: !t.arrival && !!t.receipt
                    }
                  ] as const).map(block => {
                    const complete = !!block.internal && (!!block.driver || block.legacy);
                    const partial = !!block.internal && !complete;
                    return (
                      <div
                        key={block.key}
                        className={`rounded-xl border p-2.5 flex flex-col gap-2 ${
                          complete ? "border-emerald-200 bg-emerald-50/40"
                          : partial ? "border-amber-200 bg-amber-50/40"
                          : "border-slate-200 bg-slate-50/40"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className={complete ? "text-emerald-600" : partial ? "text-amber-600" : "text-slate-350"}>
                            {block.icon}
                          </span>
                          <div className="min-w-0 text-[10px] flex-1">
                            <div className="font-black uppercase tracking-wide text-slate-500">{block.label}</div>

                            {block.internal ? (
                              <div className="space-y-0.5 mt-0.5">
                                <div className="font-bold text-slate-700 truncate">
                                  {block.internalRole}: {block.internal.signedByName}
                                  {block.legacy && <span className="text-slate-400"> (legado)</span>}
                                </div>
                                {block.driver ? (
                                  <div className="font-bold text-slate-700 truncate">
                                    Motorista: {block.driver.signedByName}
                                    {block.driver.method === "FOTO" && <span className="text-slate-400"> (papel)</span>}
                                    {block.driver.method === "LINK" && <span className="text-slate-400"> (link)</span>}
                                  </div>
                                ) : !block.legacy && (
                                  <div className="font-black text-amber-700 truncate flex items-center gap-1">
                                    <Clock size={10} className="shrink-0" /> Aguardando assinatura do motorista
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="font-bold text-slate-700 truncate">Aguardando</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {t.status === "CANCELADO" && t.cancelReason && (
                  <div className="flex items-start gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded-xl p-2.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span><strong>{t.cancelledByName}</strong> cancelou: {t.cancelReason}</span>
                  </div>
                )}

                {/* Action buttons */}
                {!isVendedor && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {canSignSender(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setSignatureTarget({ transfer: t, mode: "delivery" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isProcessing ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />} Assinar Envio
                      </button>
                    )}
                    {canCollectDispatchDriver(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setDriverTarget({ transfer: t, stage: "DISPATCH" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Truck size={13} /> Assinatura do Motorista
                      </button>
                    )}
                    {canSignReceiver(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setSignatureTarget({ transfer: t, mode: "receipt" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isProcessing ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />} Assinar Recebimento
                      </button>
                    )}
                    {canCollectArrivalDriver(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setDriverTarget({ transfer: t, stage: "ARRIVAL" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Truck size={13} /> Assinatura do Motorista
                      </button>
                    )}
                    {canCancel(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => handleCancelClick(t)}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-red-200 text-red-600 hover:bg-red-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Ban size={13} /> Cancelar
                      </button>
                    )}
                    {t.status === "CONCLUIDO" && (
                      <button
                        onClick={() => handlePrintReceipt(t)}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer"
                      >
                        <Printer size={13} /> Comprovante
                      </button>
                    )}
                    {canReverse(t) && onReverseTransfer && (
                      <button
                        disabled={isProcessing}
                        onClick={() => handleReverseClick(t)}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-amber-200 text-amber-700 hover:bg-amber-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50 ml-auto"
                        title="Estornar transferência abandonada em trânsito (somente administrador)"
                      >
                        <RotateCcw size={13} /> Estornar (Admin)
                      </button>
                    )}
                    {isGlobalAdmin && onDeleteTransfer && (
                      <button
                        disabled={isProcessing}
                        onClick={() => handleDeleteClick(t)}
                        title="Excluir permanentemente este pedido (somente administrador)"
                        className={`flex items-center gap-1.5 px-3.5 py-2 border border-red-200 text-red-600 hover:bg-red-50 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50 ${canReverse(t) ? "" : "ml-auto"}`}
                      >
                        <Trash2 size={13} /> Excluir
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ============ ASSINATURA INTERNA (remetente / recebedor) ============ */}
      {signatureTarget && (
        <SignaturePad
          title={signatureTarget.mode === "delivery" ? "Assinatura de Envio" : "Assinatura de Recebimento"}
          subtitle={`Pedido com ${signatureTarget.transfer.items?.length || 0} ${
            (signatureTarget.transfer.items?.length || 0) === 1 ? "item" : "itens"
          } • ${
            signatureTarget.mode === "delivery"
              ? `Saindo de ${signatureTarget.transfer.sourceCompanyName}`
              : `Recebendo em ${signatureTarget.transfer.destinationCompanyName}`
          }`}
          roleLabel={signatureTarget.mode === "delivery" ? "Assinatura do Remetente" : "Assinatura do Recebedor"}
          signerName={user.displayName}
          confirmLabel="Confirmar minha assinatura"
          nextStepHint="Depois de confirmar, o sistema abre a coleta da assinatura do motorista — por link no WhatsApp ou papel impresso."
          onConfirm={handleConfirmInternalSignature}
          onClose={() => setSignatureTarget(null)}
        />
      )}

      {/* ============ ASSINATURA DO MOTORISTA (link ou papel) ============ */}
      {/* Resolve o pedido pela lista viva: driverTarget guarda o objeto do momento
          do clique, e a via interna acabou de ser gravada logo antes de abrir. */}
      {driverTarget && (
        <DriverSignature
          transfer={transfers.find(x => x.id === driverTarget.transfer.id) || driverTarget.transfer}
          stage={driverTarget.stage}
          user={user}
          onComplete={handleCompleteDriverSignature}
          onClose={() => setDriverTarget(null)}
        />
      )}

      {/* ============ NEW TRANSFER MODAL ============ */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full border border-slate-200 shadow-2xl space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <ArrowLeftRight size={16} className="text-gold-600" /> Nova Transferência entre Empresas
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {createError && (
              <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-semibold border-l-4 border-red-500">
                {createError}
              </div>
            )}

            <form onSubmit={handleSubmitCreate} className="space-y-4">
              {/* Source company */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Empresa de Origem *
                </label>
                <select
                  required
                  value={formSourceCompanyId}
                  onChange={e => {
                    setFormSourceCompanyId(e.target.value);
                    setFormSelectedStockItemId("");
                    setFormStockSearch("");
                  }}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                >
                  <option value="">Selecione a empresa que vai enviar o item</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Item picker */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Item a Transferir *
                </label>
                {selectedStockItem ? (
                  <div className="flex flex-col gap-3 p-3 rounded-xl border border-gold-300/40 bg-gold-50/30">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs">
                          <span className="font-mono font-extrabold text-gold-700">{selectedStockItem.sku}</span>{" "}
                          <span className="font-bold text-slate-800">{selectedStockItem.brand} {selectedStockItem.model}</span>{" "}
                          <span className="text-slate-400 font-mono">({selectedStockItem.size})</span>
                          <div className="text-[10px] text-slate-500 font-semibold mt-0.5">Saldo disponível: {selectedStockItem.quantity} un</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFormSelectedStockItemId("")}
                          className="text-[10px] font-black text-red-600 hover:underline cursor-pointer shrink-0 mt-0.5"
                        >
                          Alterar
                        </button>
                      </div>
                      
                      {createError && (
                        <div className="bg-red-50 text-red-700 p-2 rounded-lg text-[10px] font-bold border border-red-200">
                          {createError}
                        </div>
                      )}
                    
                      <div className="flex items-end gap-3 mt-2">
                        <div className="w-1/3">
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                            Qtd *
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={selectedStockItem.quantity}
                            value={formQuantity}
                            onChange={e => setFormQuantity(e.target.value)}
                            placeholder={`Máx. ${selectedStockItem.quantity}`}
                            className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleAddItem}
                          className="flex-1 py-2 bg-emerald-600 text-white rounded-xl text-xs font-extrabold hover:bg-emerald-700 transition-colors shadow-sm flex justify-center items-center gap-1"
                        >
                          <Plus size={14} /> Confirmar Item na Lista
                        </button>
                      </div>
                      <div className="text-[10px] text-slate-500 text-center mt-1">
                        Deseja transferir mais produtos? Confirme este primeiro e depois busque os outros.
                      </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                        <Search size={14} />
                      </div>
                      <input
                        type="text"
                        disabled={!effectiveSourceCompanyId}
                        placeholder={effectiveSourceCompanyId ? "Pesquise por SKU, marca, modelo ou medida..." : "Selecione a empresa de origem primeiro"}
                        value={formStockSearch}
                        onChange={e => setFormStockSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold disabled:bg-slate-50 disabled:text-slate-400"
                      />
                    </div>
                    {effectiveSourceCompanyId && (
                      <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                        {sourceStockOptions.length === 0 ? (
                          <div className="p-3 text-xs text-slate-400 font-semibold text-center">Nenhum item com saldo disponível encontrado.</div>
                        ) : (
                          sourceStockOptions.map(item => (
                            <button
                              type="button"
                              key={item.id}
                              onClick={() => {
                                setFormSelectedStockItemId(item.id);
                                setFormQuantity("1");
                              }}
                              className="w-full text-left p-2.5 hover:bg-gold-50/40 transition-colors cursor-pointer flex items-center justify-between gap-2"
                            >
                              <span className="text-xs min-w-0 truncate">
                                <span className="font-mono font-extrabold text-gold-700">{item.sku}</span>{" "}
                                <span className="font-bold text-slate-800">{item.brand} {item.model}</span>{" "}
                                <span className="text-slate-400 font-mono">({item.size})</span>
                              </span>
                              <span className="text-[10px] font-mono font-bold text-slate-500 shrink-0">{item.quantity} un</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-2 border border-slate-200 rounded-xl p-3 bg-slate-50">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">
                    Lista de Itens a Transferir ({formItems.length})
                  </label>
                  
                  {formItems.length === 0 ? (
                    <div className="text-center py-6 border-2 border-dashed border-slate-200 rounded-lg bg-white">
                      <p className="text-xs text-slate-500 font-bold">Nenhum item adicionado ainda.</p>
                      <p className="text-[10px] text-slate-400 mt-1">Pesquise um produto acima e clique em "Confirmar Item na Lista".</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {formItems.map(item => (
                        <div key={item.sourceStockItemId} className="flex justify-between items-center p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                          <div className="flex flex-col min-w-0 pr-2">
                            <span className="font-mono text-xs font-extrabold text-gold-700 truncate">{item.sku}</span>
                            <span className="text-xs font-bold text-slate-800 truncate">{item.brand} {item.model} <span className="font-mono text-slate-400">({item.size})</span></span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs font-black text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md border border-emerald-100 shadow-sm">{item.quantity} un</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(item.sourceStockItemId)}
                              className="text-red-500 hover:text-red-600 transition-colors bg-red-50 p-1.5 rounded-md border border-red-100 hover:border-red-200"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5 mt-2">
                    Empresa de Destino *
                  </label>
                  <select
                    required
                    value={formDestinationCompanyId}
                    onChange={e => setFormDestinationCompanyId(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  >
                    <option value="">Selecione</option>
                    {destinationOptions.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Motivo / Observações
                </label>
                <textarea
                  rows={2}
                  value={formReason}
                  onChange={e => setFormReason(e.target.value)}
                  placeholder="Ex: Reposição de estoque para a filial X"
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold resize-none"
                />
              </div>

              <div className="border-t border-slate-100 pt-3 space-y-2.5">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={formIsScheduled}
                    onChange={e => setFormIsScheduled(e.target.checked)}
                    className="rounded text-gold-600 focus:ring-gold-500 h-4 w-4 border-slate-300 cursor-pointer"
                  />
                  <span className="text-xs font-bold text-slate-600">Agendar para uma data/hora futura</span>
                </label>
                {formIsScheduled && (
                  <input
                    type="datetime-local"
                    required={formIsScheduled}
                    value={formScheduledFor}
                    onChange={e => setFormScheduledFor(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                )}
                {formIsScheduled && (
                  <p className="text-[10px] text-slate-400 font-semibold leading-relaxed">
                    💡 O pedido ficará "Agendado" e só poderá ser assinado a partir da data/hora escolhida (com o app aberto em algum dispositivo naquele momento).
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-60"
                >
                  {createLoading && <Loader2 size={12} className="animate-spin" />}
                  {formIsScheduled ? "Agendar Transferência" : "Criar Pedido de Transferência"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
