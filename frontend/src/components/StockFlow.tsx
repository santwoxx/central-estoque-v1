import { useEffect, useMemo, useRef, useState } from "react";
import {
  StockItem,
  MovementLog,
  Company,
  UserRole,
  StockFlowType,
  StockFlowPayload,
  StockFlowResult,
  TransferOrder,
  TransferSyncResult
} from "../types";
import { availableQuantity, exportToCSV, formatBRL, formatDate, matchesTireSize, QUICK_QTY, reservedQuantityOf, STOCK_FLOW_REASONS, toMillis } from "../utils";
import {
  PackagePlus,
  PackageMinus,
  Search,
  Plus,
  Minus,
  X,
  Trash2,
  Loader2,
  CheckCircle2,
  Printer,
  Download,
  History,
  Calendar,
  User,
  Building2,
  AlertTriangle,
  RotateCcw,
  Boxes,
  ChevronDown,
  ChevronRight,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  RefreshCw,
  Keyboard,
  Info,
  ClipboardList,
  Lock
} from "lucide-react";

interface StockFlowProps {
  stock: StockItem[];
  movements: MovementLog[];
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  // Pedidos de transferência já assinados — usados só para conferir se cada um
  // deixou a sua linha no histórico (saída na origem, entrada no destino).
  transfers?: TransferOrder[];
  onRegister: (payload: StockFlowPayload) => Promise<StockFlowResult>;
  onReverse?: (operationId: string) => Promise<void>;
  onSyncTransfers?: () => Promise<TransferSyncResult>;
}

// Quais movimentos representam entrada/saida FISICA de pneu e, por isso,
// aparecem no historico desta tela. A transferencia entre filiais conta: o pneu
// sai de verdade da origem e entra de verdade no destino — cada empresa precisa
// ver a sua metade aqui. IMPORTACAO e AJUSTE ficam de fora (carga inicial e
// correcao de saldo, nao operacao de balcao).
const FLOW_TYPE_OF: Partial<Record<MovementLog["type"], StockFlowType>> = {
  ENTRADA: "ENTRADA",
  SAIDA: "SAIDA",
  TRANSFERENCIA_ENTRADA: "ENTRADA",
  TRANSFERENCIA_SAIDA: "SAIDA"
};

const isTransferType = (type: MovementLog["type"]) =>
  type === "TRANSFERENCIA_ENTRADA" || type === "TRANSFERENCIA_SAIDA";

// A empresa do outro lado da transferencia vem do motivo gravado pelo modulo de
// Transferencias ("Recebido de X — assinado por Y" / "Transferência para X — ...").
// Sem correspondencia, devolve vazio — o motivo completo continua na tela.
const transferCounterpart = (reason: string) => {
  const match = reason.match(/^(?:Recebido de|Transfer[êe]ncia para)\s+(.+?)\s+—/);
  return match ? match[1].trim() : "";
};

interface CartLine {
  stockItemId: string;
  quantity: number;
  unitPrice: number;
}

// Uma "operação" do histórico: todos os movimentos que compartilham o mesmo
// operationId. Movimentos antigos (gravados por outras telas, sem operationId)
// viram operações de um item só, para o histórico continuar completo.
interface FlowOperation {
  key: string;
  operationId: string;
  type: StockFlowType;
  logs: MovementLog[];
  timestamp: number;
  totalUnits: number;
  totalAmount: number;
  userEmail: string;
  companyName: string;
  reason: string;
  docNumber: string;
  partyName: string;
  vehiclePlate: string;
  observation: string;
  reversalOf: string;
  isModuleOperation: boolean;
  // Operacao originada no modulo de Transferencias (nao tem operationId e nao
  // pode ser estornada por aqui — o estorno vive na tela de Transferencias).
  isTransfer: boolean;
  transferId: string;
  // Registro recriado pela regularização: o saldo mostrado é o do momento do
  // reparo, não o da assinatura.
  rebuilt: boolean;
}

export default function StockFlow({ stock, movements, companies, user, transfers = [], onRegister, onReverse, onSyncTransfers }: StockFlowProps) {
  const isAdmin = user.role === "admin";
  const canOperate = isAdmin || user.role === "alimentador";

  // ── Estado da operação em andamento (gaveta aberta) ──────────────
  const [mode, setMode] = useState<StockFlowType | null>(null);
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [reasonChoice, setReasonChoice] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyDoc, setPartyDoc] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [observation, setObservation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [flashId, setFlashId] = useState("");
  const [receipt, setReceipt] = useState<StockFlowResult | null>(null);

  // ── Estado do histórico ──────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  // Conferência já rodou contra o servidor e não achou nada faltando: o aviso
  // some mesmo que a janela de movimentos carregada continue parecendo incompleta.
  const [syncCleared, setSyncCleared] = useState(false);
  const [histSearch, setHistSearch] = useState("");
  const [histType, setHistType] = useState<"ALL" | StockFlowType>("ALL");
  const [histPeriod, setHistPeriod] = useState<"TODAY" | "7D" | "30D" | "ALL">("7D");
  const [expandedKey, setExpandedKey] = useState("");
  const [reversingId, setReversingId] = useState("");

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Estoque que este usuário pode movimentar (admin enxerga tudo; dono só a sua empresa).
  const operableStock = useMemo(() => {
    const base = isAdmin ? stock : stock.filter(item => item.companyId === user.companyId);
    return companyFilter ? base.filter(item => item.companyId === companyFilter) : base;
  }, [stock, isAdmin, user.companyId, companyFilter]);

  // Lista do seletor: filtra pela busca e, na saída, esconde o que está zerado.
  const pickerItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return operableStock
      // Na saída, o que conta é o saldo LIVRE: pneu inteiramente reservado para
      // um cliente ou por uma transferência não pode ser baixado, então some da lista.
      .filter(item => (mode === "SAIDA" ? availableQuantity(item) > 0 : true))
      .filter(item =>
        !term ||
        item.sku.toLowerCase().includes(term) ||
        item.brand.toLowerCase().includes(term) ||
        item.model.toLowerCase().includes(term) ||
        item.size.toLowerCase().includes(term) ||
        (item.description || "").toLowerCase().includes(term) ||
        matchesTireSize(item.size, term)
      )
      .sort((a, b) => {
        const brandCmp = (a.brand || "").localeCompare(b.brand || "");
        if (brandCmp !== 0) return brandCmp;
        return (a.size || "").localeCompare(b.size || "");
      })
      .slice(0, 80);
  }, [operableStock, search, mode]);

  const stockById = useMemo(() => {
    const map = new Map<string, StockItem>();
    stock.forEach(item => map.set(item.id, item));
    return map;
  }, [stock]);

  // Carrinho resolvido contra o estoque atual (em tempo real: se outra pessoa
  // mexer no saldo enquanto a gaveta está aberta, o alerta aparece na hora).
  const cartLines = useMemo(() => {
    return cart
      .map(line => {
        const item = stockById.get(line.stockItemId);
        if (!item) return null;
        const free = availableQuantity(item);
        const exceeds = mode === "SAIDA" && line.quantity > free;
        // Distingue "não tem pneu" de "tem pneu, mas está prometido": a mensagem
        // de erro muda completamente para quem está no balcão.
        const blockedByReservation = mode === "SAIDA" && line.quantity > free && line.quantity <= item.quantity;
        return { ...line, item, exceeds, free, blockedByReservation };
      })
      .filter(Boolean) as {
        stockItemId: string;
        quantity: number;
        unitPrice: number;
        item: StockItem;
        exceeds: boolean;
        free: number;
        blockedByReservation: boolean;
      }[];
  }, [cart, stockById, mode]);

  const cartUnits = cartLines.reduce((acc, l) => acc + l.quantity, 0);
  const cartTotal = cartLines.reduce((acc, l) => acc + l.quantity * (l.unitPrice || 0), 0);
  const hasBlockingLine = cartLines.some(l => l.exceeds);

  const effectiveReason = reasonChoice === "Outro" ? customReason.trim() : reasonChoice;

  // ── Abrir / fechar a gaveta ──────────────────────────────────────
  const openFlow = (type: StockFlowType) => {
    if (!canOperate) return;
    setMode(type);
    setSearch("");
    setCart([]);
    setReasonChoice(STOCK_FLOW_REASONS[type][0]);
    setCustomReason("");
    setDocNumber("");
    setPartyName("");
    setPartyDoc("");
    setVehiclePlate("");
    setObservation("");
    setError("");
    setReceipt(null);
  };

  const closeFlow = () => {
    setMode(null);
    setReceipt(null);
    setError("");
  };

  // Foca a busca assim que a gaveta abre — o operador já sai digitando o SKU/medida.
  useEffect(() => {
    if (mode && !receipt) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
  }, [mode, receipt]);

  // Atalhos de teclado: Alt+E abre entrada, Alt+S abre saída, Esc fecha.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode && !submitting) {
        closeFlow();
        return;
      }
      if (!e.altKey || mode) return;
      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        openFlow("ENTRADA");
      } else if (key === "s") {
        e.preventDefault();
        openFlow("SAIDA");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, submitting, canOperate]);

  // ── Manipulação do carrinho ──────────────────────────────────────
  const defaultPriceFor = (item: StockItem, type: StockFlowType) =>
    type === "SAIDA" ? (item.priceCash || item.price || 0) : (item.price || item.priceCash || 0);

  const addToCart = (item: StockItem, amount: number = 1) => {
    if (!mode) return;
    const free = availableQuantity(item);
    if (mode === "SAIDA" && item.quantity <= 0) {
      setError("Este pneu está com saldo zerado — não é possível dar baixa.");
      return;
    }
    if (mode === "SAIDA" && free <= 0) {
      setError(
        `Todas as ${reservedQuantityOf(item)} un deste pneu estão reservadas para clientes ou transferências. ` +
        `Resolva a reserva na aba Reservas — confirmar, recusar ou cancelar — para liberar a baixa.`
      );
      return;
    }
    setError("");
    setFlashId(item.id);
    setTimeout(() => setFlashId(current => (current === item.id ? "" : current)), 450);

    setCart(prev => {
      const existing = prev.find(l => l.stockItemId === item.id);
      if (existing) {
        const nextQty = existing.quantity + amount;
        const capped = mode === "SAIDA" ? Math.min(nextQty, free) : nextQty;
        return prev.map(l => (l.stockItemId === item.id ? { ...l, quantity: capped } : l));
      }
      const initial = mode === "SAIDA" ? Math.min(amount, free) : amount;
      return [...prev, { stockItemId: item.id, quantity: initial, unitPrice: defaultPriceFor(item, mode) }];
    });
  };

  const setLineQuantity = (stockItemId: string, quantity: number) => {
    setCart(prev =>
      prev.map(l => (l.stockItemId === stockItemId ? { ...l, quantity: Math.max(1, quantity) } : l))
    );
  };

  const setLinePrice = (stockItemId: string, unitPrice: number) => {
    setCart(prev => prev.map(l => (l.stockItemId === stockItemId ? { ...l, unitPrice: Math.max(0, unitPrice) } : l)));
  };

  const removeLine = (stockItemId: string) => {
    setCart(prev => prev.filter(l => l.stockItemId !== stockItemId));
  };

  // Enter na busca: se sobrou exatamente um resultado (ou o SKU bateu exato,
  // caso de leitor de código de barras), joga direto no carrinho.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const term = search.trim().toLowerCase();
    if (!term) return;
    const exact = pickerItems.find(i => i.sku.toLowerCase() === term);
    const target = exact || (pickerItems.length === 1 ? pickerItems[0] : null);
    if (target) {
      addToCart(target, 1);
      setSearch("");
    } else if (pickerItems.length === 0) {
      setError("Nenhum pneu encontrado para essa busca.");
    }
  };

  // Enter dentro de um campo de texto não pode disparar a gravação por engano:
  // confirmar a movimentação é sempre um clique consciente no botão do rodapé.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLButtonElement && target.type === "submit") return;
    e.preventDefault();
  };

  // ── Gravação da operação ─────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode || submitting) return;

    if (cartLines.length === 0) {
      setError("Selecione pelo menos um pneu no estoque antes de confirmar.");
      return;
    }
    if (hasBlockingLine) {
      setError("Há itens com quantidade acima do saldo disponível. Ajuste antes de confirmar.");
      return;
    }
    if (!effectiveReason) {
      setError("Informe o motivo da operação.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const result = await onRegister({
        type: mode,
        items: cartLines.map(l => ({
          stockItemId: l.stockItemId,
          quantity: l.quantity,
          unitPrice: l.unitPrice || 0
        })),
        reason: effectiveReason,
        docNumber: docNumber.trim(),
        partyName: partyName.trim(),
        partyDoc: partyDoc.trim(),
        vehiclePlate: vehiclePlate.trim().toUpperCase(),
        observation: observation.trim()
      });
      setReceipt(result);
      setCart([]);
    } catch (err: any) {
      setError(err?.message || "Erro ao gravar a movimentação.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Histórico: agrupa os movimentos por operação ─────────────────
  // Operações do módulo se agrupam pelo operationId; transferências entre
  // filiais não têm operationId, então se agrupam pelo pedido (transferId) —
  // uma operação por lado, já que o remetente grava a saída na empresa de
  // origem e o recebedor grava a entrada na empresa de destino.
  const operations = useMemo(() => {
    const map = new Map<string, FlowOperation>();

    for (const log of movements) {
      const flowType = FLOW_TYPE_OF[log.type];
      if (!flowType) continue;

      const isTransfer = isTransferType(log.type);
      const opId = isTransfer ? "" : (log.operationId || "");
      const transferId = isTransfer ? (log.transferId || "") : "";
      const key = isTransfer
        ? (transferId ? `transferencia:${log.type}:${transferId}` : `avulso:${log.id}`)
        : (opId || `avulso:${log.id}`);
      const millis = toMillis(log.timestamp);

      const existing = map.get(key);
      if (existing) {
        existing.logs.push(log);
        existing.totalUnits += Math.abs(log.quantity);
        existing.totalAmount += Number(log.totalAmount) || 0;
        existing.timestamp = Math.max(existing.timestamp, millis);
        existing.rebuilt = existing.rebuilt || log.rebuilt === true;
      } else {
        map.set(key, {
          key,
          operationId: opId,
          type: flowType,
          logs: [log],
          timestamp: millis,
          totalUnits: Math.abs(log.quantity),
          totalAmount: Number(log.totalAmount) || 0,
          userEmail: log.userEmail || "",
          companyName: log.companyName || "",
          reason: log.operationReason || log.reason || "",
          docNumber: log.docNumber || "",
          partyName: log.partyName || (isTransfer ? transferCounterpart(log.reason || "") : ""),
          vehiclePlate: log.vehiclePlate || "",
          observation: log.observation || "",
          reversalOf: log.reversalOf || "",
          isModuleOperation: !!opId,
          isTransfer,
          transferId,
          rebuilt: log.rebuilt === true
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [movements]);

  // ── Conferência das transferências ───────────────────────────────
  // Toda transferência assinada tem que ter deixado a sua linha aqui: saída na
  // filial de origem, entrada na de destino. Quando não deixou (pedido fechado
  // por uma versão antiga do app, histórico limpo em Relatórios, movimento
  // apagado à mão), o saldo está certo mas o histórico está mudo — e é isso que
  // esta conferência acusa, com o botão para regularizar.
  //
  // A lista de movimentos carregada é uma janela das últimas movimentações, então
  // só dá para afirmar que falta algo em pedidos mais novos que o movimento mais
  // antigo já carregado. Antes disso a ausência pode ser só o corte da janela —
  // acusar ali seria alarme falso. (A regularização confere tudo no servidor.)
  const missingTransferSides = useMemo(() => {
    if (!onSyncTransfers || transfers.length === 0) return [];

    const seesEveryCompany = user.role === "admin" || user.role === "vendedor" || !user.companyId;
    const logged = new Set<string>();
    let oldestLoaded = Infinity;

    for (const log of movements) {
      const millis = toMillis(log.timestamp);
      if (millis) oldestLoaded = Math.min(oldestLoaded, millis);
      if (log.transferId) logged.add(`${log.transferId}|${log.type}`);
    }
    // Histórico vazio: não há janela nenhuma, então tudo é conferível.
    const cutoff = movements.length > 0 && oldestLoaded !== Infinity ? oldestLoaded : 0;

    const missing: { transferId: string; type: string; companyName: string; when: number }[] = [];

    for (const t of transfers) {
      if (t.status !== "EM_TRANSITO" && t.status !== "CONCLUIDO") continue;

      const sides = [
        {
          type: "TRANSFERENCIA_SAIDA",
          companyId: t.sourceCompanyId || "",
          companyName: t.sourceCompanyName || "",
          when: toMillis(t.dispatch?.driver?.signedAt || t.dispatch?.sender?.signedAt || t.delivery?.signedAt)
        },
        ...(t.status === "CONCLUIDO" ? [{
          type: "TRANSFERENCIA_ENTRADA",
          companyId: t.destinationCompanyId || "",
          companyName: t.destinationCompanyName || "",
          when: toMillis(t.arrival?.driver?.signedAt || t.arrival?.receiver?.signedAt || t.receipt?.signedAt)
        }] : [])
      ];

      for (const side of sides) {
        if (!side.companyId) continue;
        if (!seesEveryCompany && side.companyId !== user.companyId) continue;
        const when = side.when || toMillis(t.updatedAt);
        if (when && when < cutoff) continue;
        if (logged.has(`${t.id}|${side.type}`)) continue;
        missing.push({ transferId: t.id, type: side.type, companyName: side.companyName, when });
      }
    }

    return missing;
  }, [transfers, movements, user.role, user.companyId, onSyncTransfers]);

  // O aviso some assim que a conferência no servidor confirma que está tudo lá.
  const showMissingTransfers = missingTransferSides.length > 0 && !syncCleared;

  const handleSyncTransfers = async () => {
    if (!onSyncTransfers || syncing) return;
    setSyncing(true);
    setSyncMessage("");
    try {
      const res = await onSyncTransfers();
      setSyncCleared(res.created === 0);
      setSyncMessage(
        res.created > 0
          ? `${res.created} ${res.created === 1 ? "registro recriado" : "registros recriados"} em ${res.repaired} ${res.repaired === 1 ? "pedido" : "pedidos"}. O histórico já está atualizado.`
          : `Nenhum registro faltando: ${res.scanned} ${res.scanned === 1 ? "pedido conferido já estava" : "pedidos conferidos já estavam"} no histórico.`
      );
    } catch (err: any) {
      setSyncCleared(false);
      setSyncMessage(err?.message || "Erro ao regularizar o histórico de transferências.");
    } finally {
      setSyncing(false);
    }
  };

  // operationIds que já foram estornados — bloqueia estorno duplicado na UI.
  const reversedOperationIds = useMemo(() => {
    const set = new Set<string>();
    operations.forEach(op => {
      if (op.reversalOf) set.add(op.reversalOf);
    });
    return set;
  }, [operations]);

  const filteredOperations = useMemo(() => {
    const term = histSearch.trim().toLowerCase();
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const periodStart =
      histPeriod === "TODAY" ? startOfToday.getTime()
      : histPeriod === "7D" ? now - 7 * 24 * 60 * 60 * 1000
      : histPeriod === "30D" ? now - 30 * 24 * 60 * 60 * 1000
      : 0;

    return operations.filter(op => {
      if (histType !== "ALL" && op.type !== histType) return false;
      if (op.timestamp < periodStart) return false;
      if (!term) return true;
      return (
        op.operationId.toLowerCase().includes(term) ||
        op.transferId.toLowerCase().includes(term) ||
        op.reason.toLowerCase().includes(term) ||
        op.partyName.toLowerCase().includes(term) ||
        op.docNumber.toLowerCase().includes(term) ||
        op.vehiclePlate.toLowerCase().includes(term) ||
        op.userEmail.toLowerCase().includes(term) ||
        op.companyName.toLowerCase().includes(term) ||
        op.logs.some(l =>
          l.sku.toLowerCase().includes(term) ||
          l.brand.toLowerCase().includes(term) ||
          l.model.toLowerCase().includes(term) ||
          l.size.toLowerCase().includes(term) ||
          matchesTireSize(l.size, term)
        )
      );
    });
  }, [operations, histSearch, histType, histPeriod]);

  // KPIs do dia (sempre "hoje", independente do filtro do histórico).
  const todayStats = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const start = startOfToday.getTime();

    let entryUnits = 0;
    let exitUnits = 0;
    let exitValue = 0;
    let opsCount = 0;

    operations.forEach(op => {
      if (op.timestamp < start) return;
      opsCount += 1;
      if (op.type === "ENTRADA") {
        entryUnits += op.totalUnits;
      } else {
        exitUnits += op.totalUnits;
        exitValue += op.totalAmount;
      }
    });

    return { entryUnits, exitUnits, exitValue, opsCount, net: entryUnits - exitUnits };
  }, [operations]);

  // ── Estorno (admin) ──────────────────────────────────────────────
  const handleReverse = async (op: FlowOperation) => {
    if (!onReverse || !op.operationId) return;
    const label = op.type === "ENTRADA" ? "retirada do" : "devolvida ao";
    const confirmed = window.confirm(
      `Estornar a operação ${op.operationId}?\n\nA quantidade de ${op.totalUnits} un será ${label} estoque e um registro de estorno ficará gravado no histórico.`
    );
    if (!confirmed) return;

    setReversingId(op.operationId);
    try {
      await onReverse(op.operationId);
    } catch (err: any) {
      alert(err?.message || "Erro ao estornar a operação.");
    } finally {
      setReversingId("");
    }
  };

  // ── Exportação CSV do histórico filtrado (uma linha por item) ────
  const handleExportCSV = () => {
    const rows = filteredOperations.flatMap(op =>
      op.logs.map(log => ({
        operationId: op.operationId || (op.transferId ? `TRANSF-${op.transferId}` : "—"),
        timestamp: formatDate(log.timestamp),
        type: op.isTransfer
          ? (op.type === "ENTRADA" ? "Entrada por Transferência" : "Saída por Transferência")
          : (op.type === "ENTRADA" ? "Entrada de Pneus" : "Saída de Pneus"),
        sku: log.sku,
        brand: log.brand,
        model: log.model,
        size: log.size,
        quantity: Math.abs(log.quantity),
        balanceAfter: log.balanceAfter,
        reason: op.reason,
        docNumber: op.docNumber,
        partyName: op.partyName,
        vehiclePlate: op.vehiclePlate,
        unitPrice: Number(log.unitPrice) || 0,
        totalAmount: Number(log.totalAmount) || 0,
        companyName: log.companyName,
        userEmail: log.userEmail
      }))
    );

    exportToCSV(
      rows,
      [
        { key: "operationId", label: "Operação" },
        { key: "timestamp", label: "Data/Hora" },
        { key: "type", label: "Tipo" },
        { key: "sku", label: "SKU" },
        { key: "brand", label: "Marca" },
        { key: "model", label: "Modelo" },
        { key: "size", label: "Medida" },
        { key: "quantity", label: "Qtde" },
        { key: "balanceAfter", label: "Saldo Após" },
        { key: "reason", label: "Motivo" },
        { key: "docNumber", label: "NF / OS" },
        { key: "partyName", label: "Fornecedor / Cliente" },
        { key: "vehiclePlate", label: "Placa" },
        { key: "unitPrice", label: "Valor Unit." },
        { key: "totalAmount", label: "Valor Total" },
        { key: "companyName", label: "Empresa" },
        { key: "userEmail", label: "Operador" }
      ],
      `Central_Stoque_Entradas_Saidas_${Date.now()}`
    );
  };

  // ── Comprovante impresso (mesmo padrão do recibo térmico do sistema) ──
  const printOperation = (data: {
    type: StockFlowType;
    operationId: string;
    companyName: string;
    userName: string;
    date: string;
    reason: string;
    docNumber: string;
    partyName: string;
    partyDoc: string;
    vehiclePlate: string;
    observation: string;
    totalUnits: number;
    totalAmount: number;
    isTransfer?: boolean;
    items: { sku: string; brand: string; model: string; size: string; quantity: number; unitPrice: number; balanceAfter: number }[];
  }) => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const isEntry = data.type === "ENTRADA";
    // Numa transferencia nao existe fornecedor nem cliente: existe a filial do
    // outro lado do pedido.
    const title = data.isTransfer
      ? (isEntry ? "Entrada por Transferência" : "Saída por Transferência")
      : (isEntry ? "Comprovante de Entrada" : "Comprovante de Saída");
    const partyLabel = data.isTransfer
      ? (isEntry ? "ORIGEM" : "DESTINO")
      : (isEntry ? "FORNECEDOR" : "CLIENTE");
    const money = (v: number) => v.toFixed(2).replace(".", ",");

    const itemsHtml = data.items.map(item => `
      <div style="margin-bottom: 8px;">
        [${item.sku}] ${item.brand} ${item.model} (${item.size})<br/>
        <div class="item-row" style="margin-top: 2px;">
          <span>${item.quantity} un${item.unitPrice ? ` x R$ ${money(item.unitPrice)}` : ""}</span>
          <span>${item.unitPrice ? `R$ ${money(item.quantity * item.unitPrice)}` : `saldo: ${item.balanceAfter} un`}</span>
        </div>
      </div>
    `).join("");

    printWindow.document.write(`
      <html>
        <head>
          <title>${title} - Central Stoque</title>
          <style>
            @media print {
              body { margin: 0; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.4; color: #000; }
              .btn-print { display: none; }
            }
            body { max-width: 300px; margin: auto; padding: 20px; font-family: monospace; font-size: 12px; line-height: 1.4; color: #333; }
            .header { text-align: center; margin-bottom: 15px; border-bottom: 1px dashed #ccc; padding-bottom: 10px; }
            .company { font-weight: bold; font-size: 14px; }
            .title { text-transform: uppercase; font-weight: bold; margin-top: 5px; }
            .divider { border-top: 1px dashed #ccc; margin: 10px 0; }
            .item-row { display: flex; justify-content: space-between; }
            .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; margin-top: 5px; }
            .footer { text-align: center; margin-top: 20px; font-size: 10px; color: #666; border-top: 1px dashed #ccc; padding-top: 10px; }
            .btn-print { display: block; width: 100%; padding: 8px; background: #000; color: #fff; border: none; font-weight: bold; text-align: center; cursor: pointer; margin-top: 15px; text-transform: uppercase; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="company">${(data.companyName || "Central Stoque").toUpperCase()}</div>
            <div class="title">${title}</div>
            <div>Operação: ${data.operationId}</div>
            <div>Data: ${data.date}</div>
            <div>Operador: ${data.userName}</div>
          </div>

          <div style="margin-bottom: 10px;"><strong>ITENS:</strong></div>
          ${itemsHtml}

          <div class="divider"></div>
          <div class="total-row">
            <span>TOTAL DE PNEUS:</span>
            <span>${data.totalUnits} un</span>
          </div>
          ${data.totalAmount > 0 ? `
          <div class="total-row">
            <span>VALOR TOTAL:</span>
            <span>R$ ${money(data.totalAmount)}</span>
          </div>` : ""}

          <div class="divider"></div>
          <div>
            <strong>MOTIVO:</strong> ${data.reason || "—"}<br/>
            ${data.docNumber ? `<strong>NF / OS:</strong> ${data.docNumber}<br/>` : ""}
            <strong>${partyLabel}:</strong> ${data.partyName || "Não informado"}<br/>
            ${data.partyDoc ? `CPF/CNPJ: ${data.partyDoc}<br/>` : ""}
            ${data.vehiclePlate ? `Placa: ${data.vehiclePlate}<br/>` : ""}
            ${data.observation ? `Obs.: ${data.observation}` : ""}
          </div>

          <div class="footer">
            Central Stoque — Movimentação auditada<br/>
            Registro permanente no histórico do sistema
          </div>

          <button class="btn-print" onclick="window.print()">Imprimir Comprovante</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const printReceipt = (result: StockFlowResult) => {
    printOperation({
      type: result.type,
      operationId: result.operationId,
      companyName: result.companyName,
      userName: result.userName,
      date: result.date,
      reason: result.reason,
      docNumber: result.docNumber,
      partyName: result.partyName,
      partyDoc: result.partyDoc,
      vehiclePlate: result.vehiclePlate,
      observation: result.observation,
      totalUnits: result.totalUnits,
      totalAmount: result.totalAmount,
      items: result.items.map(i => ({
        sku: i.sku,
        brand: i.brand,
        model: i.model,
        size: i.size,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        balanceAfter: i.balanceAfter
      }))
    });
  };

  const printHistoryOperation = (op: FlowOperation) => {
    printOperation({
      type: op.type,
      isTransfer: op.isTransfer,
      operationId: op.operationId || (op.transferId ? `TRANSF-${op.transferId}` : "—"),
      companyName: op.companyName,
      userName: op.userEmail,
      date: formatDate(op.logs[0]?.timestamp),
      reason: op.reason,
      docNumber: op.docNumber,
      partyName: op.partyName,
      partyDoc: op.logs[0]?.partyDoc || "",
      vehiclePlate: op.vehiclePlate,
      observation: op.observation,
      totalUnits: op.totalUnits,
      totalAmount: op.totalAmount,
      items: op.logs.map(l => ({
        sku: l.sku,
        brand: l.brand,
        model: l.model,
        size: l.size,
        quantity: Math.abs(l.quantity),
        unitPrice: Number(l.unitPrice) || 0,
        balanceAfter: l.balanceAfter
      }))
    });
  };

  const isEntrada = mode === "ENTRADA";
  const accent = isEntrada
    ? { text: "text-emerald-700", bg: "bg-emerald-600", soft: "bg-emerald-50", border: "border-emerald-200", ring: "focus:ring-emerald-500/10 focus:border-emerald-500" }
    : { text: "text-red-700", bg: "bg-red-600", soft: "bg-red-50", border: "border-red-200", ring: "focus:ring-red-500/10 focus:border-red-500" };

  return (
    <div className="space-y-6 font-sans">

      {/* ═══════════ PAINEL DE AÇÕES: os dois botões do módulo ═══════════ */}
      <div className="bg-white rounded-2xl border-t-2 border-t-gold-500/80 border-x border-b border-slate-200 shadow-[0_4px_25px_rgba(0,0,0,0.015)] p-5 sm:p-6 space-y-5">

        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="h-11 w-11 rounded-xl bg-gold-50 text-gold-600 flex items-center justify-center border border-gold-100 shrink-0 shadow-inner">
              <Boxes size={22} className="stroke-[1.8]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-black text-slate-900 uppercase tracking-wider">Movimentação de Estoque</h2>
              <p className="text-xs text-slate-500 font-semibold mt-1 max-w-2xl leading-relaxed">
                Escolha a operação, selecione os pneus direto do estoque e confirme. O saldo é atualizado na hora
                e cada item movimentado fica registrado no histórico auditado — com comprovante para impressão.
              </p>
            </div>
          </div>

          {isAdmin && companies.length > 0 && (
            <div className="shrink-0">
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                Empresa
              </label>
              <select
                value={companyFilter}
                onChange={e => setCompanyFilter(e.target.value)}
                className="w-full lg:w-56 px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-bold cursor-pointer"
              >
                <option value="">Todas as empresas</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {!canOperate && (
          <div className="bg-amber-50 border border-amber-200/70 text-amber-800 px-4 py-3 rounded-xl text-xs font-bold flex items-start gap-2">
            <Info size={15} className="shrink-0 mt-0.5" />
            <span>
              Seu perfil acompanha o histórico de movimentações, mas não pode dar entrada ou baixa no estoque.
              Peça ao dono da empresa ou ao administrador.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Botão ENTRADA */}
          <button
            type="button"
            onClick={() => openFlow("ENTRADA")}
            disabled={!canOperate}
            className="group relative overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white p-5 text-left transition-all cursor-pointer hover:border-emerald-400 hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-600/25 group-hover:scale-105 transition-transform shrink-0">
                <PackagePlus size={26} className="stroke-[2]" />
              </div>
              <div className="min-w-0">
                <span className="block text-sm font-black text-emerald-800 uppercase tracking-wide">Entrada de Pneus</span>
                <span className="block text-[11px] text-slate-500 font-semibold mt-1 leading-snug">
                  Soma unidades ao estoque — compra, devolução ou retorno de garantia.
                </span>
              </div>
            </div>
            <span className="hidden sm:block absolute top-3 right-3 text-[9px] font-black uppercase tracking-widest text-emerald-600/60 border border-emerald-200 rounded-md px-1.5 py-0.5 bg-white/70">
              Alt + E
            </span>
          </button>

          {/* Botão SAÍDA */}
          <button
            type="button"
            onClick={() => openFlow("SAIDA")}
            disabled={!canOperate}
            className="group relative overflow-hidden rounded-2xl border border-red-200 bg-gradient-to-br from-red-50 via-white to-white p-5 text-left transition-all cursor-pointer hover:border-red-400 hover:shadow-lg hover:shadow-red-500/10 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-2xl bg-red-600 text-white flex items-center justify-center shadow-lg shadow-red-600/25 group-hover:scale-105 transition-transform shrink-0">
                <PackageMinus size={26} className="stroke-[2]" />
              </div>
              <div className="min-w-0">
                <span className="block text-sm font-black text-red-800 uppercase tracking-wide">Saída de Pneus</span>
                <span className="block text-[11px] text-slate-500 font-semibold mt-1 leading-snug">
                  Dá baixa no estoque — venda, garantia, uso interno ou perda.
                </span>
              </div>
            </div>
            <span className="hidden sm:block absolute top-3 right-3 text-[9px] font-black uppercase tracking-widest text-red-600/60 border border-red-200 rounded-md px-1.5 py-0.5 bg-white/70">
              Alt + S
            </span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
          <Keyboard size={12} className="text-gold-600" />
          Atalhos: Alt+E entrada • Alt+S saída • Enter adiciona o pneu pesquisado • Esc fecha
        </div>
      </div>

      {/* ═══════════ INDICADORES DO DIA ═══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-emerald-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100/60 shadow-sm">
            <ArrowDownLeft size={20} className="stroke-[2.5px]" />
          </div>
          <div className="min-w-0">
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider block">Entradas Hoje</span>
            <p className="text-lg font-black text-slate-900 font-mono leading-none mt-1">+{todayStats.entryUnits}</p>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-red-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100/60 shadow-sm">
            <ArrowUpRight size={20} className="stroke-[2.5px]" />
          </div>
          <div className="min-w-0">
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider block">Saídas Hoje</span>
            <p className="text-lg font-black text-slate-900 font-mono leading-none mt-1">-{todayStats.exitUnits}</p>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-gold-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-gold-50 text-gold-600 flex items-center justify-center border border-gold-100/60 shadow-sm">
            <Boxes size={19} className="stroke-[2.2px]" />
          </div>
          <div className="min-w-0">
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider block">Saldo do Dia</span>
            <p className={`text-lg font-black font-mono leading-none mt-1 ${todayStats.net > 0 ? "text-emerald-600" : todayStats.net < 0 ? "text-red-600" : "text-slate-800"}`}>
              {todayStats.net > 0 ? "+" : ""}{todayStats.net} un
            </p>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-slate-400 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center border border-slate-200/50 shadow-sm">
            <ClipboardList size={19} className="stroke-[2.2px]" />
          </div>
          <div className="min-w-0">
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider block">Operações Hoje</span>
            <p className="text-lg font-black text-slate-800 font-mono leading-none mt-1">{todayStats.opsCount}</p>
            {todayStats.exitValue > 0 && (
              <span className="text-[9px] font-bold text-slate-400 block mt-1 truncate">{formatBRL(todayStats.exitValue)} em saídas</span>
            )}
          </div>
        </div>
      </div>

      {/* ═══════════ CONFERÊNCIA DAS TRANSFERÊNCIAS ═══════════ */}
      {onSyncTransfers && (showMissingTransfers || syncMessage) && (
        <div className={`rounded-2xl border p-4 flex flex-col sm:flex-row sm:items-center gap-3 ${
          showMissingTransfers ? "bg-amber-50/70 border-amber-200" : "bg-emerald-50/70 border-emerald-200"
        }`}>
          <div className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center border ${
            showMissingTransfers
              ? "bg-amber-100 text-amber-700 border-amber-200"
              : "bg-emerald-100 text-emerald-700 border-emerald-200"
          }`}>
            {showMissingTransfers
              ? <AlertTriangle size={19} className="stroke-[2.2px]" />
              : <CheckCircle2 size={19} className="stroke-[2.2px]" />}
          </div>

          <div className="min-w-0 flex-1">
            {showMissingTransfers ? (
              <>
                <p className="text-xs font-black text-amber-900 uppercase tracking-wider">
                  {missingTransferSides.length} {missingTransferSides.length === 1
                    ? "movimentação de transferência sem registro"
                    : "movimentações de transferência sem registro"}
                </p>
                <p className="text-[11px] font-bold text-amber-800/80 mt-1">
                  Transferências assinadas que não deixaram a linha de entrada/saída neste histórico.
                  O estoque está certo — falta só o registro. Regularizar recria as linhas com a data
                  da assinatura, sem alterar nenhum saldo.
                </p>
                {syncMessage && (
                  <p className="text-[11px] font-black text-amber-900 mt-1.5">{syncMessage}</p>
                )}
              </>
            ) : (
              <p className="text-[11px] font-bold text-emerald-800">{syncMessage}</p>
            )}
          </div>

          {showMissingTransfers && (
            <button
              type="button"
              onClick={handleSyncTransfers}
              disabled={syncing}
              className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-black uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
            >
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} className="stroke-[2.5px]" />}
              {syncing ? "Regularizando..." : "Regularizar histórico"}
            </button>
          )}
        </div>
      )}

      {/* ═══════════ HISTÓRICO DE MOVIMENTAÇÕES ═══════════ */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_4px_25px_rgba(0,0,0,0.015)] overflow-hidden">

        {/* Barra de controle do histórico */}
        <div className="p-4 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <History size={16} className="text-gold-600" />
            <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider">Histórico de Operações</h3>
            <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 text-[10px] font-black font-mono">
              {filteredOperations.length}
            </span>
          </div>

          <div className="relative flex-1 min-w-0">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search size={15} className="text-gold-600" />
            </div>
            <input
              type="text"
              placeholder="Buscar por operação, SKU, medida, cliente, NF, placa ou operador..."
              value={histSearch}
              onChange={e => setHistSearch(e.target.value)}
              className="pl-9 pr-3 py-2 w-full border border-slate-200 rounded-xl bg-slate-50/50 text-slate-900 font-semibold text-xs focus:bg-white focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 outline-none transition-all"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Filtro de tipo */}
            <div className="flex items-center rounded-xl border border-slate-200 overflow-hidden divide-x divide-slate-200">
              {([
                { value: "ALL", label: "Tudo" },
                { value: "ENTRADA", label: "Entradas" },
                { value: "SAIDA", label: "Saídas" }
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setHistType(opt.value)}
                  className={`px-3 py-2 text-[10px] font-black uppercase tracking-wider transition-colors cursor-pointer ${
                    histType === opt.value
                      ? opt.value === "ENTRADA"
                        ? "bg-emerald-600 text-white"
                        : opt.value === "SAIDA"
                          ? "bg-red-600 text-white"
                          : "bg-slate-800 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Filtro de período */}
            <select
              value={histPeriod}
              onChange={e => setHistPeriod(e.target.value as any)}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-slate-900 font-bold text-[11px] cursor-pointer"
            >
              <option value="TODAY">Hoje</option>
              <option value="7D">Últimos 7 dias</option>
              <option value="30D">Últimos 30 dias</option>
              <option value="ALL">Todo o período</option>
            </select>

            <button
              type="button"
              onClick={handleExportCSV}
              disabled={filteredOperations.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 font-black text-[10px] uppercase tracking-wider rounded-xl text-white bg-gradient-to-r from-gold-600 to-amber-500 hover:from-gold-700 hover:to-amber-600 disabled:opacity-40 border border-gold-400/20 transition-all shadow-md shadow-gold-500/10 cursor-pointer"
            >
              <Download size={13} className="stroke-[2.5px]" /> CSV
            </button>
          </div>
        </div>

        {/* Lista de operações */}
        {filteredOperations.length === 0 ? (
          <div className="py-14 flex flex-col items-center justify-center text-center text-slate-400 px-6">
            <History size={44} className="stroke-[1.5px] text-slate-200 mb-2" />
            <p className="font-bold text-slate-800 text-base">Nenhuma movimentação no período</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Registre uma entrada ou uma saída nos botões acima e a operação aparece aqui na hora,
              junto com as transferências concluídas entre filiais,
              com todos os pneus, saldos e responsável.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredOperations.map(op => {
              const isOpen = expandedKey === op.key;
              const isEntry = op.type === "ENTRADA";
              const alreadyReversed = op.operationId ? reversedOperationIds.has(op.operationId) : false;
              const canReverseOp = isAdmin && !!onReverse && op.isModuleOperation && !alreadyReversed && !op.reversalOf;

              return (
                <div key={op.key} className="transition-colors hover:bg-slate-50/60">
                  {/* Cabeçalho da operação (clicável) */}
                  <button
                    type="button"
                    onClick={() => setExpandedKey(isOpen ? "" : op.key)}
                    className="w-full text-left px-4 py-3 flex items-center gap-3 cursor-pointer"
                  >
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center border shrink-0 ${
                      isEntry ? "bg-emerald-50 text-emerald-600 border-emerald-100" : "bg-red-50 text-red-600 border-red-100"
                    }`}>
                      {isEntry ? <ArrowDownLeft size={17} className="stroke-[2.5px]" /> : <ArrowUpRight size={17} className="stroke-[2.5px]" />}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg border ${
                          isEntry ? "bg-emerald-50 text-emerald-800 border-emerald-100/80" : "bg-red-50 text-red-800 border-red-100/85"
                        }`}>
                          {isEntry ? "Entrada" : "Saída"}
                        </span>
                        {op.isTransfer && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-lg border bg-blue-50 text-blue-800 border-blue-100/80 flex items-center gap-1">
                            <ArrowLeftRight size={9} className="stroke-[3px]" /> Transferência
                          </span>
                        )}
                        <span className="text-xs font-black text-slate-900 truncate">{op.reason || "Sem motivo informado"}</span>
                        {/* Na transferência a filial do outro lado já vem escrita no motivo. */}
                        {op.partyName && !op.isTransfer && (
                          <span className="text-[10px] font-bold text-slate-500 truncate">• {op.partyName}</span>
                        )}
                        {op.docNumber && (
                          <span className="text-[9px] font-black font-mono text-gold-700 bg-gold-400/10 border border-gold-300/20 px-1.5 py-0.5 rounded">
                            NF {op.docNumber}
                          </span>
                        )}
                        {op.reversalOf && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-white">
                            Estorno
                          </span>
                        )}
                        {alreadyReversed && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">
                            Estornada
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] font-bold text-slate-400 flex-wrap">
                        <span className="flex items-center gap-1 font-mono">
                          <Calendar size={10} className="text-gold-600" /> {formatDate(op.logs[0]?.timestamp)}
                        </span>
                        <span className="flex items-center gap-1 truncate max-w-[160px]" title={op.userEmail}>
                          <User size={10} className="text-gold-600" /> {op.userEmail.split("@")[0] || "—"}
                        </span>
                        {op.companyName && (
                          <span className="flex items-center gap-1 truncate max-w-[160px]">
                            <Building2 size={10} className="text-gold-600" /> {op.companyName}
                          </span>
                        )}
                        <span className="font-mono text-slate-350">{op.logs.length} {op.logs.length === 1 ? "item" : "itens"}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className={`text-base font-black font-mono leading-none ${isEntry ? "text-emerald-600" : "text-red-600"}`}>
                        {isEntry ? "+" : "-"}{op.totalUnits}
                      </p>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">unidades</span>
                      {op.totalAmount > 0 && (
                        <p className="text-[10px] font-bold text-slate-500 mt-0.5 font-mono">{formatBRL(op.totalAmount)}</p>
                      )}
                    </div>

                    <div className="text-slate-300 shrink-0">
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </div>
                  </button>

                  {/* Detalhe expandido */}
                  {isOpen && (
                    <div className="px-4 pb-4 animate-fadeIn">
                      <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50/40">
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-left text-xs">
                            <thead className="bg-white text-slate-400 text-[9px] uppercase font-extrabold tracking-widest border-b border-slate-100">
                              <tr>
                                <th className="py-2 px-3">SKU</th>
                                <th className="py-2 px-3">Pneu</th>
                                <th className="py-2 px-3 text-center">Qtde</th>
                                <th className="py-2 px-3 text-center">Saldo Após</th>
                                <th className="py-2 px-3 text-right">Valor</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-white">
                              {op.logs.map(log => (
                                <tr key={log.id}>
                                  <td className="py-2 px-3">
                                    <span className="inline-block px-2 py-0.5 text-gold-700 bg-gold-400/10 rounded-lg border border-gold-300/20 font-mono text-[10px] font-extrabold uppercase">
                                      {log.sku}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3">
                                    <div className="font-bold text-slate-900 uppercase text-[11px]">{log.brand}</div>
                                    <div className="text-[10px] text-slate-500 font-bold">
                                      {log.model} • <span className="font-mono text-slate-400">{log.size}</span>
                                    </div>
                                  </td>
                                  <td className={`py-2 px-3 text-center font-black font-mono text-[11px] ${isEntry ? "text-emerald-600" : "text-red-600"}`}>
                                    {log.quantity > 0 ? `+${log.quantity}` : log.quantity}
                                  </td>
                                  <td className="py-2 px-3 text-center">
                                    <span className="inline-block px-2 py-0.5 bg-slate-50 text-slate-700 rounded-lg text-[10px] font-mono border border-slate-200 font-bold">
                                      {log.balanceAfter} un
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right font-mono text-[10px] font-bold text-slate-600">
                                    {Number(log.totalAmount) > 0 ? formatBRL(Number(log.totalAmount)) : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="p-3 border-t border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="text-[10px] font-bold text-slate-500 space-y-0.5 min-w-0">
                            {op.operationId && (
                              <div className="font-mono text-slate-400">Operação: <span className="text-slate-700 font-black">{op.operationId}</span></div>
                            )}
                            {op.vehiclePlate && <div>Placa: <span className="font-mono font-black text-slate-700">{op.vehiclePlate}</span></div>}
                            {op.observation && <div className="italic text-slate-400 truncate max-w-md">Obs.: {op.observation}</div>}
                            {op.isTransfer ? (
                              <>
                                {op.transferId && (
                                  <div className="font-mono text-slate-400">
                                    Pedido: <span className="text-slate-700 font-black">{op.transferId}</span>
                                  </div>
                                )}
                                <div className="text-blue-700/80 italic">
                                  Movimentação do módulo de Transferências — assinaturas e estorno ficam naquela tela.
                                </div>
                                {op.rebuilt && (
                                  <div className="text-amber-700 italic">
                                    Registro regularizado depois da assinatura — a coluna "Saldo Após" traz o saldo do
                                    momento do reparo, não o da época.
                                  </div>
                                )}
                              </>
                            ) : !op.isModuleOperation && (
                              <div className="text-slate-400 italic">Registro avulso — gerado por outra tela do sistema.</div>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => printHistoryOperation(op)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600 text-[10px] font-black uppercase tracking-wider hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              <Printer size={12} /> Comprovante
                            </button>

                            {canReverseOp && (
                              <button
                                type="button"
                                onClick={() => handleReverse(op)}
                                disabled={reversingId === op.operationId}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-red-200 text-red-600 text-[10px] font-black uppercase tracking-wider hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                {reversingId === op.operationId
                                  ? <Loader2 size={12} className="animate-spin" />
                                  : <RotateCcw size={12} />} Estornar
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══════════ GAVETA DA OPERAÇÃO (entrada ou saída) ═══════════ */}
      {mode && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-stretch sm:items-center justify-center sm:p-4 animate-fadeIn">
          <div className="bg-slate-50 w-full sm:max-w-6xl sm:rounded-3xl border border-slate-200 shadow-2xl flex flex-col h-full sm:h-auto sm:max-h-[92vh] overflow-hidden">

            {/* Cabeçalho colorido pela operação */}
            <div className={`px-5 py-4 flex items-center justify-between gap-3 text-white shrink-0 ${isEntrada ? "bg-gradient-to-r from-emerald-700 to-emerald-600" : "bg-gradient-to-r from-red-700 to-red-600"}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center shrink-0">
                  {isEntrada ? <PackagePlus size={20} className="stroke-[2.2]" /> : <PackageMinus size={20} className="stroke-[2.2]" />}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-black uppercase tracking-wider leading-none">
                    {isEntrada ? "Entrada de Pneus" : "Saída de Pneus"}
                  </h3>
                  <p className="text-[10px] font-bold text-white/70 mt-1 truncate">
                    {receipt
                      ? "Operação concluída e registrada no histórico"
                      : isEntrada
                        ? "Selecione os pneus e a quantidade que está entrando no estoque"
                        : "Selecione os pneus e a quantidade que está saindo do estoque"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {!receipt && (
                  <div className="hidden sm:flex flex-col items-end leading-none">
                    <span className="text-lg font-black font-mono">{cartUnits}</span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-white/70">no carrinho</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={closeFlow}
                  disabled={submitting}
                  className="p-1.5 rounded-lg hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-40"
                  title="Fechar (Esc)"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {receipt ? (
              /* ── Tela de sucesso + comprovante ── */
              <div className="flex-1 overflow-y-auto p-6 sm:p-8">
                <div className="max-w-lg mx-auto text-center space-y-5">
                  <div className={`h-16 w-16 mx-auto rounded-2xl flex items-center justify-center ${isEntrada ? "bg-emerald-50 text-emerald-600 border border-emerald-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                    <CheckCircle2 size={34} className="stroke-[2]" />
                  </div>

                  <div>
                    <h4 className="text-base font-black text-slate-900 uppercase tracking-wide">
                      {isEntrada ? "Entrada registrada!" : "Saída registrada!"}
                    </h4>
                    <p className="text-xs text-slate-500 font-semibold mt-1.5 leading-relaxed">
                      {receipt.totalUnits} un em {receipt.items.length} {receipt.items.length === 1 ? "produto" : "produtos"}
                      {isEntrada ? " somadas ao" : " baixadas do"} estoque. Tudo salvo no histórico com o código{" "}
                      <span className="font-mono font-black text-slate-800">{receipt.operationId}</span>.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100 text-left overflow-hidden">
                    {receipt.items.map((item, idx) => (
                      <div key={`${item.sku}-${idx}`} className="p-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-slate-900 uppercase text-[11px] truncate">{item.brand} {item.model}</div>
                          <div className="text-[10px] text-slate-500 font-bold font-mono">{item.sku} • {item.size}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className={`text-xs font-black font-mono ${isEntrada ? "text-emerald-600" : "text-red-600"}`}>
                            {isEntrada ? "+" : "-"}{item.quantity} un
                          </span>
                          <div className="text-[10px] text-slate-400 font-bold font-mono">
                            {item.balanceBefore} → {item.balanceAfter}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {receipt.totalAmount > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-slate-900 text-white">
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Valor total</span>
                      <span className="text-sm font-black font-mono">{formatBRL(receipt.totalAmount)}</span>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => printReceipt(receipt)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-black uppercase tracking-wider hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <Printer size={14} /> Imprimir comprovante
                    </button>
                    <button
                      type="button"
                      onClick={() => openFlow(receipt.type)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-white text-xs font-black uppercase tracking-wider transition-all cursor-pointer hover:scale-[1.01] ${isEntrada ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}`}
                    >
                      <Plus size={14} /> Nova operação
                    </button>
                    <button
                      type="button"
                      onClick={closeFlow}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-black uppercase tracking-wider hover:bg-slate-200 transition-colors cursor-pointer"
                    >
                      Fechar
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* ── Operação em edição: seletor de estoque + carrinho ── */
              <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="flex-1 flex flex-col lg:flex-row min-h-0">

                {/* ─── Coluna A: estoque disponível ─── */}
                <div className="lg:w-1/2 flex flex-col min-h-0 bg-white lg:border-r border-b lg:border-b-0 border-slate-200">
                  <div className="p-4 space-y-2 border-b border-slate-100 shrink-0">
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                        <Search size={15} className="text-slate-400" />
                      </div>
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        placeholder="Buscar por SKU, marca, modelo ou medida (ex.: 17565r14)"
                        className={`w-full pl-9 pr-3 py-2.5 text-xs text-slate-800 bg-slate-50/60 border border-slate-200 rounded-xl outline-none focus:bg-white focus:ring-4 transition-all font-semibold ${accent.ring}`}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-400">
                      <span className="uppercase tracking-wider">
                        {pickerItems.length} {pickerItems.length === 1 ? "pneu encontrado" : "pneus encontrados"}
                        {pickerItems.length === 80 && " (refine a busca)"}
                      </span>
                      <span className="italic">Clique no pneu para adicionar</span>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto min-h-[180px] max-h-[38vh] lg:max-h-none divide-y divide-slate-100">
                    {pickerItems.length === 0 ? (
                      <div className="p-8 text-center">
                        <Boxes size={34} className="mx-auto text-slate-200 mb-2" />
                        <p className="text-xs font-bold text-slate-600">
                          {mode === "SAIDA" ? "Nenhum pneu com saldo disponível." : "Nenhum pneu encontrado."}
                        </p>
                        <p className="text-[10px] text-slate-400 font-semibold mt-1 max-w-xs mx-auto">
                          {mode === "ENTRADA"
                            ? "Se o pneu ainda não existe no sistema, cadastre-o em “Cadastros e Ajustes” e volte aqui para dar entrada."
                            : "Só aparecem aqui os pneus com saldo maior que zero."}
                        </p>
                      </div>
                    ) : (
                      pickerItems.map(item => {
                        const inCart = cart.find(l => l.stockItemId === item.id);
                        const itemFree = availableQuantity(item);
                        const itemReserved = reservedQuantityOf(item);
                        // Na saída, "baixo" se mede pelo que dá para vender de verdade.
                        const isLow = (isEntrada ? item.quantity : itemFree) <= 4;
                        return (
                          <div
                            key={item.id}
                            onClick={() => addToCart(item, 1)}
                            className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors border-l-4 ${
                              flashId === item.id
                                ? (isEntrada ? "bg-emerald-100 border-l-transparent" : "bg-red-100 border-l-transparent")
                                : itemReserved > 0
                                // Parte deste pneu já está prometida. Quem está dando
                                // baixa precisa ver isso ANTES de escolher a quantidade,
                                // não depois de o sistema recusar por falta de saldo.
                                ? "bg-amber-50 hover:bg-amber-100 border-l-amber-400"
                                : inCart
                                ? "bg-slate-50 border-l-transparent"
                                : "hover:bg-slate-50 border-l-transparent"
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] font-mono font-extrabold text-gold-700 bg-gold-400/10 border border-gold-300/20 px-1.5 py-0.5 rounded uppercase shrink-0">
                                  {item.sku}
                                </span>
                                <span className="text-[11px] font-black text-slate-900 uppercase truncate">{item.brand}</span>
                              </div>
                              <div className="text-[10px] text-slate-500 font-bold mt-0.5 truncate">
                                {item.model} • <span className="font-mono">{item.size}</span>
                                {isAdmin && item.companyName && <span className="text-slate-400"> • {item.companyName}</span>}
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <span className={`block text-[11px] font-black font-mono ${isLow ? "text-red-600" : "text-slate-700"}`}>
                                {isEntrada ? item.quantity : itemFree} un
                              </span>
                              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                                {isEntrada ? "em estoque" : "livre"}
                              </span>
                              {itemReserved > 0 && (
                                <span
                                  className="mt-0.5 inline-flex items-center gap-1 text-[9px] font-black text-white bg-amber-500 border border-amber-600 rounded px-1 py-0.5 uppercase tracking-wider shadow-xs"
                                  title={`${itemReserved} un reservadas para clientes ou transferências — bloqueadas para venda.`}
                                >
                                  <Lock size={8} className="stroke-[3px]" /> {itemReserved} reserv.
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {QUICK_QTY.map(q => (
                                <button
                                  key={q}
                                  type="button"
                                  onClick={e => { e.stopPropagation(); addToCart(item, q); }}
                                  disabled={mode === "SAIDA" && itemFree < 1}
                                  className={`h-7 w-7 rounded-lg text-[10px] font-black transition-all cursor-pointer disabled:opacity-30 ${
                                    isEntrada
                                      ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200"
                                      : "bg-red-50 text-red-700 hover:bg-red-600 hover:text-white border border-red-200"
                                  }`}
                                  title={`Adicionar ${q} un`}
                                >
                                  +{q}
                                </button>
                              ))}
                            </div>

                            {inCart && (
                              <span className={`shrink-0 h-6 min-w-6 px-1.5 rounded-lg text-[10px] font-black text-white flex items-center justify-center ${isEntrada ? "bg-emerald-600" : "bg-red-600"}`}>
                                {inCart.quantity}
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* ─── Coluna B: carrinho + dados da operação ─── */}
                <div className="lg:w-1/2 flex flex-col min-h-0 bg-slate-50">

                  {/* Itens selecionados */}
                  <div className="flex-1 overflow-y-auto min-h-[160px] p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                        Pneus da operação ({cartLines.length})
                      </span>
                      {cartLines.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setCart([])}
                          className="text-[10px] font-black text-red-600 hover:underline cursor-pointer uppercase tracking-wider"
                        >
                          Limpar tudo
                        </button>
                      )}
                    </div>

                    {cartLines.length === 0 ? (
                      <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white/60 p-8 text-center">
                        <Boxes size={32} className="mx-auto text-slate-200 mb-2" />
                        <p className="text-xs font-bold text-slate-600">Nenhum pneu selecionado ainda</p>
                        <p className="text-[10px] text-slate-400 font-semibold mt-1">
                          Clique nos pneus da lista ao lado ou use os botões +1 / +2 / +4.
                        </p>
                      </div>
                    ) : (
                      cartLines.map(line => (
                        <div
                          key={line.stockItemId}
                          className={`rounded-xl border bg-white p-3 space-y-2.5 transition-colors ${line.exceeds ? "border-red-300 ring-2 ring-red-500/10" : "border-slate-200"}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] font-mono font-extrabold text-gold-700 bg-gold-400/10 border border-gold-300/20 px-1.5 py-0.5 rounded uppercase">
                                  {line.item.sku}
                                </span>
                                <span className="text-[11px] font-black text-slate-900 uppercase truncate">{line.item.brand}</span>
                              </div>
                              <div className="text-[10px] text-slate-500 font-bold mt-0.5 truncate">
                                {line.item.model} • <span className="font-mono">{line.item.size}</span>
                                <span className="text-slate-400"> • saldo atual {line.item.quantity} un</span>
                                {reservedQuantityOf(line.item) > 0 && (
                                  <span className="text-amber-700 font-black"> • {reservedQuantityOf(line.item)} un reservadas (livre: {line.free} un)</span>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeLine(line.stockItemId)}
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer shrink-0"
                              title="Remover da operação"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>

                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            {/* Stepper de quantidade */}
                            <div className="flex items-center rounded-xl border border-slate-200 overflow-hidden bg-white">
                              <button
                                type="button"
                                onClick={() => setLineQuantity(line.stockItemId, line.quantity - 1)}
                                className="h-8 w-8 flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                <Minus size={13} className="stroke-[3]" />
                              </button>
                              <input
                                type="number"
                                min={1}
                                value={line.quantity}
                                onChange={e => setLineQuantity(line.stockItemId, parseInt(e.target.value, 10) || 1)}
                                className="h-8 w-14 text-center text-xs font-black font-mono text-slate-900 outline-none border-x border-slate-200"
                              />
                              <button
                                type="button"
                                onClick={() => setLineQuantity(line.stockItemId, line.quantity + 1)}
                                className="h-8 w-8 flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                <Plus size={13} className="stroke-[3]" />
                              </button>
                            </div>

                            {/* Valor unitário */}
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">
                                {isEntrada ? "Custo un." : "Preço un."}
                              </span>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={line.unitPrice || ""}
                                onChange={e => setLinePrice(line.stockItemId, parseFloat(e.target.value) || 0)}
                                placeholder="0,00"
                                className={`w-24 px-2 py-1.5 text-[11px] font-bold font-mono text-slate-800 bg-white border border-slate-200 rounded-lg outline-none focus:ring-4 transition-all ${accent.ring}`}
                              />
                            </div>

                            {/* Saldo resultante */}
                            <div className="text-right">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider block">Saldo final</span>
                              <span className={`text-xs font-black font-mono ${line.exceeds ? "text-red-600" : "text-slate-800"}`}>
                                {isEntrada ? line.item.quantity + line.quantity : line.item.quantity - line.quantity} un
                              </span>
                            </div>
                          </div>

                          {line.exceeds && (
                            <div className="flex items-center gap-1.5 text-[10px] font-black text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                              <AlertTriangle size={12} className="shrink-0" />
                              {line.blockedByReservation
                                ? `${reservedQuantityOf(line.item)} un estão reservadas para clientes ou transferências — livre para baixa: ${line.free} un.`
                                : `Saldo insuficiente: só há ${line.free} un disponíveis.`}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* Dados da operação */}
                  <div className="border-t border-slate-200 bg-white p-4 space-y-3 shrink-0">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                          Motivo *
                        </label>
                        <select
                          value={reasonChoice}
                          onChange={e => setReasonChoice(e.target.value)}
                          className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-bold cursor-pointer ${accent.ring}`}
                        >
                          {STOCK_FLOW_REASONS[mode].map(r => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                          {isEntrada ? "Nota fiscal / Pedido" : "OS / Cupom"}
                        </label>
                        <input
                          type="text"
                          value={docNumber}
                          onChange={e => setDocNumber(e.target.value)}
                          placeholder="Opcional"
                          className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${accent.ring}`}
                        />
                      </div>
                    </div>

                    {reasonChoice === "Outro" && (
                      <input
                        type="text"
                        value={customReason}
                        onChange={e => setCustomReason(e.target.value)}
                        placeholder="Descreva o motivo da operação *"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${accent.ring}`}
                      />
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                          {isEntrada ? "Fornecedor" : "Cliente"}
                        </label>
                        <input
                          type="text"
                          value={partyName}
                          onChange={e => setPartyName(e.target.value)}
                          placeholder="Opcional"
                          className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${accent.ring}`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                          {isEntrada ? "CNPJ / CPF" : "Placa"}
                        </label>
                        <input
                          type="text"
                          value={isEntrada ? partyDoc : vehiclePlate}
                          onChange={e => (isEntrada ? setPartyDoc(e.target.value) : setVehiclePlate(e.target.value.toUpperCase()))}
                          placeholder="Opcional"
                          className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold font-mono ${accent.ring}`}
                        />
                      </div>
                    </div>

                    <input
                      type="text"
                      value={observation}
                      onChange={e => setObservation(e.target.value)}
                      placeholder="Observação da operação (opcional)"
                      className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${accent.ring}`}
                    />

                    {error && (
                      <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-bold border-l-4 border-red-500 flex items-start gap-2">
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                        {error}
                      </div>
                    )}
                  </div>

                  {/* Rodapé fixo: totais + confirmar */}
                  <div className="border-t border-slate-200 bg-white px-4 py-3 flex items-center justify-between gap-3 shrink-0">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xl font-black font-mono leading-none ${isEntrada ? "text-emerald-600" : "text-red-600"}`}>
                          {isEntrada ? "+" : "-"}{cartUnits}
                        </span>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">un</span>
                      </div>
                      {cartTotal > 0 && (
                        <span className="text-[10px] font-bold text-slate-500 font-mono">{formatBRL(cartTotal)}</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={closeFlow}
                        disabled={submitting}
                        className="px-4 py-2.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer disabled:opacity-40"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        disabled={submitting || cartLines.length === 0 || hasBlockingLine}
                        className={`px-5 py-2.5 rounded-xl text-white text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:hover:scale-100 flex items-center gap-2 ${isEntrada ? "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20" : "bg-red-600 hover:bg-red-700 shadow-red-600/20"}`}
                      >
                        {submitting
                          ? <Loader2 size={14} className="animate-spin" />
                          : isEntrada ? <PackagePlus size={14} /> : <PackageMinus size={14} />}
                        {submitting ? "Gravando..." : isEntrada ? "Confirmar entrada" : "Confirmar saída"}
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
