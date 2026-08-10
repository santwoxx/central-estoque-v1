import { useMemo, useState } from "react";
import { StockItem, Company, TransferOrder, TransferStatus, UserRole } from "../types";
import { exportToCSV, formatDate } from "../utils";
import SignaturePad from "./SignaturePad";
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
  Trash2
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
  onSignDelivery: (transferId: string, internalSignature: string, driverSignature: string, driverName: string) => Promise<void>;
  onSignReceipt: (transferId: string, internalSignature: string, driverSignature: string, driverName: string) => Promise<void>;
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
  onSignDelivery,
  onSignReceipt,
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
  const [processingId, setProcessingId] = useState("");

  const isSourceOf = (t: TransferOrder) => isAdmin || (isAlimentador && user.companyId === t.sourceCompanyId);
  const isDestinationOf = (t: TransferOrder) => isAdmin || (isAlimentador && user.companyId === t.destinationCompanyId);
  const canSignDelivery = (t: TransferOrder) => t.status === "PENDENTE" && isSourceOf(t);
  const canSignReceipt = (t: TransferOrder) => t.status === "EM_TRANSITO" && isDestinationOf(t);
  const canCancel = (t: TransferOrder) => (t.status === "AGENDADO" || t.status === "PENDENTE") && (isSourceOf(t) || isDestinationOf(t));
  const canReverse = (t: TransferOrder) => t.status === "EM_TRANSITO" && isAdmin;

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
        item.size.toLowerCase().includes(lower)
      )
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .slice(0, 60);
  }, [stock, effectiveSourceCompanyId, formStockSearch]);

  const selectedStockItem = stock.find(item => item.id === formSelectedStockItemId) || null;
  const destinationOptions = companies.filter(c => c.id !== effectiveSourceCompanyId);

  // ── Filtering / sorting the transfer list ───────────────────────
  const filteredTransfers = useMemo(() => {
    return transfers.filter(t => {
      const itemStr = (t.items || []).map(i => i.sku + i.brand + i.model).join("").toLowerCase();
      const matchesSearch =
        searchTerm === "" ||
        itemStr.includes(searchTerm.toLowerCase()) ||
        t.sourceCompanyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.destinationCompanyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.requestedByName.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "ALL" ||
        (statusFilter === "ACAO_NECESSARIA" ? canSignDelivery(t) || canSignReceipt(t) : t.status === statusFilter);

      return matchesSearch && matchesStatus;
    });
  }, [transfers, searchTerm, statusFilter]);

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
    if (!isAdmin && effectiveSourceCompanyId !== user.companyId && formDestinationCompanyId !== user.companyId) {
      setCreateError("Você só pode criar transferências enviando ou recebendo para a sua própria empresa.");
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
  const handleConfirmSignature = async (internalSignature: string, driverSignature: string, driverName: string) => {
    if (!signatureTarget) return;
    const { transfer, mode } = signatureTarget;
    setProcessingId(transfer.id);
    try {
      if (mode === "delivery") {
        await onSignDelivery(transfer.id, internalSignature, driverSignature, driverName);
      } else {
        await onSignReceipt(transfer.id, internalSignature, driverSignature, driverName);
      }
      setSignatureTarget(null);
    } catch (err: any) {
      alert(err.message || "Erro ao registrar assinatura.");
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

  // ── Printable dual-signature receipt (mirrors StockTable's thermal receipt pattern) ──
  const handlePrintReceipt = (t: TransferOrder) => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const renderSignatureBlock = (label: string, sig?: TransferOrder["delivery"]) => {
      const img = sig?.signatureDataUrl
        ? `<img src="${sig.signatureDataUrl}" alt="${label}" style="max-width:100%;height:80px;object-fit:contain;display:block;margin:0 auto;" />`
        : `<div style="height:80px;display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;">Assinatura pendente</div>`;
      const meta = sig ? `${sig.signedByName} — ${formatDate(sig.signedAt)}` : "—";
      return `
        <div class="sig-block">
          <div class="sig-title">${label}</div>
          ${img}
          <div class="sig-meta">${meta}</div>
        </div>
      `;
    };

    printWindow.document.write(`
      <html>
        <head>
          <title>Comprovante de Transferência - Central Estoque</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; max-width: 480px; margin: auto; padding: 24px; }
            .header { text-align: center; border-bottom: 2px dashed #ccc; padding-bottom: 12px; margin-bottom: 16px; }
            .title { font-weight: bold; font-size: 16px; text-transform: uppercase; }
            .row { display: flex; justify-content: space-between; margin: 4px 0; gap: 12px; }
            .label { color: #64748b; font-weight: bold; white-space: nowrap; }
            .divider { border-top: 1px dashed #ccc; margin: 14px 0; }
            .sig-block { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
            .sig-title { font-weight: bold; font-size: 11px; text-transform: uppercase; color: #475569; margin-bottom: 6px; }
            .sig-meta { font-size: 10px; color: #64748b; margin-top: 6px; text-align: center; }
            .btn-print { display: block; width: 100%; padding: 10px; background: #0f172a; color: #fff; border: none; font-weight: bold; text-align: center; cursor: pointer; margin-top: 18px; text-transform: uppercase; border-radius: 6px; }
            @media print { .btn-print { display: none; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">Comprovante de Transferência entre Empresas</div>
            <div>Central Stoque</div>
          </div>

          <div class="row"><span class="label">Itens:</span><span>${(t.items || []).map(i => `[${i.sku}] ${i.brand} ${i.model} — ${i.size} (${i.quantity} un)`).join("<br/>")}</span></div>
          <div class="row"><span class="label">Origem:</span><span>${t.sourceCompanyName}</span></div>
          <div class="row"><span class="label">Destino:</span><span>${t.destinationCompanyName}</span></div>
          <div class="row"><span class="label">Solicitado por:</span><span>${t.requestedByName}</span></div>
          <div class="row"><span class="label">Data do pedido:</span><span>${formatDate(t.requestedAt)}</span></div>
          <div class="row"><span class="label">Motivo:</span><span>${t.reason || "—"}</span></div>

          <div class="divider"></div>

          ${renderSignatureBlock("Assinatura de Entrega (Origem)", t.delivery || undefined)}
          ${renderSignatureBlock("Assinatura de Recebimento (Destino)", t.receipt || undefined)}

          <button class="btn-print" onclick="window.print()">Imprimir</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // ── CSV export of the transfer ledger itself (requester + both signers) ──
  const handleExportCSV = () => {
    const columns = [
      { key: "requestedAtFormatted", label: "Data do Pedido" },
      { key: "sku", label: "SKU" },
      { key: "itemDescription", label: "Item" },
      { key: "quantity", label: "Quantidade" },
      { key: "sourceCompanyName", label: "Empresa Origem" },
      { key: "destinationCompanyName", label: "Empresa Destino" },
      { key: "requestedByName", label: "Solicitado Por" },
      { key: "statusLabel", label: "Status" },
      { key: "scheduledForFormatted", label: "Agendado Para" },
      { key: "deliverySignerName", label: "Assinatura Entrega - Nome" },
      { key: "deliverySignedAtFormatted", label: "Assinatura Entrega - Data" },
      { key: "receiptSignerName", label: "Assinatura Recebimento - Nome" },
      { key: "receiptSignedAtFormatted", label: "Assinatura Recebimento - Data" },
      { key: "reason", label: "Motivo" }
    ];

    // Deliberately excludes the raw base64 signature images — only presence/name/time.
    const dataToExport = filteredTransfers.map(t => ({
      requestedAtFormatted: formatDate(t.requestedAt),
      items: (t.items || []).map(i => i.quantity + "x " + i.brand + " " + i.model).join("; "),
      sourceCompanyName: t.sourceCompanyName,
      destinationCompanyName: t.destinationCompanyName,
      requestedByName: t.requestedByName,
      statusLabel: STATUS_LABELS[t.status] || t.status,
      scheduledForFormatted: t.scheduledFor ? formatDate(t.scheduledFor) : "",
      deliverySignerName: t.delivery?.signedByName || "",
      deliverySignedAtFormatted: t.delivery ? formatDate(t.delivery.signedAt) : "",
      receiptSignerName: t.receipt?.signedByName || "",
      receiptSignedAtFormatted: t.receipt ? formatDate(t.receipt.signedAt) : "",
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
            placeholder="Pesquise por SKU, empresa ou solicitante..."
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

                {/* Signature status strip */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className={`rounded-xl border p-2.5 flex flex-col gap-2 ${t.dispatch || t.delivery ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-slate-50/40"}`}>
                    <div className="flex items-center gap-2.5">
                      <Truck size={16} className={t.dispatch || t.delivery ? "text-emerald-600" : "text-slate-350"} />
                      <div className="min-w-0 text-[10px]">
                        <div className="font-black uppercase tracking-wide text-slate-500">Assinaturas de Envio</div>
                        <div className="font-bold text-slate-700 truncate">
                          {t.dispatch ? (
                            <span>{t.dispatch.sender.signedByName} + Motorista: {t.dispatch.driver.signedByName}</span>
                          ) : t.delivery ? (
                            <span>{t.delivery.signedByName} (Legado)</span>
                          ) : "Aguardando"}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={`rounded-xl border p-2.5 flex flex-col gap-2 ${t.arrival || t.receipt ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-slate-50/40"}`}>
                    <div className="flex items-center gap-2.5">
                      <PackageCheck size={16} className={t.arrival || t.receipt ? "text-emerald-600" : "text-slate-350"} />
                      <div className="min-w-0 text-[10px]">
                        <div className="font-black uppercase tracking-wide text-slate-500">Assinaturas de Recebimento</div>
                        <div className="font-bold text-slate-700 truncate">
                          {t.arrival ? (
                            <span>{t.arrival.receiver.signedByName} + Motorista: {t.arrival.driver.signedByName}</span>
                          ) : t.receipt ? (
                            <span>{t.receipt.signedByName} (Legado)</span>
                          ) : "Aguardando"}
                        </div>
                      </div>
                    </div>
                  </div>
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
                    {canSignDelivery(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setSignatureTarget({ transfer: t, mode: "delivery" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isProcessing ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />} Assinar Envio
                      </button>
                    )}
                    {canSignReceipt(t) && (
                      <button
                        disabled={isProcessing}
                        onClick={() => setSignatureTarget({ transfer: t, mode: "receipt" })}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white font-black rounded-xl text-[11px] shadow-sm transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isProcessing ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />} Assinar Recebimento
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
                    {isAdmin && onDeleteTransfer && (
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

      {/* ============ SIGNATURE MODAL ============ */}
      {signatureTarget && (
        <SignaturePad
          mode={signatureTarget.mode}
          subtitle={`Pedido com ${signatureTarget.transfer.items?.length || 0} itens • ${
            signatureTarget.mode === "delivery"
              ? `Saindo de ${signatureTarget.transfer.sourceCompanyName}`
              : `Recebendo em ${signatureTarget.transfer.destinationCompanyName}`
          }`}
          onConfirm={handleConfirmSignature}
          onClose={() => setSignatureTarget(null)}
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
                        placeholder={effectiveSourceCompanyId ? "Pesquise por SKU, marca ou modelo..." : "Selecione a empresa de origem primeiro"}
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
