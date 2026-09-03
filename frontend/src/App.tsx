import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";

// Hook into console to capture logs for error reporting
const consoleLogs: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  consoleLogs.push(`[LOG] ${msg}`);
  if (consoleLogs.length > 40) consoleLogs.shift();
  originalLog.apply(console, args);
};
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  consoleLogs.push(`[ERROR] ${msg}`);
  if (consoleLogs.length > 40) consoleLogs.shift();
  originalError.apply(console, args);
};
console.warn = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  consoleLogs.push(`[WARN] ${msg}`);
  if (consoleLogs.length > 40) consoleLogs.shift();
  originalWarn.apply(console, args);
};

(window as any).getConsoleLogs = () => consoleLogs;
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  writeBatch,
  limit,
  orderBy
} from "firebase/firestore";
import { auth, db } from "./firebase";
import {
  StockItem,
  MovementLog,
  UserProfile,
  UserRole,
  Company,
  TransferOrder,
  AppNotification,
  StockFlowPayload,
  StockFlowResult,
  StockFlowResultItem,
  StockFlowItemInput,
  SignatureMethod,
  TransferStatus,
  TransferRequestKind,
  TransferSyncResult,
  Suggestion,
  SuggestionStatus
} from "./types";
import { CLIENTE_COMPANY_ID, isCrossStoreReservation, isCustomerReservation, isReservationOrder } from "./types";
import { availableQuantity, formatDate, mapStockDoc, mapSuggestionDoc, reservedQuantityOf, suggestionTime, toMillis } from "./utils";
import { useAppNotifications } from "./hooks/useAppNotifications";

// Components
// AuthScreen is needed immediately on first paint (logged-out users see nothing else),
// so it stays a static import. Every tab below is only ever rendered one at a time behind
// activeTab, so each is code-split into its own chunk and fetched on first visit to that
// tab — keeps the initial bundle from dragging in things like the WebUSB ADB stack
// (ApkInstaller) for users who never open that tab.
import AuthScreen from "./components/AuthScreen";
import PublicStock from "./components/PublicStock"; // Nova tela de consulta
import PublicSignature from "./components/PublicSignature"; // Assinatura do motorista via link
const PDFImporter = lazy(() => import("./components/PDFImporter"));
const StockTable = lazy(() => import("./components/StockTable"));
const MovementReports = lazy(() => import("./components/MovementReports"));
const UsersAdmin = lazy(() => import("./components/UsersAdmin"));
const UnifiedStock = lazy(() => import("./components/UnifiedStock"));
const DashboardAnalytics = lazy(() => import("./components/DashboardAnalytics"));
const HowToUse = lazy(() => import("./components/HowToUse"));
const TransferOrders = lazy(() => import("./components/TransferOrders"));
const Reservations = lazy(() => import("./components/Reservations"));
const Suggestions = lazy(() => import("./components/Suggestions"));
const StockFlow = lazy(() => import("./components/StockFlow"));
const ApkInstaller = lazy(() =>
  import("./components/ApkInstaller").then(m => ({ default: m.ApkInstaller }))
);
import NotificationBell, { NotificationToast } from "./components/NotificationBell";
import ErrorBoundary from "./components/ErrorBoundary";

// Icons
import {
  LogOut,
  Warehouse,
  Layers,
  FileUp,
  Activity,
  User,
  ShieldCheck,
  TrendingUp,
  PackageCheck,
  PackageOpen,
  Users,
  Key,
  X,
  Loader2,
  BookOpen,
  ArrowLeftRight,
  ArrowDownUp,
  ShoppingBag,
  Smartphone,
  DollarSign,
  Search,
  Lightbulb
} from "lucide-react";

// Quantos registros de movimentacao ficam em memoria. 400 (e nao 150) porque o
// modulo de Entrada e Saida reagrupa esses mesmos documentos por operationId:
// uma unica operacao com 10 pneus consome 10 registros, entao uma janela curta
// apagaria o historico do dia rapido demais.
const MOVEMENTS_WINDOW = 400;

// Helper: maps a raw Firestore transfer document into a typed TransferOrder
function mapTransferDoc(docSnap: any): TransferOrder {
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    items: data.items || [],
    sourceCompanyId: data.sourceCompanyId || "",
    sourceCompanyName: data.sourceCompanyName || "",
    destinationCompanyId: data.destinationCompanyId || "",
    destinationCompanyName: data.destinationCompanyName || "",
    reason: data.reason || "",
    status: data.status || "PENDENTE",
    scheduledFor: data.scheduledFor || null,
    // Pedidos criados antes do fluxo de solicitacao nao tem requestKind: sao envios.
    requestKind: data.requestKind || "ENVIO",
    reservation: data.reservation || null,
    // Campos da reserva de cliente. Sem eles o App lia `undefined` em toda
    // decisao que depende de QUEM pediu: `isCrossStoreRequest` dava sempre falso
    // (nao dava para distinguir vendedor da casa de vendedor de outra filial) e
    // o nome do cliente nunca chegava na tela, virando sempre "o cliente".
    customerName: data.customerName || "",
    requestedByCompanyId: data.requestedByCompanyId || "",
    requestedByCompanyName: data.requestedByCompanyName || "",
    saleCompletedByUid: data.saleCompletedByUid || "",
    saleCompletedByName: data.saleCompletedByName || "",
    saleCompletedAt: data.saleCompletedAt,
    approvedByUid: data.approvedByUid || "",
    approvedByName: data.approvedByName || "",
    approvedAt: data.approvedAt,
    // Avais separados da reserva de vendedor. Sem estas linhas a aba Reservas
    // nunca saberia qual das duas confirmacoes ja chegou.
    sourceApprovedByUid: data.sourceApprovedByUid || "",
    sourceApprovedByName: data.sourceApprovedByName || "",
    sourceApprovedAt: data.sourceApprovedAt,
    adminApprovedByUid: data.adminApprovedByUid || "",
    adminApprovedByName: data.adminApprovedByName || "",
    adminApprovedAt: data.adminApprovedAt,
    rejectedByUid: data.rejectedByUid || "",
    rejectedByName: data.rejectedByName || "",
    rejectedAt: data.rejectedAt,
    rejectReason: data.rejectReason || "",
    requestedByUid: data.requestedByUid || "",
    requestedByEmail: data.requestedByEmail || "",
    requestedByName: data.requestedByName || "",
    requestedAt: data.requestedAt,
    delivery: data.delivery || null,
    receipt: data.receipt || null,
    // Assinaturas do fluxo de 4 vias (remetente + motorista na saida, motorista +
    // recebedor na chegada). Sem estas duas linhas a tela caia sempre no rotulo
    // "(Legado)" e o comprovante impresso perdia as assinaturas do motorista.
    dispatch: data.dispatch || null,
    arrival: data.arrival || null,
    cancelledByUid: data.cancelledByUid || "",
    cancelledByName: data.cancelledByName || "",
    cancelledAt: data.cancelledAt,
    cancelReason: data.cancelReason || "",
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

export default function App() {
  // O caminho chega com a barra final quando alguem copia o link do navegador
  // ou o WhatsApp "arruma" a URL. Sem normalizar, '/consulta/' nao batia com
  // nenhuma rota e caia na tela de login — o cliente abria o catalogo e via um
  // pedido de senha.
  const route = window.location.pathname.replace(/\/+$/, "") || "/";

  // Se for a rota pública, renderiza apenas o estoque público e ignora todo o resto
  if (route === '/consulta') {
    return <PublicStock />;
  }

  // Pagina publica de assinatura do motorista. Ele nao tem login: chega por um
  // link com token e assina ali. Fica antes de qualquer checagem de sessao.
  if (route === '/assinar') {
    return <PublicSignature />;
  }

  const [user, setUser] = useState<{ uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string; credentialId?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [kpiCompanyId, setKpiCompanyId] = useState<string>("ALL");
  
  // Data State
  const [stock, setStock] = useState<StockItem[]>([]);
  const [movements, setMovements] = useState<MovementLog[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Inter-company Transfer Orders State (raw per-query arrays, merged below)
  const [transfersAsSource, setTransfersAsSource] = useState<TransferOrder[]>([]);
  const [transfersAsDestination, setTransfersAsDestination] = useState<TransferOrder[]>([]);
  // Reservas abertas por vendedores DESTA loja num pneu de outra filial. Enquanto
  // estão em análise, nem a origem nem o destino são a loja do vendedor, então
  // elas não caem em nenhuma das duas consultas acima — sem esta terceira, o dono
  // não veria na aba Reservas o pedido que o próprio vendedor dele abriu.
  const [transfersAsRequester, setTransfersAsRequester] = useState<TransferOrder[]>([]);
  // True once every attached transfer listener has delivered its first snapshot.
  // Gates the notification center's diffing so login doesn't replay transfer
  // history as a flood of "new transfer" alerts — see useAppNotifications.
  const [transfersReady, setTransfersReady] = useState(false);

  // Sugestões de compra vindas do balcão (o pneu que o cliente pediu e a loja
  // não tinha). Coleção própria, sem relação com estoque ou transferência: é a
  // caixa de entrada do dono da loja. O vendedor NÃO recebe este feed — ele só
  // escreve, e acompanha o que mandou dentro do próprio catálogo.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  // Support and Error Report State
  const [showReportModal, setShowReportModal] = useState(false);
  const [errorComment, setErrorComment] = useState("");
  const [sendLogs, setSendLogs] = useState(true);

  // Change Password Modal state
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState("");

  // Active Tab/View state
  const [activeTab, setActiveTab] = useState<"inventory" | "unified" | "analytics" | "stock-flow" | "pdf-import" | "reports" | "transfers" | "reservations" | "users-admin" | "how-to-use" | "apk-installer" | "catalogo" | "suggestions">("analytics");

  // Authentication Status listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const secAuthKey = `sec_auth_${firebaseUser.uid}`;
          const isSecAuthed = sessionStorage.getItem(secAuthKey) === "true" || localStorage.getItem(secAuthKey) === "true";
          
          if (!isSecAuthed) {
            setUser(null);
            setAuthLoading(false);
            return;
          }

          // Get the stored user credential details
          const cachedUserStr = sessionStorage.getItem(`${secAuthKey}_user`) || localStorage.getItem(`${secAuthKey}_user`);
          let role: UserRole = "alimentador";
          let displayName = firebaseUser.displayName || "Usuário comum";
          let companyId = "";
          let companyName = "";
          let credentialId = "";

          if (cachedUserStr) {
            try {
              const cachedUser = JSON.parse(cachedUserStr);
              let parsedRole = cachedUser.role || "alimentador";
              if (parsedRole === "user") parsedRole = "alimentador"; // Map legacy users
              role = parsedRole;
              displayName = cachedUser.displayName || displayName;
              companyId = cachedUser.companyId || "";
              companyName = cachedUser.companyName || "";
              credentialId = cachedUser.id || "";
            } catch (e) {
              console.error("Failed to parse cached secondary credentials", e);
            }
          }

          // Safe guards for administrative emails
          const targetEmail = (firebaseUser.email || "").toLowerCase().trim();
          if (targetEmail === "brisasofc@gmail.com" || targetEmail === "isaacbomfim.te@gmail.com" || targetEmail === "isaacbomfim.00@gmail.com") {
            role = "admin";
          }

          setUser({
            uid: firebaseUser.uid,
            email: firebaseUser.email || "",
            displayName,
            role,
            companyId,
            companyName,
            credentialId
          });

          // Default tab logic based on role
          setActiveTab(role === "vendedor" ? "catalogo" : "unified");
        } catch (profileError) {
          console.error("Erro ao recuperar perfil:", profileError);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  // Listen to Firestore Stock and movements data in real-time
  useEffect(() => {
    if (!user) {
      setStock([]);
      setMovements([]);
      return;
    }

    setLoadingData(true);

    // Queries setup
    const stockCollectionRef = collection(db, "stock");
    const movementsCollectionRef = collection(db, "movements");

    // Everyone reads the full stock collection now — an alimentador needs to see other
    // filiais' stock to know whether it's worth requesting a transfer (Firestore rules
    // still restrict writes to each user's own company; see ownScopedStock below for
    // the views that should stay limited to "my company only").
    const stockQuery = stockCollectionRef;

    const movementsQuery = (user.role === "admin" || user.role === "vendedor" || !user.companyId)
      ? query(movementsCollectionRef, orderBy("timestamp", "desc"), limit(MOVEMENTS_WINDOW))
      : query(movementsCollectionRef, where("companyId", "==", user.companyId), orderBy("timestamp", "desc"), limit(MOVEMENTS_WINDOW));

    // Listen to inventory changes
    const unsubStock = onSnapshot(stockQuery, (snapshot) => {
      const itemsList: StockItem[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        // Conversao unica, compartilhada com o catalogo publico. Este objeto
        // era montado a mao aqui e nao trazia priceCash/priceInstallment: o
        // preco a prazo ia para o banco e nunca voltava para a tela.
        itemsList.push(mapStockDoc(docSnap.id, data));
      });

      // Sort by creation or update descending in memory to avoid index requirements
      const sortedItems = itemsList.sort((a, b) => {
        const timeA = a.updatedAt?.seconds || a.createdAt?.seconds || 0;
        const timeB = b.updatedAt?.seconds || b.createdAt?.seconds || 0;
        return timeB - timeA;
      });

      setStock(sortedItems);
      setLoadingData(false);
    }, (error) => {
      console.error("Error fetching stock:", error);
      setLoadingData(false);
    });

    // Listen to audit logs changes.
    // Extraido como funcao porque o mesmo tratamento serve tanto para a consulta
    // indexada quanto para a consulta alternativa usada quando o indice composto
    // ainda nao existe (ver o onError logo abaixo).
    const applyMovementsSnapshot = (snapshot: any) => {
      const logsList: MovementLog[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        logsList.push({
          id: docSnap.id,
          sku: data.sku || "",
          brand: data.brand || "",
          model: data.model || "",
          size: data.size || "",
          type: data.type || "ENTRADA",
          quantity: data.quantity ?? 0,
          balanceAfter: data.balanceAfter ?? 0,
          userId: data.userId || "",
          userEmail: data.userEmail || "",
          companyId: data.companyId || "",
          companyName: data.companyName || "",
          timestamp: data.timestamp,
          reason: data.reason || "",
          // Campos do modulo de Entrada e Saida (ausentes nos registros antigos)
          operationId: data.operationId || "",
          operationReason: data.operationReason || "",
          docNumber: data.docNumber || "",
          partyName: data.partyName || "",
          partyDoc: data.partyDoc || "",
          vehiclePlate: data.vehiclePlate || "",
          observation: data.observation || "",
          unitPrice: data.unitPrice ?? 0,
          totalAmount: data.totalAmount ?? 0,
          reversalOf: data.reversalOf || "",
          transferId: data.transferId || "",
          rebuilt: data.rebuilt === true
        });
      });

      // Sort logs by newest first in memory
      const sortedLogs = logsList.sort((a, b) => {
        const timeA = a.timestamp?.seconds || 0;
        const timeB = b.timestamp?.seconds || 0;
        return timeB - timeA;
      });

      // O corte final acontece aqui (e nao so no limit da consulta) porque a
      // consulta alternativa abaixo nao usa limit — ela traz a empresa inteira.
      setMovements(sortedLogs.slice(0, MOVEMENTS_WINDOW));
    };

    const movementUnsubs: (() => void)[] = [];

    movementUnsubs.push(onSnapshot(movementsQuery, applyMovementsSnapshot, (error: any) => {
      // Filtrar por companyId E ordenar por timestamp exige um indice composto no
      // Firestore (movements: companyId ASC + timestamp DESC — ver
      // firestore.indexes.json na raiz do repositorio). Enquanto ele nao existe,
      // ou enquanto esta sendo construido, o Firestore devolve failed-precondition
      // e a tela de Auditoria e o modulo de Entradas e Saidas ficariam vazios.
      // Nesse caso caimos para uma consulta so por empresa, ordenando em memoria:
      // custa mais leituras, mas devolve o dado certo em vez de nada.
      if (error?.code === "failed-precondition" && user.companyId) {
        console.warn(
          "[MOVIMENTOS] Indice composto ausente no Firestore — usando consulta alternativa. " +
          "Para restaurar a consulta rapida rode: firebase deploy --only firestore:indexes"
        );
        movementUnsubs.push(onSnapshot(
          query(movementsCollectionRef, where("companyId", "==", user.companyId)),
          applyMovementsSnapshot,
          (fallbackError) => console.error("Error fetching movements (fallback):", fallbackError)
        ));
        return;
      }
      console.error("Error fetching movements:", error);
    }));

    return () => {
      unsubStock();
      movementUnsubs.forEach(unsub => unsub());
    };
  }, [user]);

  // Mirrors `stock` for the two timers below, which fire on a schedule (not on
  // every stock edit) and just need "whatever stock looks like right now" at
  // the moment they actually run — reading it via ref instead of a `stock`
  // effect-dependency keeps those timers from tearing down/rebuilding on every
  // single Firestore update while the user is editing inventory.
  const stockRef = useRef<StockItem[]>([]);
  useEffect(() => {
    stockRef.current = stock;
  }, [stock]);

  // Trigger backup once a day when logged in as admin or alimentador.
  // `dailyBackupStateRef` guards against firing twice: `stock` still needs to be
  // in the dependency array (we retry once real inventory data has loaded), but
  // without this guard, several stock updates arriving in quick succession while
  // the first backup POST is still in flight would each pass the "not done yet"
  // localStorage check and fire their own duplicate request to the backend.
  const dailyBackupStateRef = useRef<"idle" | "in-flight" | "done">("idle");
  useEffect(() => {
    if (!user) {
      dailyBackupStateRef.current = "idle";
      return;
    }
    if (loadingData || stock.length === 0) return;
    if (user.role !== "admin" && user.role !== "alimentador") return;
    if (dailyBackupStateRef.current !== "idle") return;

    const todayStr = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(`last_stock_backup_date_${user.uid}`) === todayStr) {
      dailyBackupStateRef.current = "done";
      return;
    }

    dailyBackupStateRef.current = "in-flight";

    const runDailyBackup = async () => {
      try {
        console.log("[BACKUP] Starting daily backup automation...");

        // 1. Save in local storage
        const backupPayload = {
          date: new Date().toISOString(),
          userEmail: user.email,
          companyName: user.companyName || "Geral",
          items: stock
        };
        localStorage.setItem(`stock_backup_data_${user.uid}`, JSON.stringify(backupPayload));

        // 2. Save on backend disk
        const apiUrl = import.meta.env.VITE_API_URL || "https://central-estoque-v1.onrender.com";
        const response = await fetch(`${apiUrl}/api/backup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: stock,
            userEmail: user.email,
            companyName: user.companyName || "Geral"
          })
        });

        if (response.ok) {
          console.log("[BACKUP] Daily backup saved on server successfully.");
          localStorage.setItem(`last_stock_backup_date_${user.uid}`, todayStr);
          dailyBackupStateRef.current = "done";
        } else {
          console.warn("[BACKUP] Server daily backup failed.");
          dailyBackupStateRef.current = "idle"; // allow a retry on the next stock update
        }
      } catch (backupErr) {
        console.error("[BACKUP] Error running daily backup:", backupErr);
        dailyBackupStateRef.current = "idle"; // allow a retry on the next stock update
      }
    };

    runDailyBackup();
  }, [user, stock, loadingData]);

  // Trigger automatic download of stock backup file at 18:00.
  // Set up once per login (not re-armed on every stock change — see stockRef
  // above) so the 30s interval isn't torn down and recreated on every edit.
  useEffect(() => {
    if (!user || loadingData) return;
    if (user.role !== "admin" && user.role !== "alimentador") return;

    const checkAndDownloadBackup = () => {
      try {
        const currentStock = stockRef.current;
        if (currentStock.length === 0) return;

        const now = new Date();
        const currentHour = now.getHours();
        const todayStr = now.toISOString().slice(0, 10);

        // Only trigger if it is 18:00 (6:00 PM) or later
        if (currentHour >= 18) {
          const lastDownloadedDate = localStorage.getItem(`last_file_backup_download_date_${user.uid}`);
          if (lastDownloadedDate !== todayStr) {
            // Set first to prevent double triggers across concurrent tabs
            localStorage.setItem(`last_file_backup_download_date_${user.uid}`, todayStr);

            console.log("[BACKUP] Past 18:00. Triggering automated file backup download...");

            // Create and trigger download
            const backupPayload = {
              date: now.toISOString(),
              userEmail: user.email,
              companyName: user.companyName || "Geral",
              items: currentStock
            };
            const jsonString = JSON.stringify(backupPayload, null, 2);
            const blob = new Blob([jsonString], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `backup_diario_central_estoque_${todayStr}.json`;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
          }
        }
      } catch (err) {
        console.error("Erro no backup automático de arquivo:", err);
      }
    };

    // Run check immediately on mount/update
    checkAndDownloadBackup();

    // Check every 30 seconds
    const interval = setInterval(checkAndDownloadBackup, 30000);
    return () => clearInterval(interval);
  }, [user, loadingData]);

  // Listen to companies in real-time
  useEffect(() => {
    if (!user) {
      setCompanies([]);
      return;
    }
    const unsubCompanies = onSnapshot(collection(db, "companies"), (snapshot) => {
      const list: Company[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          name: data.name || "",
          description: data.description || "",
          createdAt: data.createdAt
        });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      setCompanies(list);
    }, (error) => {
      console.error("Error reading companies:", error);
    });

    return () => {
      unsubCompanies();
    };
  }, [user]);

  // Listen to inter-company Transfer Orders in real-time.
  // Admins/Vendedores see every transfer (single unfiltered query, same pattern
  // used for stock/movements). Alimentadores see transfers where their company is
  // EITHER the source OR the destination — implemented as two plain equality
  // queries merged in memory below, rather than a single or() composite query,
  // to stay consistent with how this codebase already handles stock/movements
  // (query then sort/merge client-side, avoiding any untested query shape).
  useEffect(() => {
    if (!user) {
      setTransfersAsSource([]);
      setTransfersAsDestination([]);
      setTransfersAsRequester([]);
      setTransfersReady(false);
      return;
    }

    setTransfersReady(false);
    const transfersRef = collection(db, "transfers");
    const isGlobalAdmin = user.role === "admin" && (!user.companyId || user.email === "brisasofc@gmail.com" || user.email === "isaacbomfim.te@gmail.com" || user.email === "isaacbomfim.00@gmail.com");
    // "Minhas Reservas" do vendedor lista só o que ele pediu — não o movimento
    // de transferência das filiais, que não é assunto dele.
    const isSellerScoped = user.role === "vendedor";
    const isGlobalViewer = !isSellerScoped && (isGlobalAdmin || !user.companyId);

    // Both listeners must deliver at least one snapshot before we consider the
    // transfer feed "ready" (see transfersReady usage in useAppNotifications).
    let sourceLoaded = false;
    let destinationLoaded = isGlobalViewer || isSellerScoped; // no second listener attached in these cases
    const markReadyIfComplete = () => {
      if (sourceLoaded && destinationLoaded) setTransfersReady(true);
    };

    const sourceQuery = isSellerScoped
      ? query(transfersRef, where("requestedByUid", "==", user.uid))
      : isGlobalViewer
      ? transfersRef
      : query(transfersRef, where("sourceCompanyId", "==", user.companyId));

    const unsubSource = onSnapshot(sourceQuery, (snapshot) => {
      const list: TransferOrder[] = [];
      snapshot.forEach(docSnap => list.push(mapTransferDoc(docSnap)));
      setTransfersAsSource(list);
      sourceLoaded = true;
      markReadyIfComplete();
    }, (error) => {
      console.error("Error fetching source transfers:", error);
    });

    let unsubDestination = () => {};
    let unsubRequester = () => {};
    if (!isGlobalViewer && !isSellerScoped) {
      const destinationQuery = query(transfersRef, where("destinationCompanyId", "==", user.companyId));
      unsubDestination = onSnapshot(destinationQuery, (snapshot) => {
        const list: TransferOrder[] = [];
        snapshot.forEach(docSnap => list.push(mapTransferDoc(docSnap)));
        setTransfersAsDestination(list);
        destinationLoaded = true;
        markReadyIfComplete();
      }, (error) => {
        console.error("Error fetching destination transfers:", error);
      });

      // Terceira consulta, só para o dono da loja: as reservas que os vendedores
      // dele abriram em pneus de OUTRAS filiais. Não entra em `markReadyIfComplete`
      // de propósito — é um complemento da aba Reservas, e travar o feed de
      // notificações à espera dela atrasaria tudo o mais por nada.
      const requesterQuery = query(transfersRef, where("requestedByCompanyId", "==", user.companyId));
      unsubRequester = onSnapshot(requesterQuery, (snapshot) => {
        const list: TransferOrder[] = [];
        snapshot.forEach(docSnap => list.push(mapTransferDoc(docSnap)));
        setTransfersAsRequester(list);
      }, (error) => {
        console.error("Error fetching requester transfers:", error);
      });
    } else {
      setTransfersAsDestination([]);
      setTransfersAsRequester([]);
    }

    return () => {
      unsubSource();
      unsubDestination();
      unsubRequester();
    };
  }, [user]);

  // ── Sugestões de compra ────────────────────────────────────────────
  // Caixa de entrada do DONO DA LOJA. Uma consulta só, por igualdade em
  // companyId, ordenada em memória — mesmo padrão de stock/movements, e sem
  // índice composto novo. O ADMIN lê a coleção inteira.
  //
  // O vendedor não entra aqui de propósito: ele escreve a sugestão e acompanha
  // o que mandou dentro do próprio catálogo, com um listener que só existe
  // enquanto o painel dele está aberto. Manter um feed ligado a sessão inteira
  // dele seria leitura paga por uma tela que ele quase nunca abre.
  useEffect(() => {
    // Sem loja não existe caixa de entrada para filtrar, e uma leitura da
    // coleção inteira seria recusada pelas regras (só o admin lê tudo) — o
    // painel abriria vazio com um erro no console em vez de uma explicação.
    // Mesma condição de `canSeeSuggestions`, que esconde a aba nesse caso.
    if (!user || !(user.role === "admin" || (user.role === "alimentador" && user.companyId))) {
      setSuggestions([]);
      return;
    }

    const suggestionsRef = collection(db, "suggestions");
    const suggestionsQuery = user.role === "admin"
      ? suggestionsRef
      : query(suggestionsRef, where("companyId", "==", user.companyId));

    const unsub = onSnapshot(suggestionsQuery, (snapshot) => {
      const list: Suggestion[] = [];
      snapshot.forEach(docSnap => list.push(mapSuggestionDoc(docSnap.id, docSnap.data())));
      list.sort((a, b) => suggestionTime(b) - suggestionTime(a));
      setSuggestions(list);
    }, (error) => {
      console.error("Erro ao ler sugestões:", error);
    });

    return unsub;
  }, [user]);

  // Merge + dedupe the two transfer listeners into a single sorted list.
  // (For a global viewer, transfersAsDestination is always empty, so this is a no-op merge.)
  const transfers = useMemo(() => {
    const map = new Map<string, TransferOrder>();
    transfersAsSource.forEach(t => map.set(t.id, t));
    transfersAsDestination.forEach(t => map.set(t.id, t));
    transfersAsRequester.forEach(t => map.set(t.id, t));
    return Array.from(map.values()).sort((a, b) => {
      const timeA = toMillis(a.updatedAt) || toMillis(a.requestedAt);
      const timeB = toMillis(b.updatedAt) || toMillis(b.requestedAt);
      return timeB - timeA;
    });
  }, [transfersAsSource, transfersAsDestination, transfersAsRequester]);

  // Toda a vida de uma reserva de cliente, em qualquer fase — inclusive depois de
  // ela virar transferência entre filiais. Alimenta a aba Reservas.
  const reservations = useMemo(
    () => transfers.filter(t => isReservationOrder(t)),
    [transfers]
  );

  // Selo do menu: quantas reservas dependem de uma decisão de QUEM ESTÁ LOGADO.
  // O vendedor conta as próprias reservas ainda em análise (é o que ele quer
  // saber: "já liberaram meu pneu?"); quem decide conta as que travam o estoque
  // dele. Sem este número, a fila só existiria depois de alguém abrir a aba.
  const pendingReservationsCount = useMemo(() => {
    if (!user) return 0;
    if (user.role === "vendedor") {
      return reservations.filter(t => t.status === "SOLICITADO" && t.requestedByUid === user.uid).length;
    }
    const isSourceOwner = (t: TransferOrder) =>
      user.role === "alimentador" && !!user.companyId && t.sourceCompanyId === user.companyId;
    return reservations.filter(t => {
      // Pneu preso por um pedido que já morreu não é fila de trabalho de
      // ninguém — mas é o único estado em que o estoque mente sem alarme. Entra
      // no selo do administrador, que é quem tem o botão de destravar.
      const stuck =
        user.role === "admin" &&
        t.reservation?.active === true &&
        (t.status === "CANCELADO" || t.status === "RECUSADO" || t.status === "CONCLUIDO");
      if (stuck) return true;
      if (t.status !== "SOLICITADO") return false;
      if (user.role === "admin") return true;
      return isSourceOwner(t);
    }).length;
  }, [reservations, user]);

  // Stock scoped to "my own company" — used for the KPI header cards and the
  // Cadastros e Ajustes (StockTable) editing view, which should stay focused on the
  // logged-in company even though `stock` itself now holds every company's items
  // (everyone can read all stock so alimentadores can check other filiais before
  // requesting a transfer — see the stock query above). Admins/vendedores (global
  // viewers) keep seeing everything here too, matching their existing scope.
  const ownScopedStock = useMemo(() => {
    if (!user) return [];
    const isGlobalViewer = user.role === "admin" || user.role === "vendedor" || !user.companyId;
    return isGlobalViewer ? stock : stock.filter(item => item.companyId === user.companyId);
  }, [stock, user]);

  // Notification Center: derives the bell feed from the real-time transfer/stock
  // streams above (new transfer requests, dispatch/receipt signatures, cancellations,
  // low/zero stock). See hooks/useAppNotifications.ts for the diffing + persistence logic.
  const { notifications, unreadCount, markAllAsRead, markAsRead } = useAppNotifications(
    user,
    transfers,
    transfersReady,
    stock,
    !loadingData
  );

  // Quem abre a aba de cadastro de acessos. O ADMIN administra o sistema inteiro
  // (operadores, empresas, backup). O DONO DA EMPRESA abre a mesma aba reduzida a
  // cadastrar os VENDEDORES da própria loja — e só faz sentido se a credencial
  // dele estiver vinculada a uma empresa: sem loja não há vendedor para vincular.
  const canManageUsers =
    user?.role === "admin" || (user?.role === "alimentador" && !!user?.companyId);

  // Quem abre a aba SUGESTÕES. TODO dono de empresa tem esta aba — inclusive o
  // dono sem loja vinculada, que cai no mesmo feed global do admin (não existe
  // "a minha loja" para filtrar). O vendedor fica de fora: ele é quem manda o
  // recado, não quem decide a compra.
  // Vinculada a uma loja pela mesma razão de `canManageUsers` logo acima: a
  // aba é a caixa de entrada DE UMA LOJA, e uma credencial criada como "Todas
  // as Empresas" não tem loja para receber nada.
  const canSeeSuggestions =
    user?.role === "admin" || (user?.role === "alimentador" && !!user?.companyId);

  // Selo do menu: sugestões ainda sem desfecho. `suggestions` já chega filtrado
  // pela loja de quem está logado (ver o listener acima), então basta contar.
  const pendingSuggestionsCount = useMemo(
    () => suggestions.filter(s => s.status === "ABERTA").length,
    [suggestions]
  );

  // O vendedor só opera duas telas. Qualquer caminho que tente levá-lo a outra
  // (clique em notificação, estado antigo restaurado) volta para o catálogo, em
  // vez de renderizar um painel administrativo atrás de um aviso.
  useEffect(() => {
    if (user?.role === "vendedor" && activeTab !== "catalogo" && activeTab !== "reservations") {
      setActiveTab("catalogo");
    }
  }, [user, activeTab]);

  const handleNotificationClick = (notification: AppNotification) => {
    markAsRead(notification.id);
    if (notification.targetTab) {
      setActiveTab(notification.targetTab);
    }
  };

  // Mirrors `transfers` for the heartbeat below, same rationale as stockRef above.
  const transfersRef = useRef<TransferOrder[]>([]);
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  // Heartbeat: promote scheduled transfers (AGENDADO) to actionable (PENDENTE) once their
  // scheduled date/time has passed. Runs on mount and every 30s while the app is open —
  // the same "check on load / while open" pattern already used for the daily backup
  // automations below, since there is no server-side cron in this project. Set up once
  // per login (`[user]` only, reading transfersRef for fresh data) rather than on every
  // transfer change, and `promotingTransferIdsRef` prevents firing a second updateDoc for
  // the same transfer while an earlier one is still in flight.
  const promotingTransferIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!user) return;

    const promoteDueScheduledTransfers = async () => {
      const now = Date.now();
      const due = transfersRef.current.filter(t =>
        t.status === "AGENDADO" &&
        t.scheduledFor &&
        toMillis(t.scheduledFor) <= now &&
        !promotingTransferIdsRef.current.has(t.id)
      );

      for (const t of due) {
        promotingTransferIdsRef.current.add(t.id);
        try {
          await updateDoc(doc(db, "transfers", t.id), {
            status: "PENDENTE",
            updatedAt: serverTimestamp()
          });
          console.log(`[TRANSFERENCIAS] Pedido ${t.id} liberado para assinatura (data agendada atingida).`);
        } catch (err) {
          console.error(`[TRANSFERENCIAS] Falha ao liberar pedido agendado ${t.id}:`, err);
          promotingTransferIdsRef.current.delete(t.id); // allow a retry on the next tick
        }
      }
    };

    promoteDueScheduledTransfers();
    const interval = setInterval(promoteDueScheduledTransfers, 30000);
    return () => clearInterval(interval);
  }, [user]);

  // Handle Logout action
  const handleLogout = async () => {
    try {
      const currentUid = auth.currentUser?.uid;
      if (currentUid) {
        const secAuthKey = `sec_auth_${currentUid}`;
        sessionStorage.removeItem(secAuthKey);
        sessionStorage.removeItem(`${secAuthKey}_user`);
        localStorage.removeItem(secAuthKey);
        localStorage.removeItem(`${secAuthKey}_user`);
      }
      sessionStorage.removeItem("cached_google_auth");
      await signOut(auth);
      setUser(null);
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  // Change Password logic for the operator
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !user.credentialId) return;
    if (!newPassword.trim()) {
      setChangePasswordError("A nova senha não pode estar em branco.");
      return;
    }
    setChangePasswordLoading(true);
    setChangePasswordError("");
    try {
      const docRef = doc(db, "custom_credentials", user.credentialId);
      
      // Get current doc to merge other fields to satisfy security rules
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        throw new Error("Credencial não localizada no servidor.");
      }
      
      const currentData = snap.data();
      
      await updateDoc(docRef, {
        ...currentData,
        password: newPassword.trim(),
        updatedAt: serverTimestamp()
      });
      
      // Update local storage cached credentials
      const secAuthKey = `sec_auth_${user.uid}`;
      const cachedStr = sessionStorage.getItem(`${secAuthKey}_user`) || localStorage.getItem(`${secAuthKey}_user`);
      if (cachedStr) {
        const cached = JSON.parse(cachedStr);
        cached.password = newPassword.trim();
        sessionStorage.setItem(`${secAuthKey}_user`, JSON.stringify(cached));
        localStorage.setItem(`${secAuthKey}_user`, JSON.stringify(cached));
      }
      
      alert("Senha atualizada com sucesso!");
      setShowChangePasswordModal(false);
      setNewPassword("");
    } catch (err: any) {
      console.error(err);
      setChangePasswordError(err.message || "Erro ao alterar a senha.");
    } finally {
      setChangePasswordLoading(false);
    }
  };

  // Add Tire Manual Form handler
  const handleAddItem = async (itemData: Omit<StockItem, "id" | "userId" | "userEmail" | "createdAt" | "updatedAt">) => {
    if (!user) return;

    try {
      const batch = writeBatch(db);
      const stockRef = doc(collection(db, "stock"));
      const movementRef = doc(collection(db, "movements"));

      batch.set(stockRef, {
        ...itemData,
        companyId: itemData.companyId || user.companyId || "",
        companyName: itemData.companyName || user.companyName || "",
        userId: user.uid,
        userEmail: user.email,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      batch.set(movementRef, {
        sku: itemData.sku,
        brand: itemData.brand,
        model: itemData.model,
        size: itemData.size,
        type: "ENTRADA",
        quantity: itemData.quantity,
        balanceAfter: itemData.quantity,
        companyId: itemData.companyId || user.companyId || "",
        companyName: itemData.companyName || user.companyName || "",
        userId: user.uid,
        userEmail: user.email,
        timestamp: serverTimestamp(),
        reason: "Cadastro inicial manual de pneu"
      });

      await batch.commit();
    } catch (error) {
      console.error("Erro ao cadastrar pneu:", error);
      throw new Error("Erro ao salvar produto no banco de dados.");
    }
  };

  // Save imported tires in bulk (multi-format import)
  const handleSaveImportedItems = async (items: (Omit<StockItem, "id" | "sku" | "userId" | "userEmail" | "createdAt" | "updatedAt" | "virtualId"> & { companyId?: string; companyName?: string })[]) => {
    if (!user) return;

    try {
      const batch = writeBatch(db);
      for (const [idx, item] of items.entries()) {
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const skuPrefix = `PNEU-${randomSuffix}`;

        const stockRef = doc(collection(db, "stock"));
        const movementRef = doc(collection(db, "movements"));

        batch.set(stockRef, {
          sku: skuPrefix,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          companyId: item.companyId || user.companyId || "",
          companyName: item.companyName || user.companyName || "",
          userId: user.uid,
          userEmail: user.email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        batch.set(movementRef, {
          sku: skuPrefix,
          brand: item.brand,
          model: item.model,
          size: item.size,
          type: "IMPORTACAO",
          quantity: item.quantity,
          balanceAfter: item.quantity,
          companyId: item.companyId || user.companyId || "",
          companyName: item.companyName || user.companyName || "",
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: `Importado via sistema (${idx + 1}/${items.length})`
        });
      }
      await batch.commit();
    } catch (err) {
      console.error("Error saving bulk PDF tires:", err);
      throw new Error("Erro ao processar as inserções no banco de dados.");
    }
  };

  // Edit stock card & compute delta quantities for history logs
  const handleUpdateItem = async (
    itemId: string, 
    updatedFields: Partial<StockItem>, 
    reason: string, 
    quantityDiff: number = 0,
    extraMovementFields?: Record<string, any>
  ) => {
    if (!user) return;

    // Trava de reserva: um pneu prometido a outra empresa nao pode ser baixado.
    // Vale para qualquer caminho que reduza o saldo por aqui (edicao do cadastro,
    // baixa rapida do celular, checkout de venda do StockTable).
    if (updatedFields.quantity !== undefined) {
      const current = stock.find(item => item.id === itemId);
      const reserved = reservedQuantityOf(current);
      const nextQuantity = Number(updatedFields.quantity) || 0;
      if (reserved > 0 && nextQuantity < reserved) {
        throw new Error(
          `Este pneu tem ${reserved} un reservadas para um cliente ou para uma transferência. ` +
          `O saldo não pode ficar abaixo disso — resolva a reserva na aba Reservas ` +
          `(confirmar, recusar ou cancelar) antes de dar baixa.`
        );
      }
    }

    try {
      const batch = writeBatch(db);
      const itemDocRef = doc(db, "stock", itemId);

      batch.update(itemDocRef, {
        ...updatedFields,
        updatedAt: serverTimestamp()
      });

      // Find the existing item in local state to retrieve complete metadata
      const existingItem = stock.find(item => item.id === itemId);
      const mergedItem = {
        ...existingItem,
        ...updatedFields
      };

      const matchedCompanyId = mergedItem.companyId || user.companyId || "";
      const matchedCompanyName = mergedItem.companyName || user.companyName || "";

      const movementRef = doc(collection(db, "movements"));
      if (quantityDiff !== 0) {
        batch.set(movementRef, {
          sku: mergedItem.sku || "N/A",
          brand: mergedItem.brand || "N/A",
          model: mergedItem.model || "N/A",
          size: mergedItem.size || "N/A",
          type: quantityDiff > 0 ? "ENTRADA" : "SAIDA",
          quantity: quantityDiff,
          balanceAfter: mergedItem.quantity || 0,
          companyId: matchedCompanyId,
          companyName: matchedCompanyName,
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: reason || "Ajuste físico de inventário",
          ...extraMovementFields
        });
      } else {
        batch.set(movementRef, {
          sku: mergedItem.sku || "N/A",
          brand: mergedItem.brand || "N/A",
          model: mergedItem.model || "N/A",
          size: mergedItem.size || "N/A",
          type: "AJUSTE",
          quantity: 0,
          balanceAfter: mergedItem.quantity || 0,
          companyId: matchedCompanyId,
          companyName: matchedCompanyName,
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: reason || "Dados cadastrais atualizados",
          ...extraMovementFields
        });
      }

      await batch.commit();
    } catch (err) {
      // A causa real NAO pode morrer aqui. Enquanto esta mensagem era um
      // "Erro ao gravar alteracoes." seco, uma recusa do banco, um campo
      // invalido e uma queda de rede chegavam na tela iguais — e cada relato de
      // "nao salva" virava adivinhacao. O codigo do Firestore
      // (permission-denied, invalid-argument, unavailable...) diz qual e.
      console.error("Erro ao atualizar item:", err);
      const code = (err as any)?.code;
      const detail = (err as any)?.message || String(err);
      if (code === "permission-denied") {
        throw new Error(
          "O banco recusou a gravação por permissão. Se a empresa da sua credencial mudou " +
          "recentemente, saia e entre novamente no sistema."
        );
      }
      if (code === "unavailable" || code === "deadline-exceeded") {
        throw new Error(
          "Sem conexão com o banco no momento — a alteração não foi gravada. " +
          "Verifique a internet e tente de novo."
        );
      }
      throw new Error(`Erro ao gravar alterações${code ? ` (${code})` : ""}: ${detail}`);
    }
  };

  // Remove pneu & audit exit
  const handleDeleteItem = async (itemId: string) => {
    if (!user) return;

    try {
      const itemToDrop = stock.find(item => item.id === itemId);
      if (!itemToDrop) return;

      const reserved = reservedQuantityOf(itemToDrop);
      if (reserved > 0) {
        throw new Error(
          `Não é possível excluir: ${reserved} un deste pneu estão reservadas para um cliente ou ` +
          `para uma transferência. Resolva a reserva na aba Reservas primeiro.`
        );
      }

      const batch = writeBatch(db);
      const itemDocRef = doc(db, "stock", itemId);
      const movementRef = doc(collection(db, "movements"));

      batch.delete(itemDocRef);

      batch.set(movementRef, {
        sku: itemToDrop.sku,
        brand: itemToDrop.brand,
        model: itemToDrop.model,
        size: itemToDrop.size,
        type: "SAIDA",
        quantity: -itemToDrop.quantity,
        balanceAfter: 0,
        companyId: itemToDrop.companyId || user.companyId || "",
        companyName: itemToDrop.companyName || user.companyName || "",
        userId: user.uid,
        userEmail: user.email,
        timestamp: serverTimestamp(),
        reason: "Exclusão permanente do produto do sistema"
      });

      await batch.commit();
    } catch (err: any) {
      console.error("Erro ao excluir item:", err);
      throw new Error(err?.message || "Erro ao excluir produto.");
    }
  };

  // Remove individual movement log from audit history
  const handleDeleteMovementLog = async (logId: string) => {
    if (!user || user.role !== "admin") return;
    try {
      await deleteDoc(doc(db, "movements", logId));
    } catch (err) {
      console.error("Erro ao excluir registro de auditoria:", err);
      throw new Error("Erro ao excluir registro.");
    }
  };

  // Clear all movement logs from database
  const handleClearMovementLogs = async () => {
    if (!user || user.role !== "admin") return;
    try {
      // Loop through and delete all movement documents in current state
      for (const log of movements) {
        await deleteDoc(doc(db, "movements", log.id));
      }
    } catch (err) {
      console.error("Erro ao limpar histórico de auditoria:", err);
      throw new Error("Erro ao limpar histórico.");
    }
  };

  // Clear stock items. Alimentadores are always scoped to their own company
  // (the `companyId` argument is ignored for them, same as before). Admins must
  // now pass an explicit `companyId` to wipe just that company — omitting it
  // wipes every company, which the confirmation modal only allows as a
  // deliberate, separately-selected choice (see StockTable.tsx), not the default
  // outcome of clicking "Apagar Estoque".
  const handleClearCompanyStock = async (companyId?: string) => {
    if (!user) return;
    if (user.role !== "admin" && user.role !== "alimentador") {
      throw new Error("Apenas administradores ou donos de empresa podem apagar o estoque.");
    }

    const scopedItems = user.role === "admin"
      ? (companyId ? stock.filter(item => item.companyId === companyId) : stock)
      : stock.filter(item => item.companyId === user.companyId);

    // Pneu reservado fica de fora da limpeza: apaga-lo deixaria o pedido que o
    // prendeu — reserva de cliente ou transferencia — apontando para o vazio.
    const reservedItems = scopedItems.filter(item => reservedQuantityOf(item) > 0);
    const itemsToClear = scopedItems.filter(item => reservedQuantityOf(item) === 0);

    if (scopedItems.length === 0) {
      throw new Error("Nenhum item localizado no estoque para apagar.");
    }
    if (itemsToClear.length === 0) {
      throw new Error(
        `Todos os ${reservedItems.length} produtos deste escopo estão reservados para clientes ou ` +
        `transferências. Resolva as reservas na aba Reservas antes de apagar o estoque.`
      );
    }

    // Delete in chunks of 400 documents to avoid the 500 document batch limit in Firestore
    const chunks: StockItem[][] = [];
    for (let i = 0; i < itemsToClear.length; i += 400) {
      chunks.push(itemsToClear.slice(i, i + 400));
    }

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      chunk.forEach(item => {
        batch.delete(doc(db, "stock", item.id));

        // Log the deletion in movements
        const movementRef = doc(collection(db, "movements"));
        batch.set(movementRef, {
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          type: "SAIDA",
          quantity: -item.quantity,
          balanceAfter: 0,
          companyId: item.companyId || user.companyId || "",
          companyName: item.companyName || user.companyName || "",
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: `Exclusao em lote do estoque (${item.companyName || "empresa não identificada"}) por ${user.displayName}`
        });
      });
      await batch.commit();
    }

    if (reservedItems.length > 0) {
      console.warn(
        `[ESTOQUE] ${reservedItems.length} produto(s) preservado(s) na limpeza por terem reserva de transferência ativa.`
      );
      alert(
        `Estoque apagado. ${reservedItems.length} produto(s) foram preservados porque estão reservados ` +
        `para clientes ou transferências — veja a aba Reservas.`
      );
    }
  };

  // Restore backup data back into Firestore
  const handleRestoreBackup = async (backupItems: any[]) => {
    if (!user) return;
    if (user.role !== "admin" && user.role !== "alimentador") {
      throw new Error("Apenas administradores ou donos de empresa podem restaurar backups.");
    }

    if (!Array.isArray(backupItems) || backupItems.length === 0) {
      throw new Error("Arquivo de backup vazio ou inválido.");
    }

    // Insert in chunks of 200 items (each item writes 2 docs: stock and movement)
    const chunks: any[][] = [];
    for (let i = 0; i < backupItems.length; i += 200) {
      chunks.push(backupItems.slice(i, i + 200));
    }

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      chunk.forEach(item => {
        const stockRef = doc(collection(db, "stock"));
        const movementRef = doc(collection(db, "movements"));
        
        const companyId = item.companyId || user.companyId || "";
        const companyName = item.companyName || user.companyName || "";

        batch.set(stockRef, {
          sku: item.sku || `RESTORE-${Math.floor(1000 + Math.random() * 9000)}`,
          brand: item.brand || "Desconhecida",
          model: item.model || "Produto Restaurado",
          size: item.size || "—",
          quantity: Number(item.quantity) || 0,
          price: Number(item.price) || 0,
          priceCash: Number(item.priceCash || item.price) || 0,
          priceInstallment: Number(item.priceInstallment || item.price) || 0,
          notes: item.notes || "",
          description: item.description || "Restaurado via backup",
          imageUrl: item.imageUrl || "",
          companyId,
          companyName,
          userId: user.uid,
          userEmail: user.email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        batch.set(movementRef, {
          sku: item.sku || "RESTORE",
          brand: item.brand || "Desconhecida",
          model: item.model || "Restaurado",
          size: item.size || "—",
          type: "ENTRADA",
          quantity: Number(item.quantity) || 0,
          balanceAfter: Number(item.quantity) || 0,
          companyId,
          companyName,
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: `Restaurado via backup de segurança por ${user.displayName}`
        });
      });
      await batch.commit();
    }
  };

  // Add a new company/branch (creates a new column in unified stock)
  const handleAddCompany = async (name: string, description: string = "") => {
    if (!user || user.role !== "admin") return;
    try {
      await addDoc(collection(db, "companies"), {
        name,
        description,
        createdAt: serverTimestamp()
      });
    } catch (e) {
      console.error("Erro ao adicionar empresa:", e);
      throw new Error("Erro ao salvar empresa no banco de dados.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Módulo de Entrada e Saída de Pneus (StockFlow)
  // ─────────────────────────────────────────────────────────────────

  // Grava uma operação inteira (vários pneus de uma vez) dentro de uma única
  // transação: lê o saldo atual de cada item, valida, e só então aplica as
  // atualizações de estoque + os registros de histórico. Assim uma saída nunca
  // derruba o saldo abaixo de zero mesmo com duas pessoas operando ao mesmo tempo.
  const handleRegisterStockFlow = async (payload: StockFlowPayload): Promise<StockFlowResult> => {
    if (!user) throw new Error("Sessão expirada. Faça login novamente.");
    if (user.role !== "admin" && user.role !== "alimentador") {
      throw new Error("Seu perfil não tem permissão para movimentar o estoque.");
    }

    const inputs = (payload.items || []).filter(i => i && i.stockItemId && i.quantity > 0);
    if (inputs.length === 0) throw new Error("Selecione pelo menos um pneu para movimentar.");
    if (new Set(inputs.map(i => i.stockItemId)).size !== inputs.length) {
      throw new Error("O mesmo pneu foi adicionado duas vezes na operação.");
    }
    // Cada item gera 2 documentos (estoque + histórico); o limite do Firestore é 500.
    if (inputs.length > 100) {
      throw new Error("Máximo de 100 pneus por operação. Divida em mais de uma movimentação.");
    }

    const isEntry = payload.type === "ENTRADA";
    const operationId = `OP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const reason = (payload.reason || "").trim() || (isEntry ? "Entrada de pneus" : "Saída de pneus");
    const docNumber = (payload.docNumber || "").trim();
    const partyName = (payload.partyName || "").trim();
    const partyDoc = (payload.partyDoc || "").trim();
    const vehiclePlate = (payload.vehiclePlate || "").trim().toUpperCase();
    const observation = (payload.observation || "").trim();

    // Texto legível que aparece na coluna "Motivação" da Auditoria & Histórico.
    const detailParts = [reason];
    if (docNumber) detailParts.push(`${isEntry ? "NF" : "OS"} ${docNumber}`);
    if (partyName) detailParts.push(`${isEntry ? "Fornecedor" : "Cliente"}: ${partyName}`);
    if (vehiclePlate) detailParts.push(`Placa ${vehiclePlate}`);
    const readableReason = `${isEntry ? "Entrada" : "Saída"} de pneus — ${detailParts.join(" • ")} (${operationId})`;

    const resultItems: StockFlowResultItem[] = [];
    let companyNameForReceipt = user.companyName || "Central Stoque";

    await runTransaction(db, async (transaction) => {
      resultItems.length = 0; // a transação pode ser reexecutada pelo Firestore

      // --- TODAS AS LEITURAS PRIMEIRO (exigência do Firestore) ---
      const pending: { ref: any; data: any; before: number; after: number; input: StockFlowItemInput }[] = [];
      for (const input of inputs) {
        const stockRef = doc(db, "stock", input.stockItemId);
        const snap = await transaction.get(stockRef);
        if (!snap.exists()) {
          throw new Error("Um dos pneus selecionados não existe mais no estoque. Atualize a tela e refaça a operação.");
        }
        const data: any = snap.data();
        const before = Number(data.quantity) || 0;
        const after = isEntry ? before + input.quantity : before - input.quantity;

        // Saldo LIVRE = saldo total menos o que esta reservado — para um cliente
        // (reserva de vendedor) ou para outra filial. A leitura vem de dentro da
        // transacao, entao duas baixas simultaneas nao conseguem furar a mesma reserva.
        const reserved = reservedQuantityOf(data);

        if (!isEntry && after < 0) {
          throw new Error(
            `Saldo insuficiente para ${data.sku || "o item"} (${data.brand || ""} ${data.size || ""}). ` +
            `Disponível: ${Math.max(0, before - reserved)} un, solicitado: ${input.quantity} un.`
          );
        }

        if (!isEntry && reserved > 0 && after < reserved) {
          throw new Error(
            `${reserved} un de ${data.sku || "este pneu"} (${data.brand || ""} ${data.size || ""}) estão ` +
            `RESERVADAS para um cliente ou para uma transferência e não podem ser baixadas — ` +
            `veja a aba Reservas. Livre para saída: ${Math.max(0, before - reserved)} un, ` +
            `solicitado: ${input.quantity} un.`
          );
        }

        pending.push({ ref: stockRef, data, before, after, input });
      }

      // --- DEPOIS TODAS AS ESCRITAS ---
      for (const entry of pending) {
        const { ref, data, before, after, input } = entry;
        const unitPrice = Number(input.unitPrice) || 0;
        const totalAmount = unitPrice * input.quantity;
        const itemCompanyId = data.companyId || user.companyId || "";
        const itemCompanyName = data.companyName || user.companyName || "";
        if (itemCompanyName) companyNameForReceipt = itemCompanyName;

        transaction.update(ref, {
          quantity: after,
          updatedAt: serverTimestamp()
        });

        const movementRef = doc(collection(db, "movements"));
        transaction.set(movementRef, {
          sku: data.sku || "N/A",
          brand: data.brand || "N/A",
          model: data.model || "N/A",
          size: data.size || "N/A",
          type: payload.type,
          quantity: isEntry ? input.quantity : -input.quantity,
          balanceAfter: after,
          companyId: itemCompanyId,
          companyName: itemCompanyName,
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: readableReason,
          stockItemId: input.stockItemId,
          operationId,
          operationReason: reason,
          docNumber,
          partyName,
          partyDoc,
          vehiclePlate,
          observation,
          unitPrice,
          totalAmount
        });

        resultItems.push({
          sku: data.sku || "N/A",
          brand: data.brand || "N/A",
          model: data.model || "N/A",
          size: data.size || "N/A",
          quantity: input.quantity,
          balanceBefore: before,
          balanceAfter: after,
          unitPrice,
          totalAmount,
          companyName: itemCompanyName
        });
      }
    });

    return {
      operationId,
      type: payload.type,
      items: resultItems,
      totalUnits: resultItems.reduce((acc, i) => acc + i.quantity, 0),
      totalAmount: resultItems.reduce((acc, i) => acc + i.totalAmount, 0),
      reason,
      docNumber,
      partyName,
      partyDoc,
      vehiclePlate,
      observation,
      companyName: companyNameForReceipt,
      userName: user.displayName,
      date: formatDate(new Date())
    };
  };

  // Estorno de uma operação do módulo (admin). Relê os movimentos daquela
  // operationId no servidor — nunca confia só no que está em memória — devolve
  // o saldo ao estado anterior e grava movimentos de estorno no histórico.
  // O registro original é preservado: auditoria não se apaga, se compensa.
  const handleReverseStockFlowOperation = async (operationId: string) => {
    if (!user || user.role !== "admin") {
      throw new Error("Apenas administradores podem estornar uma movimentação.");
    }
    if (!operationId) throw new Error("Operação inválida.");

    const movementsRef = collection(db, "movements");

    // Já existe estorno para esta operação?
    const existingReversal = await getDocs(query(movementsRef, where("reversalOf", "==", operationId)));
    if (!existingReversal.empty) {
      throw new Error("Esta operação já foi estornada anteriormente.");
    }

    const originalSnap = await getDocs(query(movementsRef, where("operationId", "==", operationId)));
    if (originalSnap.empty) {
      throw new Error("Não foi possível localizar os registros desta operação.");
    }

    const originalLogs = originalSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    // Resolve a referência de estoque de cada item ANTES de abrir a transação
    // (mesmo padrão de handleSignReceipt): consultas por query não podem rodar
    // dentro dela. Operações gravadas pelo módulo trazem o stockItemId exato;
    // registros mais antigos caem no fallback por empresa + SKU.
    const resolvedRefs = new Map<string, any>();
    for (const log of originalLogs) {
      if (log.stockItemId) {
        resolvedRefs.set(log.id, doc(db, "stock", log.stockItemId));
        continue;
      }
      const stockDocs = await getDocs(query(
        collection(db, "stock"),
        where("companyId", "==", log.companyId || ""),
        where("sku", "==", log.sku || "")
      ));
      resolvedRefs.set(log.id, stockDocs.empty ? null : stockDocs.docs[0].ref);
    }

    await runTransaction(db, async (transaction) => {
      // --- LEITURAS ---
      const pending: { ref: any; log: any; after: number; exists: boolean }[] = [];
      for (const log of originalLogs) {
        const stockRef = resolvedRefs.get(log.id);
        if (!stockRef) {
          // Produto já excluído do estoque: o estorno vira apenas registro de auditoria.
          pending.push({ ref: null, log, after: 0, exists: false });
          continue;
        }
        const fresh = await transaction.get(stockRef);
        if (!fresh.exists()) {
          pending.push({ ref: null, log, after: 0, exists: false });
          continue;
        }
        const current = Number((fresh.data() as any)?.quantity) || 0;
        // O movimento original já vem com sinal (+ entrada / − saída): estornar é somar o inverso.
        const after = current - (Number(log.quantity) || 0);
        if (after < 0) {
          throw new Error(
            `Não é possível estornar: o saldo atual de ${log.sku} (${current} un) é menor que a quantidade da operação.`
          );
        }
        pending.push({ ref: stockRef, log, after, exists: true });
      }

      // --- ESCRITAS ---
      for (const entry of pending) {
        const { ref, log, after, exists } = entry;
        if (exists && ref) {
          transaction.update(ref, { quantity: after, updatedAt: serverTimestamp() });
        }

        const movementRef = doc(collection(db, "movements"));
        transaction.set(movementRef, {
          sku: log.sku || "N/A",
          brand: log.brand || "N/A",
          model: log.model || "N/A",
          size: log.size || "N/A",
          // O estorno inverte o tipo: estornar uma entrada é uma saída, e vice-versa.
          type: (Number(log.quantity) || 0) > 0 ? "SAIDA" : "ENTRADA",
          quantity: -(Number(log.quantity) || 0),
          balanceAfter: after,
          companyId: log.companyId || "",
          companyName: log.companyName || "",
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: `Estorno da operação ${operationId} por ${user.displayName}${exists ? "" : " (produto não localizado no estoque — apenas registro)"}`,
          operationId: `EST-${operationId}`,
          operationReason: `Estorno da operação ${operationId}`,
          reversalOf: operationId,
          docNumber: log.docNumber || "",
          partyName: log.partyName || "",
          partyDoc: log.partyDoc || "",
          vehiclePlate: log.vehiclePlate || "",
          observation: "",
          unitPrice: Number(log.unitPrice) || 0,
          totalAmount: Number(log.totalAmount) || 0
        });
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────
  // Sugestões de compra (o que o balcão pediu e o estoque não tinha)
  //
  // Nada aqui toca em estoque, saldo ou reserva: é um recado com fila e
  // desfecho. Quem escreve é o vendedor (e o admin); quem fecha é o dono da
  // loja destinatária. As regras do Firestore repetem essa divisão — este
  // arquivo só se antecipa aos erros para não devolver um "Missing or
  // insufficient permissions" seco na cara do vendedor.
  // ─────────────────────────────────────────────────────────────────
  const handleCreateSuggestion = async (data: {
    companyId: string;
    companyName: string;
    size: string;
    brand?: string;
    model?: string;
    quantity: number;
    customerName?: string;
    customerContact?: string;
    note?: string;
  }) => {
    if (!user) return;

    const size = (data.size || "").trim();
    if (!size) {
      throw new Error("Informe pelo menos a medida do pneu que o cliente procurou.");
    }
    // A loja é o endereço do recado: sem ela nenhum dono recebe a sugestão, e o
    // documento ficaria órfão no banco (nenhuma consulta da aba o alcançaria).
    if (!data.companyId) {
      throw new Error("Escolha a loja que deve receber esta sugestão.");
    }
    const quantity = Number(data.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Informe quantas unidades o cliente queria (pelo menos 1).");
    }

    await addDoc(collection(db, "suggestions"), {
      companyId: data.companyId,
      companyName: data.companyName || "",
      size,
      brand: (data.brand || "").trim(),
      model: (data.model || "").trim(),
      quantity,
      customerName: (data.customerName || "").trim(),
      customerContact: (data.customerContact || "").trim(),
      note: (data.note || "").trim(),
      requestedByUid: user.uid,
      requestedByName: user.displayName,
      requestedByEmail: user.email,
      requestedByRole: user.role,
      requestedByCompanyId: user.companyId || "",
      requestedByCompanyName: user.companyName || "",
      status: "ABERTA",
      createdAt: serverTimestamp()
    });
  };

  // Desfecho dado pelo dono da loja. "Reabrir" volta para ABERTA e por isso
  // limpa quem resolveu: senão o cartão continuaria exibindo "atendida por
  // Fulano" embaixo de uma sugestão que está de novo na fila.
  const handleResolveSuggestion = async (
    id: string,
    status: SuggestionStatus,
    note: string
  ) => {
    if (!user) return;
    const reopening = status === "ABERTA";
    await updateDoc(doc(db, "suggestions", id), {
      status,
      resolvedAt: reopening ? null : serverTimestamp(),
      resolvedByUid: reopening ? "" : user.uid,
      resolvedByName: reopening ? "" : user.displayName,
      resolutionNote: reopening ? "" : (note || "").trim()
    });
  };

  const handleDeleteSuggestion = async (id: string) => {
    if (!user) return;
    await deleteDoc(doc(db, "suggestions", id));
  };

  // ─────────────────────────────────────────────────────────────────
  // Inter-company Transfer Orders: create, cancel, sign delivery/receipt, admin reversal
  // ─────────────────────────────────────────────────────────────────

  // Create a new transfer request (immediate or scheduled for later). O saldo so
  // SAI do estoque quando as assinaturas sao coletadas — mas um ENVIO da propria
  // loja ja nasce com a quantidade RESERVADA (ver `reserveOnCreate` abaixo), de
  // modo que o pneu prometido para a outra filial nao possa ser vendido no meio.
  const handleCreateTransfer = async (data: {
    items: { sourceStockItemId: string; sku: string; brand: string; model: string; size: string; quantity: number; }[];
    sourceCompanyId: string;
    sourceCompanyName: string;
    destinationCompanyId: string;
    destinationCompanyName: string;
    reason: string;
    scheduledFor: Date | null;
    // "ENVIO" (a origem despacha, fluxo historico) ou "SOLICITACAO" (o destino
    // pede e a origem decide). Ausente = ENVIO, para nao mexer em chamadas antigas.
    requestKind?: TransferRequestKind;
    // Reserva de cliente (destino CLIENTE_COMPANY_ID): quem vai levar o pneu.
    customerName?: string;
  }) => {
    if (!user) return;

    if (!data.items || data.items.length === 0) {
      throw new Error("Adicione pelo menos um item.");
    }
    for (const item of data.items) {
      if (!item.quantity || item.quantity <= 0) {
        throw new Error("A quantidade de todos os itens deve ser maior que zero.");
      }
    }
    if (!data.sourceCompanyId) {
      throw new Error("Selecione a empresa de origem.");
    }
    if (!data.destinationCompanyId || data.sourceCompanyId === data.destinationCompanyId) {
      throw new Error("Selecione uma empresa de destino diferente da empresa de origem.");
    }

    // Reserva de CLIENTE: o pneu nao vai para outra filial, vai para o cliente
    // final do vendedor. O destino e um sentinela sem empresa correspondente, e
    // por isso este pedido segue regras proprias (ver CLIENTE_COMPANY_ID em types.ts).
    const isCustomerOrder = data.destinationCompanyId === CLIENTE_COMPANY_ID;
    const customerName = (data.customerName || "").trim();

    if (isCustomerOrder) {
      if (user.role !== "vendedor" && user.role !== "admin") {
        throw new Error("Apenas vendedores podem reservar pneus para um cliente.");
      }
      if (!customerName) {
        throw new Error("Informe o nome do cliente para quem o pneu está sendo reservado.");
      }
      if (data.sourceCompanyId === CLIENTE_COMPANY_ID) {
        throw new Error("Selecione a loja de origem do pneu.");
      }
    } else {
      // Um operador sem empresa vinculada na credencial nao passa nas regras do
      // Firestore (que comparam a empresa do pedido com a do perfil). Sem esta
      // checagem o erro chegaria como um "Missing or insufficient permissions" seco.
      // O vendedor nao entra aqui: ele nunca cria transferencia entre filiais.
      if (user.role !== "admin" && !user.companyId) {
        throw new Error(
          "Seu usuário não está vinculado a nenhuma empresa. Peça ao administrador para definir a empresa da sua credencial em Operadores e Senhas e faça login novamente."
        );
      }
    }

    // A reserva de cliente e sempre imediata: nada de agendamento, e a loja de
    // origem decide na hora. Por isso ela ignora scheduledFor.
    const isScheduled = !isCustomerOrder && !!data.scheduledFor && data.scheduledFor.getTime() > Date.now();
    const requestKind: TransferRequestKind =
      isCustomerOrder || data.requestKind === "SOLICITACAO" ? "SOLICITACAO" : "ENVIO";

    // Uma SOLICITACAO entre filiais so pode partir de quem vai RECEBER — e o
    // pedido "me manda esses pneus". Quem envia por conta propria usa o fluxo de
    // ENVIO. A reserva de cliente e a excecao: quem pede e o vendedor, e o
    // "destino" e o balcao, nao uma empresa do sistema.
    if (requestKind === "SOLICITACAO" && !isCustomerOrder && user.role !== "admin" && data.destinationCompanyId !== user.companyId) {
      throw new Error("Uma solicitação só pode ser aberta pela empresa que vai receber os pneus.");
    }

    // Solicitacao nasce parada, aguardando o aval da origem. A reserva de cliente
    // tambem nasce em SOLICITADO — mas ja com o pneu preso (ver reserveOnCreate
    // logo abaixo): o que falta nela e a confirmacao, nao o bloqueio.
    const initialStatus = requestKind === "SOLICITACAO"
      ? "SOLICITADO"
      : (isScheduled ? "AGENDADO" : "PENDENTE");

    // ── Reserva ja no nascimento do pedido ──────────────────────────
    // Prender o saldo na MESMA transacao que cria o pedido e o ponto do modulo:
    // entre "separei o pneu" e "alguem confirmou" podem passar dias, e nesse
    // intervalo o balcao nao pode vender o que ja esta prometido.
    //
    // Reservam no nascimento:
    //   • ENVIO aberto pela PROPRIA loja de origem;
    //   • RESERVA DE CLIENTE de um vendedor — QUALQUER loja, inclusive a de
    //     outra filial. E o que faz o pneu aparecer como reservado para todo
    //     mundo no instante do pedido, antes de qualquer aprovacao. As regras do
    //     Firestore abrem `reservedQuantity` (e so ele) para o vendedor.
    //
    // Nao reserva aqui: o ENVIO cuja origem e outra loja, e a SOLICITACAO comum
    // entre filiais — nos dois o estoque nao e de quem esta pedindo, e a reserva
    // entra quando a origem aprova (handleApproveTransferRequest).
    const reserveOnCreate =
      isCustomerOrder ||
      (requestKind === "ENVIO" &&
        (user.role === "admin" || data.sourceCompanyId === user.companyId));

    const payload: Record<string, any> = {
      items: data.items,
      sourceCompanyId: data.sourceCompanyId,
      sourceCompanyName: data.sourceCompanyName,
      destinationCompanyId: data.destinationCompanyId,
      destinationCompanyName: data.destinationCompanyName,
      reason: data.reason?.trim() || "",
      // Na reserva de cliente fica registrado de qual loja o vendedor veio: a
      // loja que recebe o pedido precisa distinguir "vendedor da casa" de
      // "vendedor de outra filial pedindo meu pneu".
      ...(isCustomerOrder
        ? {
            customerName,
            requestedByCompanyId: user.companyId || "",
            requestedByCompanyName: user.companyName || ""
          }
        : {}),
      requestKind,
      reservation: null,
      status: initialStatus,
      scheduledFor: isScheduled ? data.scheduledFor : null,
      requestedByUid: user.uid,
      requestedByEmail: user.email,
      requestedByName: user.displayName,
      requestedAt: serverTimestamp(),
      delivery: null,
      receipt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    try {
      if (!reserveOnCreate) {
        await addDoc(collection(db, "transfers"), payload);
      } else {
        await runTransaction(db, async (transaction) => {
          // --- TODAS AS LEITURAS PRIMEIRO (exigencia do Firestore) ---
          // Reler o estoque aqui, em vez de confiar no que a tela mostrava, e o
          // que impede duas telas de reservarem o mesmo ultimo pneu: a transacao
          // refaz a conta com o saldo do servidor e uma das duas repete ou falha.
          const pending: { ref: any; nextReserved: number }[] = [];
          for (const item of data.items) {
            if (!item.sourceStockItemId) {
              throw new Error(`O item ${item.sku || ""} do pedido não aponta para nenhum produto do estoque.`);
            }
            const stockRef = doc(db, "stock", item.sourceStockItemId);
            const stockSnap = await transaction.get(stockRef);
            if (!stockSnap.exists()) {
              throw new Error(`O produto ${item.sku || ""} não existe mais no estoque da origem.`);
            }

            const stockData: any = stockSnap.data();
            const total = Number(stockData.quantity) || 0;
            const reserved = reservedQuantityOf(stockData);
            const free = Math.max(0, total - reserved);
            const qty = Number(item.quantity) || 0;

            if (qty > free) {
              throw new Error(
                `Não há saldo livre suficiente de ${stockData.sku || item.sku} ` +
                `(${stockData.brand || ""} ${stockData.size || ""}). Livre: ${free} un` +
                `${reserved > 0 ? ` (${reserved} un já reservadas em outros pedidos)` : ""}, ` +
                `necessário: ${qty} un.`
              );
            }
            pending.push({ ref: stockRef, nextReserved: reserved + qty });
          }

          // --- DEPOIS TODAS AS ESCRITAS ---
          for (const entry of pending) {
            transaction.update(entry.ref, {
              reservedQuantity: entry.nextReserved,
              updatedAt: serverTimestamp()
            });
          }

          transaction.set(doc(collection(db, "transfers")), {
            ...payload,
            reservation: {
              active: true,
              reservedByUid: user.uid,
              reservedByName: user.displayName,
              reservedAt: serverTimestamp()
            }
          });
        });
      }
    } catch (err: any) {
      console.error("Erro ao criar pedido de transferência:", err);
      // Cota do Firebase estourada. O erro cru que chegava na tela era
      // "Quota exceeded." — em ingles, sem dizer de quem e a culpa nem o que
      // fazer, e facil de confundir com "o pneu acabou". Nada foi gravado: a
      // transacao tentou cinco vezes, apanhou nas cinco e desfez tudo. E um
      // problema do PROJETO, nao do usuario — nenhuma tela conserta, e enquanto
      // a cota nao voltar o sistema inteiro fica assim.
      if (err?.code === "resource-exhausted") {
        throw new Error(
          "O banco de dados do sistema atingiu o limite diário de operações do plano gratuito do Firebase " +
          "e recusou o pedido. Nenhum pneu foi reservado — pode tentar de novo sem medo de duplicar. " +
          "O limite zera à meia-noite do horário do Pacífico (por volta das 4h ou 5h daqui). " +
          "Para não travar de novo, avise o administrador: o projeto precisa passar para o plano Blaze no Firebase."
        );
      }
      if (err?.code === "permission-denied") {
        if (isCustomerOrder) {
          throw new Error(
            "O banco recusou a reserva por permissão. Confirme com o administrador se o seu acesso está " +
            "marcado como Vendedor e, se a sua credencial mudou recentemente, saia e entre novamente."
          );
        }
        // Causa quase sempre operacional: a empresa gravada no perfil (users/{uid},
        // escrito no login) nao bate com a empresa do pedido — tipicamente porque a
        // credencial trocou de empresa e a sessao ainda e a antiga.
        throw new Error(
          "O banco recusou o pedido por permissão. Verifique se a empresa de origem ou destino é a sua, " +
          "e se sua credencial mudou de empresa recentemente, saia e entre novamente no sistema."
        );
      }
      throw new Error(err?.message || "Erro ao salvar o pedido de transferência no banco de dados.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Reserva de estoque
  //
  // Reservar e o unico jeito de a empresa de ORIGEM garantir um pneu para outra
  // empresa antes de ele sair fisicamente. A quantidade reservada vive em
  // reservedQuantity no documento de estoque e e somada/subtraida SEMPRE aqui,
  // dentro de uma transacao junto com a mudanca de status do pedido — nunca em
  // duas escritas separadas, senao uma falha no meio deixaria pneu preso para
  // sempre ou pedido aprovado sem lastro.
  //
  // Sao estes os momentos em que este saldo muda:
  //   RESERVE  — a origem aprova a solicitacao, ou reserva um envio ja pendente;
  //   RELEASE  — a origem libera manualmente, ou o pedido e cancelado.
  // Fora daqui ficam outros dois, cada um ja dentro da propria transacao:
  // a CRIACAO de um envio pela loja de origem, que nasce reservado
  // (handleCreateTransfer), e o DESPACHO, quando o pneu sai de verdade
  // (handleCompleteDispatch, que mexe em `quantity` na mesma transacao).
  // ─────────────────────────────────────────────────────────────────
  const applyTransferReservation = async (
    transferId: string,
    direction: "RESERVE" | "RELEASE",
    options: {
      expectedStatuses: TransferStatus[];
      nextStatus?: TransferStatus;
      // Aceita uma funcao para os casos em que os campos extras dependem do
      // conteudo do pedido: assim eles saem do documento lido DENTRO da
      // transacao, e nao de uma copia possivelmente velha do estado da tela.
      extraTransferFields?: Record<string, any> | ((transferData: any) => Record<string, any>);
      releaseReason?: string;
      // Quando true, um pedido sem reserva ativa nao e erro: apenas segue com a
      // mudanca de status (usado pelo cancelamento, que vale reservado ou nao).
      allowNoReservation?: boolean;
    }
  ) => {
    if (!user) throw new Error("Sessão expirada. Entre novamente no sistema.");

    await runTransaction(db, async (transaction) => {
      const transferRef = doc(db, "transfers", transferId);
      const transferSnap = await transaction.get(transferRef);
      if (!transferSnap.exists()) throw new Error("Pedido de transferência não encontrado.");
      const transferData: any = transferSnap.data();

      if (!options.expectedStatuses.includes(transferData.status)) {
        throw new Error(
          `Este pedido não está mais no estado esperado (situação atual: ${transferData.status}). ` +
          `Atualize a tela e tente novamente.`
        );
      }

      const isReserved = transferData.reservation?.active === true;
      if (direction === "RESERVE" && isReserved) {
        throw new Error("Os itens deste pedido já estão reservados.");
      }
      if (direction === "RELEASE" && !isReserved && !options.allowNoReservation) {
        throw new Error("Este pedido não tem reserva ativa para liberar.");
      }

      const items = transferData.items || [];
      // Só a RESERVA precisa de itens: é ela que vai prender saldo. Liberar/cancelar
      // um pedido malformado (sem itens) tem que continuar funcionando — antes desta
      // feature o cancelamento era um updateDoc cego e nunca falhava por isso.
      if (direction === "RESERVE" && items.length === 0) {
        throw new Error("Pedido não contém itens.");
      }

      const mustTouchStock = direction === "RESERVE" || isReserved;

      // --- TODAS AS LEITURAS PRIMEIRO (exigência do Firestore) ---
      //
      // Indexado pelo CAMINHO do documento, não uma lista: se dois itens do mesmo
      // pedido apontarem para o mesmo pneu, a lista faria duas leituras do mesmo
      // saldo e duas escritas com valor ABSOLUTO — a segunda apagaria a primeira,
      // e metade da reserva ficaria presa para sempre depois de um cancelamento.
      // Somando no mapa, cada documento é lido uma vez e escrito uma vez.
      const pendingByPath = new Map<string, { ref: any; nextReserved: number }>();
      const trackStock = (ref: any, current: number, delta: number) => {
        const existing = pendingByPath.get(ref.path);
        const base = existing ? existing.nextReserved : current;
        pendingByPath.set(ref.path, { ref, nextReserved: Math.max(0, base + delta) });
      };
      if (mustTouchStock) {
        for (const item of items) {
          // Item sem referência de estoque: doc(db,"stock",undefined) derrubaria a
          // transação inteira, e num cancelamento isso deixaria o pedido impossível
          // de fechar. Na reserva é erro; na liberação, não há o que devolver.
          if (!item?.sourceStockItemId) {
            if (direction === "RELEASE") continue;
            throw new Error(`O item ${item?.sku || ""} do pedido não aponta para nenhum produto do estoque.`);
          }

          const stockRef = doc(db, "stock", item.sourceStockItemId);
          const stockSnap = await transaction.get(stockRef);

          if (!stockSnap.exists()) {
            // Na liberacao um produto sumido nao pode travar o cancelamento —
            // nao ha o que devolver. Na reserva, e erro de verdade.
            if (direction === "RELEASE") continue;
            throw new Error(`O produto ${item.sku || ""} não existe mais no estoque da origem.`);
          }

          const data: any = stockSnap.data();
          const total = Number(data.quantity) || 0;
          const reserved = reservedQuantityOf(data);
          const qty = Number(item.quantity) || 0;

          if (direction === "RESERVE") {
            // Se este mesmo pneu já apareceu antes no pedido, o livre tem que
            // descontar o que aquela linha acabou de prender.
            const alreadyHeld = pendingByPath.get(stockRef.path)?.nextReserved ?? reserved;
            const free = Math.max(0, total - alreadyHeld);
            if (qty > free) {
              throw new Error(
                `Não há saldo livre suficiente de ${data.sku || item.sku} ` +
                `(${data.brand || ""} ${data.size || ""}). Livre: ${free} un` +
                `${reserved > 0 ? ` (${reserved} un já reservadas em outros pedidos)` : ""}, ` +
                `necessário: ${qty} un.`
              );
            }
            trackStock(stockRef, reserved, qty);
          } else {
            trackStock(stockRef, reserved, -qty);
          }
        }
      }

      // --- DEPOIS TODAS AS ESCRITAS ---
      for (const entry of pendingByPath.values()) {
        transaction.update(entry.ref, {
          reservedQuantity: entry.nextReserved,
          updatedAt: serverTimestamp()
        });
      }

      const reservationField = direction === "RESERVE"
        ? {
            active: true,
            reservedByUid: user.uid,
            reservedByName: user.displayName,
            reservedAt: serverTimestamp()
          }
        : isReserved
        ? {
            ...transferData.reservation,
            active: false,
            releasedAt: serverTimestamp(),
            releasedReason: options.releaseReason || "Reserva liberada"
          }
        : (transferData.reservation || null);

      const extraFields = typeof options.extraTransferFields === "function"
        ? options.extraTransferFields(transferData)
        : (options.extraTransferFields || {});

      transaction.update(transferRef, {
        ...(options.nextStatus ? { status: options.nextStatus } : {}),
        ...extraFields,
        reservation: reservationField,
        updatedAt: serverTimestamp()
      });
    });
  };

  // Mensagem util no lugar do "Missing or insufficient permissions" seco.
  const describeTransferWriteError = (err: any, fallback: string) => {
    if (err?.code === "permission-denied") {
      return new Error(
        "O banco recusou a operação por permissão. Só a empresa de ORIGEM (ou um administrador) " +
        "pode aprovar, recusar ou mexer na reserva de um pedido. Se sua credencial mudou de empresa " +
        "recentemente, saia e entre novamente no sistema."
      );
    }
    return new Error(err?.message || fallback);
  };

  // A origem aprova uma SOLICITACAO comum entre filiais: os pneus ficam
  // reservados na hora e o pedido entra no fluxo normal de assinaturas. A partir
  // daqui ninguem consegue vender ou baixar essa quantidade.
  //
  // Reserva de CLIENTE nao passa por aqui — ela ja nasce com o pneu preso e e
  // decidida em handleConfirmReservationSale (pneu da propria loja do vendedor)
  // ou handleApproveReservationStep (pneu de outra loja, dois avais).
  const handleApproveTransferRequest = async (transferId: string) => {
    if (!user) return;
    const transfer = transfers.find(t => t.id === transferId);
    if (isCustomerReservation(transfer)) {
      throw new Error(
        "Esta é uma reserva de cliente — use a aba Reservas para confirmar ou aprovar."
      );
    }
    // Uma solicitacao agendada para o futuro volta para a fila de agendados;
    // as demais ja ficam prontas para assinatura de envio.
    const scheduledMillis = toMillis(transfer?.scheduledFor);
    const nextStatus: TransferStatus = scheduledMillis > Date.now() ? "AGENDADO" : "PENDENTE";

    try {
      await applyTransferReservation(transferId, "RESERVE", {
        expectedStatuses: ["SOLICITADO"],
        nextStatus,
        extraTransferFields: {
          approvedByUid: user.uid,
          approvedByName: user.displayName,
          approvedAt: serverTimestamp()
        }
      });
    } catch (err: any) {
      console.error("Erro ao aprovar solicitação de transferência:", err);
      throw describeTransferWriteError(err, "Erro ao aprovar a solicitação de transferência.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Reserva de pneu de OUTRA loja: os dois avais
  //
  // O vendedor da loja A reservou um pneu que esta na loja B. O pneu ja saiu do
  // saldo vendavel de B no instante do pedido — o que falta e decidir se ele
  // viaja. Como o pneu muda de dono e de endereco, a decisao nao e de uma pessoa
  // so: precisa do DONO DE B (que abre mao do pneu) e do ADMINISTRADOR (que
  // responde pela transferencia entre filiais). A ordem nao importa.
  //
  // Quando o segundo aval chega, o pedido deixa de ser reserva de cliente: o
  // destino sai do balcao ('CLIENTE') e passa a ser a loja do vendedor, e dali em
  // diante ele percorre as quatro assinaturas como qualquer transferencia — a
  // baixa acontece no despacho, nao aqui. `customerName` fica no documento como
  // registro de para quem o pneu esta indo.
  //
  // O passo "SOURCE" tambem e aberto ao admin: sem isso, uma loja sem dono ativo
  // deixaria a reserva presa para sempre. Ele precisa dar os dois cliques, e cada
  // um fica registrado com o nome de quem deu.
  // ─────────────────────────────────────────────────────────────────
  const handleApproveReservationStep = async (
    transferId: string,
    step: "SOURCE" | "ADMIN"
  ) => {
    if (!user) return;

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists()) throw new Error("Reserva não encontrada (pode ter sido excluída).");
        const t: any = transferSnap.data();

        if (t.status !== "SOLICITADO") {
          throw new Error(`Esta reserva não está mais em análise (situação atual: ${t.status}).`);
        }
        if (!isCrossStoreReservation(t)) {
          throw new Error(
            "Esta reserva é de um pneu da própria loja do vendedor — ela é encerrada com " +
            "\"Confirmar e dar baixa\", não com aprovação dupla."
          );
        }

        const isAdminUser = user.role === "admin";
        if (step === "ADMIN" && !isAdminUser) {
          throw new Error("Só o administrador do sistema pode dar este aval.");
        }
        if (step === "SOURCE" && !isAdminUser && t.sourceCompanyId !== user.companyId) {
          throw new Error("Só o dono da loja que tem o pneu pode dar este aval.");
        }

        const alreadySource = !!t.sourceApprovedByUid;
        const alreadyAdmin = !!t.adminApprovedByUid;
        if (step === "SOURCE" && alreadySource) {
          throw new Error(`A loja ${t.sourceCompanyName} já aprovou esta reserva.`);
        }
        if (step === "ADMIN" && alreadyAdmin) {
          throw new Error("O administrador já aprovou esta reserva.");
        }

        const completesApproval = (step === "SOURCE" || alreadySource) && (step === "ADMIN" || alreadyAdmin);

        // Rede de segurança para pedidos ANTIGOS: reservas abertas antes de a
        // criação passar a prender o pneu chegam aqui com reservation nula, e o
        // saldo delas nunca saiu do disponível. Deixar virar transferência sem
        // prender nada abriria a porta para a loja vender, no balcão, o pneu que
        // acabou de ser prometido. Então o segundo aval prende, se ninguém prendeu.
        //
        // TODAS AS LEITURAS ANTES DAS ESCRITAS (exigência do Firestore).
        const pendingHolds: { ref: any; nextReserved: number }[] = [];
        if (completesApproval && t.reservation?.active !== true) {
          for (const item of t.items || []) {
            if (!item?.sourceStockItemId) {
              throw new Error(`O item ${item?.sku || ""} da reserva não aponta para nenhum produto do estoque.`);
            }
            const stockRef = doc(db, "stock", item.sourceStockItemId);
            const stockSnap = await transaction.get(stockRef);
            if (!stockSnap.exists()) {
              throw new Error(`O produto ${item.sku || ""} não existe mais no estoque de ${t.sourceCompanyName}.`);
            }
            const stockData: any = stockSnap.data();
            const total = Number(stockData.quantity) || 0;
            const reserved = reservedQuantityOf(stockData);
            const free = Math.max(0, total - reserved);
            const qty = Number(item.quantity) || 0;
            if (qty > free) {
              throw new Error(
                `Não há saldo livre suficiente de ${stockData.sku || item.sku} em ${t.sourceCompanyName}. ` +
                `Livre: ${free} un, necessário: ${qty} un.`
              );
            }
            pendingHolds.push({ ref: stockRef, nextReserved: reserved + qty });
          }
        }

        for (const hold of pendingHolds) {
          transaction.update(hold.ref, {
            reservedQuantity: hold.nextReserved,
            updatedAt: serverTimestamp()
          });
        }

        const fields: Record<string, any> = { updatedAt: serverTimestamp() };
        if (step === "SOURCE") {
          fields.sourceApprovedByUid = user.uid;
          fields.sourceApprovedByName = user.displayName;
          fields.sourceApprovedAt = serverTimestamp();
        } else {
          fields.adminApprovedByUid = user.uid;
          fields.adminApprovedByName = user.displayName;
          fields.adminApprovedAt = serverTimestamp();
        }

        // Os dois avais reunidos: o pedido vira transferencia agora.
        if (completesApproval) {
          fields.status = "PENDENTE";
          fields.destinationCompanyId = t.requestedByCompanyId;
          fields.destinationCompanyName = t.requestedByCompanyName || "Loja do vendedor";
          fields.approvedByUid = user.uid;
          fields.approvedByName = user.displayName;
          fields.approvedAt = serverTimestamp();
          if (pendingHolds.length > 0) {
            fields.reservation = {
              active: true,
              reservedByUid: user.uid,
              reservedByName: user.displayName,
              reservedAt: serverTimestamp()
            };
          }
        }

        transaction.update(transferRef, fields);
      });
    } catch (err: any) {
      console.error("Erro ao aprovar a reserva:", err);
      if (err?.code === "permission-denied") {
        throw new Error(
          "O banco recusou o aval. Só o dono da loja que TEM o pneu ou o administrador podem " +
          "aprovar esta reserva. Se sua credencial mudou de empresa recentemente, saia e entre novamente."
        );
      }
      throw new Error(err?.message || "Erro ao aprovar a reserva.");
    }
  };

  // A origem recusa a solicitacao.
  //
  // Passou a ser uma transacao (era um updateDoc solto) porque a reserva de um
  // vendedor nasce com o pneu PRESO: recusar sem devolver `reservedQuantity`
  // deixaria o pneu bloqueado por um pedido morto, e ninguem repararia ate
  // faltar saldo para vender. `allowNoReservation` cobre a solicitacao comum
  // entre filiais, que chega aqui sem nada reservado.
  const handleRejectTransferRequest = async (transferId: string, reason: string) => {
    if (!user) return;
    try {
      await applyTransferReservation(transferId, "RELEASE", {
        expectedStatuses: ["SOLICITADO"],
        nextStatus: "RECUSADO",
        extraTransferFields: {
          rejectedByUid: user.uid,
          rejectedByName: user.displayName,
          rejectedAt: serverTimestamp(),
          rejectReason: reason?.trim() || "Solicitação recusada pela empresa de origem"
        },
        releaseReason: `Reserva recusada por ${user.displayName}`,
        allowNoReservation: true
      });
    } catch (err: any) {
      console.error("Erro ao recusar solicitação de transferência:", err);
      throw describeTransferWriteError(err, "Erro ao recusar a solicitação de transferência.");
    }
  };

  // Reserva avulsa: a origem prende os pneus de um ENVIO que ja estava pendente
  // ou agendado, sem esperar a assinatura. Serve para segurar mercadoria que
  // ainda vai demorar a sair.
  const handleReserveTransferItems = async (transferId: string) => {
    if (!user) return;
    try {
      await applyTransferReservation(transferId, "RESERVE", {
        expectedStatuses: ["AGENDADO", "PENDENTE"]
      });
    } catch (err: any) {
      console.error("Erro ao reservar itens da transferência:", err);
      throw describeTransferWriteError(err, "Erro ao reservar os itens da transferência.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Destravar pneu preso por pedido ja encerrado (so administrador)
  //
  // Todo caminho que encerra uma reserva devolve `reservedQuantity` na MESMA
  // transacao — cancelar, recusar, confirmar a venda, despachar, excluir. Entao
  // este estado nao deveria existir. Mas se um dia existir (escrita que morreu
  // no meio, documento de uma versao antiga, movimento apagado a mao), o pneu
  // fica preso por um pedido morto e NENHUM botao do fluxo normal alcanca ele:
  // as acoes de cancelamento exigem o pedido aberto, e ele nao esta mais.
  //
  // Esta rotina existe so para isso, e por isso e restrita ao administrador:
  // ela nao pergunta se o pedido faz sentido, so devolve o saldo.
  const handleForceReleaseReservation = async (transferId: string) => {
    if (!user) return;
    if (user.role !== "admin") {
      throw new Error("Somente o administrador pode destravar um pneu preso por um pedido encerrado.");
    }

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists()) throw new Error("Pedido não encontrado (pode ter sido excluído).");
        const transferData: any = transferSnap.data();

        if (transferData.reservation?.active !== true) {
          throw new Error("Este pedido não tem reserva ativa — o pneu já está liberado.");
        }
        // Pedido ABERTO com reserva ativa e o estado normal do sistema: ali o
        // caminho certo e cancelar (que devolve o saldo e encerra o pedido), nao
        // soltar o pneu por baixo de um pedido que continua valendo.
        const open = ["SOLICITADO", "AGENDADO", "PENDENTE", "EM_TRANSITO"];
        if (open.includes(transferData.status)) {
          throw new Error(
            `Este pedido ainda está aberto (${transferData.status}). Cancele-o — o cancelamento já ` +
            `devolve o pneu ao estoque.`
          );
        }

        // --- LEITURAS ---
        const pending: { ref: any; nextReserved: number }[] = [];
        for (const item of transferData.items || []) {
          if (!item?.sourceStockItemId) continue;
          const stockRef = doc(db, "stock", item.sourceStockItemId);
          const stockSnap = await transaction.get(stockRef);
          if (!stockSnap.exists()) continue;
          const reserved = reservedQuantityOf(stockSnap.data());
          pending.push({
            ref: stockRef,
            nextReserved: Math.max(0, reserved - (Number(item.quantity) || 0))
          });
        }

        // --- ESCRITAS ---
        for (const entry of pending) {
          transaction.update(entry.ref, {
            reservedQuantity: entry.nextReserved,
            updatedAt: serverTimestamp()
          });
        }
        transaction.update(transferRef, {
          reservation: {
            ...transferData.reservation,
            active: false,
            releasedAt: serverTimestamp(),
            releasedReason: `Pneu destravado por ${user.displayName} (pedido já encerrado)`
          },
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao destravar a reserva:", err);
      throw new Error(err?.message || "Erro ao devolver o pneu ao estoque.");
    }
  };

  // Libera a reserva sem cancelar o pedido — o pneu volta a ficar vendavel.
  const handleReleaseTransferReservation = async (transferId: string) => {
    if (!user) return;
    try {
      await applyTransferReservation(transferId, "RELEASE", {
        expectedStatuses: ["AGENDADO", "PENDENTE"],
        releaseReason: `Reserva liberada manualmente por ${user.displayName}`
      });
    } catch (err: any) {
      console.error("Erro ao liberar reserva da transferência:", err);
      throw describeTransferWriteError(err, "Erro ao liberar a reserva da transferência.");
    }
  };

  // Cancel a transfer that hasn't been dispatched yet. Nothing physically moved,
  // mas se o pedido estava com reserva ativa ela precisa voltar ao estoque na
  // MESMA transacao do cancelamento — senao o pneu ficaria preso para sempre.
  const handleCancelTransfer = async (transferId: string, reason: string) => {
    if (!user) return;

    try {
      await applyTransferReservation(transferId, "RELEASE", {
        expectedStatuses: ["AGENDADO", "PENDENTE", "SOLICITADO"],
        nextStatus: "CANCELADO",
        extraTransferFields: {
          cancelledByUid: user.uid,
          cancelledByName: user.displayName,
          cancelledAt: serverTimestamp(),
          cancelReason: reason?.trim() || "Cancelado pelo solicitante"
        },
        releaseReason: `Pedido cancelado por ${user.displayName}`,
        allowNoReservation: true
      });
    } catch (err: any) {
      console.error("Erro ao cancelar transferência:", err);
      if (err?.code === "permission-denied") {
        throw new Error(
          "O banco recusou o cancelamento. Um pedido com reserva ativa só pode ser cancelado pela " +
          "empresa de ORIGEM (que é quem consegue liberar os pneus) ou por um administrador."
        );
      }
      throw new Error(err?.message || "Erro ao cancelar o pedido de transferência.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Exclusao definitiva do registro
  //
  // Duas pessoas apagam, e por motivos diferentes:
  //   • o ADMINISTRADOR, qualquer pedido (limpeza de dados de teste);
  //   • o DONO DA LOJA QUE TEM O PNEU, so o que ja morreu — recusado ou
  //     cancelado. E a faxina da fila dele: pedido encerrado nao serve para mais
  //     nada e so esconde o que ainda espera decisao.
  //
  // As duas condicoes estao repetidas na regra do Firestore. Aqui elas evitam a
  // ida ao banco e dao uma mensagem que explica; la elas e que valem.
  // ─────────────────────────────────────────────────────────────────
  const handleDeleteTransfer = async (transferId: string) => {
    if (!user) return;

    if (user.role !== "admin") {
      const target = transfers.find(t => t.id === transferId);
      if (!target) return;
      const closed = target.status === "RECUSADO" || target.status === "CANCELADO";
      const isSourceOwner = user.role === "alimentador" && !!user.companyId && target.sourceCompanyId === user.companyId;
      if (!closed || !isSourceOwner) {
        throw new Error(
          "Só a loja dona do pneu pode apagar um pedido, e apenas depois de ele ser recusado ou cancelado. " +
          "Pedidos em andamento não são apagados — cancele primeiro."
        );
      }
      // Reserva ativa num pedido encerrado e uma inconsistencia: apagar o
      // documento apagaria a unica pista de por que aquele pneu esta preso.
      if (target.reservation?.active === true) {
        throw new Error(
          "Este pedido está encerrado mas ainda tem pneu preso no estoque. Peça ao administrador para " +
          "usar \"Destravar pneu\" antes de apagar o registro."
        );
      }
    }

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        // Já sumiu (outra aba apagou): nada a fazer, e nada a devolver.
        if (!transferSnap.exists()) return;

        const transferData: any = transferSnap.data();
        const wasReserved = transferData.reservation?.active === true;
        const items = transferData.items || [];

        // --- TODAS AS LEITURAS PRIMEIRO ---
        const pending: { ref: any; nextReserved: number }[] = [];
        if (wasReserved) {
          for (const item of items) {
            if (!item?.sourceStockItemId) continue;
            const stockRef = doc(db, "stock", item.sourceStockItemId);
            const stockSnap = await transaction.get(stockRef);
            if (!stockSnap.exists()) continue;
            const reserved = reservedQuantityOf(stockSnap.data());
            pending.push({
              ref: stockRef,
              nextReserved: Math.max(0, reserved - (Number(item.quantity) || 0))
            });
          }
        }

        // --- DEPOIS AS ESCRITAS ---
        for (const entry of pending) {
          transaction.update(entry.ref, {
            reservedQuantity: entry.nextReserved,
            updatedAt: serverTimestamp()
          });
        }
        transaction.delete(transferRef);
      });
    } catch (err: any) {
      console.error("Erro ao excluir transferência:", err);
      throw new Error(err?.message || "Erro ao excluir o pedido de transferência.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Assinaturas em duas vias
  //
  // Cada ponta (saida e chegada) coleta DUAS assinaturas: a do responsavel
  // interno, gravada na hora, e a do motorista, que chega depois — por link
  // publico no celular dele ou por foto do papel assinado. O estoque so se
  // move quando a segunda via chega.
  // ─────────────────────────────────────────────────────────────────

  // Via 1 da saida: o responsavel da origem assina e ja fica registrado.
  // Nada de estoque se move aqui; o pedido continua PENDENTE.
  const handleSignSenderDispatch = async (transferId: string, signatureDataUrl: string) => {
    if (!user) return;
    try {
      const senderRecord = {
        signedByUid: user.uid,
        signedByEmail: user.email,
        signedByName: user.displayName,
        signedAt: serverTimestamp(),
        signatureDataUrl,
        method: "DESENHO"
      };
      await updateDoc(doc(db, "transfers", transferId), {
        dispatch: { sender: senderRecord, driver: null },
        delivery: senderRecord, // espelho legado, lido por telas/relatorios antigos
        updatedAt: serverTimestamp()
      });
    } catch (err: any) {
      console.error("Erro ao registrar assinatura do remetente:", err);
      throw new Error(
        err?.code === "permission-denied"
          ? "Sem permissão para assinar por esta empresa. Confirme se você pertence à empresa de origem."
          : "Erro ao registrar a assinatura do remetente."
      );
    }
  };

  // Via 1 da chegada: o responsavel do destino assina. O pedido segue EM_TRANSITO
  // ate a via do motorista chegar.
  const handleSignReceiverArrival = async (transferId: string, signatureDataUrl: string) => {
    if (!user) return;
    try {
      const receiverRecord = {
        signedByUid: user.uid,
        signedByEmail: user.email,
        signedByName: user.displayName,
        signedAt: serverTimestamp(),
        signatureDataUrl,
        method: "DESENHO"
      };
      await updateDoc(doc(db, "transfers", transferId), {
        arrival: { receiver: receiverRecord, driver: null },
        receipt: receiverRecord, // espelho legado
        updatedAt: serverTimestamp()
      });
    } catch (err: any) {
      console.error("Erro ao registrar assinatura do recebedor:", err);
      throw new Error(
        err?.code === "permission-denied"
          ? "Sem permissão para assinar por esta empresa. Confirme se você pertence à empresa de destino."
          : "Erro ao registrar a assinatura do recebedor."
      );
    }
  };

  // Sign the delivery (source company confirms the goods are leaving). This is where
  // stock actually leaves the source company — decremented atomically inside a
  // transaction so a stale/insufficient balance or a duplicate signature attempt
  // fails cleanly instead of double-counting or driving stock negative.
  const handleCompleteDispatch = async (transferId: string, driverSignatureDataUrl: string, driverName: string, method: SignatureMethod) => {
    if (!user) return;

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists()) {
          throw new Error("Pedido de transferência não encontrado.");
        }
        const transferData: any = transferSnap.data();

        if (transferData.status !== "PENDENTE") {
          throw new Error("Este pedido não está mais aguardando assinatura de envio (talvez já tenha sido assinado).");
        }
        if (!transferData.dispatch?.sender) {
          throw new Error("A assinatura do remetente ainda não foi registrada.");
        }

        const items = transferData.items || [];
        if (items.length === 0) {
          throw new Error("Pedido não contém itens.");
        }

        // Se este pedido tinha reserva ativa, o despacho e o momento em que ela
        // deixa de existir: o pneu sai fisicamente, entao a quantidade some do
        // saldo total E do saldo reservado na mesma transacao.
        const wasReserved = transferData.reservation?.active === true;

        // --- ALL READS ---
        const stockDataToUpdate = [];
        for (const item of items) {
          const sourceStockRef = doc(db, "stock", item.sourceStockItemId);
          const sourceStockSnap = await transaction.get(sourceStockRef);

          if (!sourceStockSnap.exists()) {
            throw new Error(`O item de estoque ${item.sku} não foi encontrado (pode ter sido excluído).`);
          }
          const sourceData: any = sourceStockSnap.data();
          const currentQty = sourceData.quantity ?? 0;
          const currentReserved = reservedQuantityOf(sourceData);

          if (currentQty < item.quantity) {
            throw new Error(`Estoque insuficiente para ${item.sku}. Saldo atual: ${currentQty} un, necessário: ${item.quantity} un.`);
          }

          const newQty = currentQty - item.quantity;
          // A reserva DESTE pedido sai do contador; a de outros pedidos permanece.
          const newReserved = wasReserved
            ? Math.max(0, currentReserved - item.quantity)
            : currentReserved;

          // Um envio sem reserva propria nao pode comer o que outro pedido ja
          // prendeu — esse saldo esta prometido a outra empresa.
          if (newQty < newReserved) {
            throw new Error(
              `${newReserved} un de ${item.sku} estão reservadas para um cliente ou outro pedido. ` +
              `Livre para envio: ${Math.max(0, currentQty - currentReserved)} un, necessário: ${item.quantity} un.`
            );
          }

          stockDataToUpdate.push({
            ref: sourceStockRef,
            newQty,
            newReserved,
            reservedChanged: newReserved !== currentReserved,
            item: item
          });
        }

        // --- ALL WRITES ---
        for (const updateData of stockDataToUpdate) {
          transaction.update(updateData.ref, {
            quantity: updateData.newQty,
            ...(updateData.reservedChanged ? { reservedQuantity: updateData.newReserved } : {}),
            updatedAt: serverTimestamp()
          });

          const movementRef = doc(collection(db, "movements"));
          transaction.set(movementRef, {
            sku: updateData.item.sku,
            brand: updateData.item.brand,
            model: updateData.item.model,
            size: updateData.item.size,
            type: "TRANSFERENCIA_SAIDA",
            quantity: -updateData.item.quantity,
            balanceAfter: updateData.newQty,
            companyId: transferData.sourceCompanyId,
            companyName: transferData.sourceCompanyName,
            userId: user.uid,
            userEmail: user.email,
            timestamp: serverTimestamp(),
            reason: `Transferência para ${transferData.destinationCompanyName} — assinado por ${user.displayName}`,
            transferId
          });
        }

        // A via do remetente ja esta gravada: preserva como veio, so acrescenta
        // a do motorista. Reescrever aqui apagaria quem realmente assinou.
        const senderRecord = transferData.dispatch.sender;

        transaction.update(transferRef, {
          status: "EM_TRANSITO",
          dispatch: {
            sender: senderRecord,
            driver: {
              signedByUid: "MOTORISTA",
              signedByEmail: "",
              signedByName: driverName.trim(),
              signedAt: serverTimestamp(),
              signatureDataUrl: driverSignatureDataUrl,
              method
            }
          },
          delivery: senderRecord,
          // A reserva se converte em saida real: fica registrada como encerrada,
          // preservando quem reservou e quando (auditoria nao se apaga).
          ...(wasReserved
            ? {
                reservation: {
                  ...transferData.reservation,
                  active: false,
                  releasedAt: serverTimestamp(),
                  releasedReason: "Reserva convertida em envio (pneus despachados)"
                }
              }
            : {}),
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao assinar envio:", err);
      throw new Error(err.message || "Erro ao registrar a assinatura de envio.");
    }
  };

  const handleCompleteArrival = async (transferId: string, driverSignatureDataUrl: string, driverName: string, method: SignatureMethod) => {
    if (!user) return;

    try {
      const transferRef = doc(db, "transfers", transferId);
      const transferSnap = await getDoc(transferRef);
      if (!transferSnap.exists()) {
        throw new Error("Pedido de transferência não encontrado.");
      }
      const tData: any = transferSnap.data();

      if (tData.status !== "EM_TRANSITO") {
        throw new Error("Este pedido não está aguardando confirmação de recebimento.");
      }
      if (!tData.arrival?.receiver) {
        throw new Error("A assinatura do recebedor ainda não foi registrada.");
      }

      const items = tData.items || [];
      if (items.length === 0) {
        throw new Error("Pedido não contém itens.");
      }

      // Pre-fetch all destination references by SKU so we don't do queries inside transaction
      const destDocsMap = new Map<string, any>();
      for (const item of items) {
        const destStockQuery = query(
          collection(db, "stock"),
          where("companyId", "==", tData.destinationCompanyId),
          where("sku", "==", item.sku)
        );
        const destStockSnap = await getDocs(destStockQuery);
        if (!destStockSnap.empty) {
          destDocsMap.set(item.sku, destStockSnap.docs[0].ref);
        } else {
          destDocsMap.set(item.sku, null);
        }
      }

      await runTransaction(db, async (transaction) => {
        // Re-read transfer in transaction
        const tSnap = await transaction.get(transferRef);
        const latestTData: any = tSnap.data();

        if (latestTData.status !== "EM_TRANSITO") {
          throw new Error("Este pedido não está aguardando confirmação de recebimento.");
        }
        if (!latestTData.arrival?.receiver) {
          throw new Error("A assinatura do recebedor ainda não foi registrada.");
        }

        // --- ALL READS ---
        // O destino e resolvido por SKU, e dois itens do pedido podem cair no
        // MESMO documento de destino (o mesmo pneu cadastrado duas vezes na
        // origem). Agrupar por SKU antes de escrever e obrigatorio: duas
        // escritas no mesmo doc dentro da transacao fariam a segunda
        // sobrescrever a primeira e as unidades da outra linha sumiriam.
        const stockDataToUpdate: any[] = [];
        const bySku = new Map<string, any>();

        for (const item of latestTData.items) {
          const grouped = bySku.get(item.sku);
          if (grouped) {
            grouped.newQty += item.quantity;
            grouped.items.push(item);
            continue;
          }

          let destStockRef = destDocsMap.get(item.sku);
          let baseQty = 0;
          let isNewStockDoc = false;

          if (destStockRef) {
            const freshDestSnap = await transaction.get(destStockRef);
            const freshData: any = freshDestSnap.data() || {};
            baseQty = freshData.quantity ?? 0;
          } else {
            destStockRef = doc(collection(db, "stock"));
            isNewStockDoc = true;
          }

          const entry = {
            ref: destStockRef,
            newQty: baseQty + item.quantity,
            isNewStockDoc,
            item,
            // Uma linha de movimento por item do pedido, mesmo quando varios
            // itens somam no mesmo documento de estoque.
            items: [item]
          };
          bySku.set(item.sku, entry);
          stockDataToUpdate.push(entry);
        }

        // --- ALL WRITES ---
        for (const updateData of stockDataToUpdate) {
          if (updateData.isNewStockDoc) {
            transaction.set(updateData.ref, {
              sku: updateData.item.sku,
              brand: updateData.item.brand,
              model: updateData.item.model,
              size: updateData.item.size,
              quantity: updateData.newQty,
              price: 0,
              priceCash: 0,
              priceInstallment: 0,
              notes: `Criado via transferência de ${latestTData.sourceCompanyName}`,
              description: `${updateData.item.size} ${updateData.item.brand} ${updateData.item.model}`.trim(),
              imageUrl: "",
              companyId: latestTData.destinationCompanyId,
              companyName: latestTData.destinationCompanyName,
              userId: user.uid,
              userEmail: user.email,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          } else {
            transaction.update(updateData.ref, {
              quantity: updateData.newQty,
              updatedAt: serverTimestamp()
            });
          }

          // Este e o registro que faz a transferencia aparecer como ENTRADA na
          // tela de Entradas e Saidas da empresa de destino (e o par
          // TRANSFERENCIA_SAIDA, gravado no despacho, como saida na origem).
          for (const movementItem of updateData.items) {
            const movementRef = doc(collection(db, "movements"));
            transaction.set(movementRef, {
              sku: movementItem.sku,
              brand: movementItem.brand,
              model: movementItem.model,
              size: movementItem.size,
              type: "TRANSFERENCIA_ENTRADA",
              quantity: movementItem.quantity,
              balanceAfter: updateData.newQty,
              companyId: latestTData.destinationCompanyId,
              companyName: latestTData.destinationCompanyName,
              userId: user.uid,
              userEmail: user.email,
              timestamp: serverTimestamp(),
              reason: `Recebido de ${latestTData.sourceCompanyName} — assinado por ${user.displayName}`,
              transferId
            });
          }
        }

        // Preserva a via do recebedor exatamente como foi assinada.
        const receiverRecord = latestTData.arrival.receiver;

        transaction.update(transferRef, {
          status: "CONCLUIDO",
          arrival: {
            receiver: receiverRecord,
            driver: {
              signedByUid: "MOTORISTA",
              signedByEmail: "",
              signedByName: driverName.trim(),
              signedAt: serverTimestamp(),
              signatureDataUrl: driverSignatureDataUrl,
              method
            }
          },
          receipt: receiverRecord,
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao assinar recebimento:", err);
      throw new Error(err.message || "Erro ao registrar a assinatura de recebimento.");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Confirmação da reserva = baixa (reserva de cliente da própria loja)
  //
  // Fecha um pedido com destino CLIENTE_COMPANY_ID cujo pneu está na MESMA loja
  // em que o vendedor atende. O pneu já estava preso desde que o vendedor abriu
  // a reserva; o que este passo faz é a BAIXA — é o "só dá baixa quando o adm
  // confirma". Um clique só: confirmar a reserva e tirar o pneu do estoque são
  // a mesma coisa, e não existe estado intermediário entre eles.
  //
  // Numa única transação atômica:
  //   1. debita `quantity` do estoque da ORIGEM;
  //   2. devolve a mesma quantidade de `reservedQuantity` — a reserva deixou de
  //      existir porque virou saída real (mesma conversão que o despacho de uma
  //      transferência faz em handleCompleteDispatch);
  //   3. grava a SAIDA em `movements` com o cliente em partyName, para a venda
  //      aparecer em Entradas e Saídas como qualquer outra baixa;
  //   4. encerra o pedido em CONCLUIDO.
  // Não há dupla contagem: quem debita o saldo é só este passo — a criação da
  // reserva apenas prende o pneu, nunca baixa.
  // ─────────────────────────────────────────────────────────────────
  const handleCompleteSale = async (transferId: string) => {
    if (!user) return;

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists()) {
          throw new Error("Reserva não encontrada (pode ter sido excluída).");
        }
        const transferData: any = transferSnap.data();

        if (!isCustomerReservation(transferData)) {
          throw new Error("Este pedido é uma transferência entre filiais — conclua pelo fluxo de assinaturas.");
        }
        // Reserva de pneu de OUTRA loja nunca sai do estoque por aqui: ela vira
        // transferencia depois dos dois avais e a baixa acontece no despacho
        // assinado. Concluir a venda na origem entregaria o pneu a ninguem — o
        // cliente esta na loja do vendedor, do outro lado da cidade.
        if (isCrossStoreReservation(transferData)) {
          throw new Error(
            `Esta reserva é de ${transferData.requestedByCompanyName || "outra loja"} — ela precisa dos dois ` +
            `avais e vira transferência. A baixa acontece quando o envio for assinado.`
          );
        }
        // SOLICITADO e o estado normal de uma reserva de cliente: ela nasce com o
        // pneu preso e e esta confirmacao que da a baixa. PENDENTE/AGENDADO ficam
        // aceitos para as reservas aprovadas por versoes anteriores do sistema.
        if (
          transferData.status !== "SOLICITADO" &&
          transferData.status !== "PENDENTE" &&
          transferData.status !== "AGENDADO"
        ) {
          throw new Error(`Esta reserva não está mais aberta (situação atual: ${transferData.status}).`);
        }
        if (user.role !== "admin" && transferData.sourceCompanyId !== user.companyId) {
          throw new Error("Só a loja que tem o pneu no estoque pode confirmar esta reserva.");
        }

        const items = transferData.items || [];
        if (items.length === 0) {
          throw new Error("Reserva não contém itens.");
        }

        // Com a reserva ativa, a baixa consome o próprio saldo reservado. Se ela
        // tiver sido liberada antes, a venda disputa o saldo livre como qualquer
        // outra saída — e pode legitimamente faltar pneu.
        const wasReserved = transferData.reservation?.active === true;
        const customerName = (transferData.customerName || "").trim() || "Não informado";
        const operationId = `VENDA-${transferId}`;

        // --- TODAS AS LEITURAS PRIMEIRO (exigência do Firestore) ---
        const stockDataToUpdate = [];
        for (const item of items) {
          if (!item?.sourceStockItemId) {
            throw new Error(`O item ${item?.sku || ""} da reserva não aponta para nenhum produto do estoque.`);
          }
          const sourceStockRef = doc(db, "stock", item.sourceStockItemId);
          const sourceStockSnap = await transaction.get(sourceStockRef);

          if (!sourceStockSnap.exists()) {
            throw new Error(`O pneu ${item.sku} não existe mais no estoque da loja.`);
          }

          const sourceData: any = sourceStockSnap.data();
          const currentQty = sourceData.quantity ?? 0;
          const currentReserved = reservedQuantityOf(sourceData);
          const qty = Number(item.quantity) || 0;

          if (currentQty < qty) {
            throw new Error(
              `Estoque insuficiente para ${item.sku}. Saldo atual: ${currentQty} un, necessário: ${qty} un.`
            );
          }

          const newQty = currentQty - qty;
          // A reserva DESTE pedido sai do contador; a de outros pedidos permanece.
          const newReserved = wasReserved
            ? Math.max(0, currentReserved - qty)
            : currentReserved;

          // Uma venda sem reserva própria não pode comer o que outro pedido já
          // prendeu — aquele saldo está prometido a outra filial ou cliente.
          if (newQty < newReserved) {
            throw new Error(
              `${newReserved} un de ${item.sku} estão reservadas para outro pedido. ` +
              `Livre: ${Math.max(0, currentQty - currentReserved)} un, necessário: ${qty} un.`
            );
          }

          stockDataToUpdate.push({
            ref: sourceStockRef,
            newQty,
            newReserved,
            reservedChanged: newReserved !== currentReserved,
            unitPrice: Number(sourceData.priceCash ?? sourceData.price ?? 0) || 0,
            item
          });
        }

        // --- DEPOIS TODAS AS ESCRITAS ---
        for (const updateData of stockDataToUpdate) {
          const qty = Number(updateData.item.quantity) || 0;

          transaction.update(updateData.ref, {
            quantity: updateData.newQty,
            ...(updateData.reservedChanged ? { reservedQuantity: updateData.newReserved } : {}),
            updatedAt: serverTimestamp()
          });

          const movementRef = doc(collection(db, "movements"));
          transaction.set(movementRef, {
            sku: updateData.item.sku,
            brand: updateData.item.brand,
            model: updateData.item.model,
            size: updateData.item.size,
            type: "SAIDA",
            quantity: -qty,
            balanceAfter: updateData.newQty,
            companyId: transferData.sourceCompanyId,
            companyName: transferData.sourceCompanyName,
            userId: user.uid,
            userEmail: user.email,
            timestamp: serverTimestamp(),
            reason:
              `Saída de pneus — Venda • Cliente: ${customerName} • ` +
              `Reserva de ${transferData.requestedByName || "vendedor"} (${operationId})`,
            // Os campos abaixo são os mesmos que o módulo de Entradas e Saídas
            // grava: sem eles a venda não se agrupa como operação no histórico
            // nem aparece com o nome do cliente na coluna "Fornecedor / Cliente".
            stockItemId: updateData.item.sourceStockItemId,
            operationId,
            operationReason: "Venda",
            docNumber: "",
            partyName: customerName,
            partyDoc: "",
            vehiclePlate: "",
            observation: (transferData.reason || "").trim(),
            unitPrice: updateData.unitPrice,
            totalAmount: updateData.unitPrice * qty,
            transferId
          });
        }

        transaction.update(transferRef, {
          status: "CONCLUIDO",
          // A reserva vira saída real: fica registrada como encerrada,
          // preservando quem reservou e quando (auditoria não se apaga).
          ...(wasReserved
            ? {
                reservation: {
                  ...transferData.reservation,
                  active: false,
                  releasedAt: serverTimestamp(),
                  releasedReason: "Venda concluída e entregue ao cliente"
                }
              }
            : {}),
          // Confirmar E dar baixa sao o mesmo clique numa reserva da propria
          // loja, entao os dois carimbos saem juntos: quem aprovou e quem
          // fechou a venda sao a mesma pessoa, no mesmo instante.
          approvedByUid: user.uid,
          approvedByName: user.displayName,
          approvedAt: serverTimestamp(),
          sourceApprovedByUid: user.uid,
          sourceApprovedByName: user.displayName,
          sourceApprovedAt: serverTimestamp(),
          saleCompletedByUid: user.uid,
          saleCompletedByName: user.displayName,
          saleCompletedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao confirmar a reserva:", err);
      throw describeTransferWriteError(err, "Erro ao confirmar a reserva e dar baixa.");
    }
  };


  // ─────────────────────────────────────────────────────────────────
  // Regularização do histórico de transferências
  //
  // Toda transferência assinada grava o seu movimento na MESMA transação que
  // muda o status do pedido — despacho grava TRANSFERENCIA_SAIDA na origem,
  // recebimento grava TRANSFERENCIA_ENTRADA no destino. Ainda assim o registro
  // pode não existir mais: pedidos concluídos por versões antigas do app (antes
  // do movimento passar a ser gravado), histórico limpo em Relatórios, ou
  // exclusão manual de movimentos por um admin.
  //
  // Esta rotina recria SÓ O REGISTRO que falta, com a data real da assinatura.
  // Nunca mexe em saldo: o pneu já saiu e já entrou fisicamente — mexer no
  // estoque aqui contaria a mesma transferência duas vezes. É idempotente:
  // confere no servidor o que já existe (por pedido, lado e SKU) antes de
  // gravar, então rodar de novo não duplica nada.
  // ─────────────────────────────────────────────────────────────────
  const handleSyncTransferMovements = async (): Promise<TransferSyncResult> => {
    if (!user) throw new Error("Sessão expirada. Entre novamente.");
    if (user.role !== "admin" && user.role !== "alimentador") {
      throw new Error("Somente o administrador ou o responsável da filial pode regularizar o histórico.");
    }

    // Alimentador só enxerga e só pode gravar movimentos da própria empresa
    // (ver a regra de movements em firestore.rules). Admin regulariza os dois lados.
    const scopedCompanyId = user.role === "alimentador" ? (user.companyId || "") : "";
    if (user.role === "alimentador" && !scopedCompanyId) {
      throw new Error("Seu usuário não está vinculado a uma empresa.");
    }

    const result: TransferSyncResult = { scanned: 0, alreadyOk: 0, repaired: 0, created: 0, blocked: 0 };
    const movementsRef = collection(db, "movements");

    // Só pedidos que já movimentaram estoque de verdade. EM_TRANSITO tem apenas
    // a saída; CONCLUIDO tem os dois lados. Os demais status não movimentam nada.
    //
    // Reserva de cliente fica de FORA, mesmo concluída: ela não é transferência
    // nenhuma. O pneu foi do balcão para a mão do cliente e já está gravado como
    // SAIDA (com o nome dele). Se entrasse aqui, esta rotina veria "falta a linha
    // de TRANSFERENCIA_SAIDA" — tipo diferente do que existe — e gravaria a mesma
    // venda uma segunda vez, além de tentar uma TRANSFERENCIA_ENTRADA para a
    // empresa sentinela 'CLIENTE', que não existe em `companies`.
    // As reservas CONVERTIDAS em transferência continuam entrando: ali o destino
    // é uma loja de verdade e as duas pontas se movimentam mesmo.
    const relevant = transfers.filter(
      t => (t.status === "EM_TRANSITO" || t.status === "CONCLUIDO") && !isCustomerReservation(t)
    );

    for (const t of relevant) {
      const items = (t.items || []).filter((item: any) => item && item.sku);
      if (items.length === 0) continue;

      const sides = [
        {
          type: "TRANSFERENCIA_SAIDA" as const,
          companyId: t.sourceCompanyId || "",
          companyName: t.sourceCompanyName || "",
          signedAt: t.dispatch?.driver?.signedAt || t.dispatch?.sender?.signedAt || t.delivery?.signedAt || t.updatedAt,
          signedByName: t.dispatch?.sender?.signedByName || t.delivery?.signedByName || "",
          reason: `Transferência para ${t.destinationCompanyName || "outra filial"}`
        },
        ...(t.status === "CONCLUIDO" ? [{
          type: "TRANSFERENCIA_ENTRADA" as const,
          companyId: t.destinationCompanyId || "",
          companyName: t.destinationCompanyName || "",
          signedAt: t.arrival?.driver?.signedAt || t.arrival?.receiver?.signedAt || t.receipt?.signedAt || t.updatedAt,
          signedByName: t.arrival?.receiver?.signedByName || t.receipt?.signedByName || "",
          reason: `Recebido de ${t.sourceCompanyName || "outra filial"}`
        }] : [])
      ];

      const mySides = sides.filter(s => s.companyId && (!scopedCompanyId || s.companyId === scopedCompanyId));
      if (mySides.length === 0) {
        result.blocked += 1;
        continue;
      }

      // A verdade é a do servidor, não a da lista em memória (que é uma janela
      // das últimas movimentações e pode não alcançar pedidos antigos).
      const existingSnap = await getDocs(
        scopedCompanyId
          ? query(movementsRef, where("transferId", "==", t.id), where("companyId", "==", scopedCompanyId))
          : query(movementsRef, where("transferId", "==", t.id))
      );

      // Conta por lado+SKU: assim uma gravação parcial também é completada, e
      // um pedido com o mesmo SKU repetido não perde a segunda linha.
      const existingCount = new Map<string, number>();
      existingSnap.forEach(docSnap => {
        const data: any = docSnap.data();
        const key = `${data.type}|${data.sku}`;
        existingCount.set(key, (existingCount.get(key) || 0) + 1);
      });

      result.scanned += 1;
      const batch = writeBatch(db);
      let createdHere = 0;

      for (const side of mySides) {
        for (const item of items) {
          const key = `${side.type}|${item.sku}`;
          const remaining = existingCount.get(key) || 0;
          if (remaining > 0) {
            existingCount.set(key, remaining - 1);
            continue;
          }

          const quantity = Number(item.quantity) || 0;
          const isEntry = side.type === "TRANSFERENCIA_ENTRADA";
          // Saldo do momento da regularização — o saldo da época da assinatura
          // não existe mais em lugar nenhum. O selo `rebuilt` avisa a tela.
          const currentBalance = stock.find(
            s => s.companyId === side.companyId && s.sku === item.sku
          )?.quantity ?? 0;

          batch.set(doc(movementsRef), {
            sku: item.sku,
            brand: item.brand || "",
            model: item.model || "",
            size: item.size || "",
            type: side.type,
            quantity: isEntry ? quantity : -quantity,
            balanceAfter: currentBalance,
            companyId: side.companyId,
            companyName: side.companyName,
            userId: user.uid,
            userEmail: user.email,
            timestamp: side.signedAt || serverTimestamp(),
            reason: side.signedByName
              ? `${side.reason} — assinado por ${side.signedByName}`
              : side.reason,
            transferId: t.id,
            rebuilt: true
          });
          createdHere += 1;
        }
      }

      if (createdHere === 0) {
        result.alreadyOk += 1;
        continue;
      }

      await batch.commit();
      result.repaired += 1;
      result.created += createdHere;
    }

    return result;
  };

  // Admin-only recovery path: reverses a transfer stuck "in transit" (delivery signed,
  // receipt never confirmed — e.g. goods lost, or created by mistake after dispatch).
  // Restores the source stock and closes the transfer out as cancelled.
  const handleReverseInTransitTransfer = async (transferId: string) => {
    if (!user || user.role !== "admin") return;

    try {
      await runTransaction(db, async (transaction) => {
        const transferRef = doc(db, "transfers", transferId);
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists()) throw new Error("Pedido de transferência não encontrado.");
        const transferData: any = transferSnap.data();

        if (transferData.status !== "EM_TRANSITO") {
          throw new Error("Só é possível estornar pedidos em trânsito (entrega assinada, recebimento pendente).");
        }

        // Um pedido carrega uma LISTA de itens. A versao anterior lia
        // transferData.sourceStockItemId/quantity/sku — campos de quando a
        // transferencia era de um item so — entao o estorno falhava (ou pior,
        // gravava undefined) em qualquer pedido criado pela tela atual.
        const items = transferData.items || [];
        if (items.length === 0) {
          throw new Error("Pedido não contém itens para estornar.");
        }

        // --- TODAS AS LEITURAS ---
        const pending: { ref: any; item: any; restoredQty: number; exists: boolean }[] = [];
        for (const item of items) {
          const sourceStockRef = doc(db, "stock", item.sourceStockItemId);
          const sourceStockSnap = await transaction.get(sourceStockRef);
          const exists = sourceStockSnap.exists();
          const currentQty = exists ? (sourceStockSnap.data()?.quantity ?? 0) : 0;
          pending.push({
            ref: sourceStockRef,
            item,
            restoredQty: currentQty + (Number(item.quantity) || 0),
            exists
          });
        }

        // --- DEPOIS TODAS AS ESCRITAS ---
        for (const entry of pending) {
          const { ref, item, restoredQty, exists } = entry;

          if (exists) {
            transaction.update(ref, {
              quantity: restoredQty,
              updatedAt: serverTimestamp()
            });
          }

          const movementRef = doc(collection(db, "movements"));
          transaction.set(movementRef, {
            sku: item.sku || "N/A",
            brand: item.brand || "N/A",
            model: item.model || "N/A",
            size: item.size || "N/A",
            type: "AJUSTE",
            quantity: Number(item.quantity) || 0,
            balanceAfter: restoredQty,
            companyId: transferData.sourceCompanyId || "",
            companyName: transferData.sourceCompanyName || "",
            userId: user.uid,
            userEmail: user.email,
            timestamp: serverTimestamp(),
            reason: `Estorno de transferência abandonada em trânsito para ${transferData.destinationCompanyName}` +
              (exists ? "" : " (produto não localizado na origem — apenas registro)"),
            transferId
          });
        }

        transaction.update(transferRef, {
          status: "CANCELADO",
          cancelledByUid: user.uid,
          cancelledByName: user.displayName,
          cancelledAt: serverTimestamp(),
          cancelReason: "Estornado pelo administrador (transferência abandonada em trânsito)",
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao estornar transferência:", err);
      throw new Error(err.message || "Erro ao estornar a transferência.");
    }
  };

  // Send support message and console logs via WhatsApp
  const handleSendErrorReport = () => {
    if (!user || !errorComment.trim()) return;

    let message = `*Central Stoque - Relato de Suporte*\n\n`;
    message += `*Usuário:* ${user.displayName}\n`;
    message += `*E-mail:* ${user.email}\n`;
    message += `*Perfil:* ${user.role.toUpperCase()}\n`;
    message += `*Empresa:* ${user.companyName || "Nenhuma"}\n\n`;
    message += `*Relato/Dificuldade:*\n${errorComment.trim()}\n\n`;

    if (sendLogs) {
      const logs = (window as any).getConsoleLogs() || [];
      if (logs.length > 0) {
        message += `*Logs do Console (Últimos 15):*\n\`\`\`\n`;
        const lastLogs = logs.slice(-15).join("\n");
        message += `${lastLogs}\n\`\`\``;
      }
    }

    const whatsappUrl = `https://wa.me/5573991422872?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, "_blank");
    setShowReportModal(false);
  };

  // Loading indicator for authorization check
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex flex-col items-center justify-center font-sans gap-4 animate-fadeIn select-none">
        <div className="relative flex items-center justify-center">
          <div className="h-12 w-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <Warehouse className="h-5 w-5 text-blue-400 absolute" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-white font-extrabold text-sm tracking-tight">Central Stoque</p>
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Verificando Credenciais...</span>
        </div>
      </div>
    );
  }

  // Not signed-in -> render Auth Screen
  if (!user) {
    return <AuthScreen onAuthSuccess={(profile) => setUser(profile)} />;
  }

  // Calculate overview metrics for top panel header (own company's stock only —
  // ownScopedStock already resolves to everything for admin/vendedor)
  const filteredKpiStock = kpiCompanyId === "ALL" 
    ? ownScopedStock 
    : ownScopedStock.filter(item => item.companyId === kpiCompanyId);

  const totalStockItemsCount = filteredKpiStock.length;
  const totalPneumaticsSum = filteredKpiStock.reduce((acc, item) => acc + (Number(item.quantity) || 0), 0);
  // Quanto desse volume já tem dono. Fica ao lado do total físico porque os dois
  // números são verdadeiros ao mesmo tempo: o pneu está no galpão E não pode ser
  // vendido. Mostrar só o primeiro é o que faz alguém prometer o que não tem.
  const reservedPneumaticsSum = filteredKpiStock.reduce((acc, item) => acc + reservedQuantityOf(item), 0);
  // Reposição se mede pelo que dá para VENDER, não pelo que está na prateleira:
  // um pneu com 6 un, 5 delas reservadas, tem 1 un vendável e é caso de compra.
  // Enquanto esta conta usava `quantity`, o alerta ficava mudo justo nesse caso.
  const lowStockItems = filteredKpiStock.filter(item => availableQuantity(item) <= 4).length;
  const totalCostValue = filteredKpiStock.reduce((acc, item) => acc + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0);

  // ── Visão Geral do vendedor: só o alerta de reposição ────────────────
  // O vendedor enxerga o estoque de TODAS as filiais (é o que permite achar o
  // pneu do cliente na loja vizinha), e a Visão Geral transformava esse acesso
  // num raio-x do grupo: quantos modelos cada loja tem, quantas unidades e —
  // pior — o capital imobilizado, R$ 2,3 milhões na tela de quem só precisa
  // saber se tem pneu para vender. Sobra o alerta de reposição, que é a única
  // dessas quatro contas que muda o que ele faz no balcão: avisa que o pneu
  // está no fim antes de ele prometer a entrega.
  const isSellerKpi = user.role === "vendedor";

  return (
    <div className="min-h-screen bg-slate-50/70 flex flex-col md:flex-row font-sans transition-colors text-slate-800">
      
      {/* ====== DESKTOP SIDEBAR: Visible only on medium screens and up ====== */}
      <aside className="hidden md:flex md:w-64 bg-[#0b0f19] text-white flex-col justify-between border-r border-gold-500/10 sticky top-0 h-screen z-40 shrink-0">
        
        {/* Top Section: Brand Logo & Vertical Nav */}
        <div className="flex flex-col p-5 space-y-7">
          
          {/* Logo Area */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] flex items-center justify-center shadow-lg shadow-gold-500/20 font-black hover:scale-105 active:scale-95 transition-all duration-300 border border-gold-300/30 shrink-0">
                <Warehouse className="h-5 w-5 stroke-[2.2]" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-black text-white tracking-tight leading-none uppercase flex items-center gap-1">
                  Central Stoque <span className="text-[9px] text-gold-400 font-black tracking-normal lowercase italic bg-gold-500/10 px-1.5 py-0.5 rounded-md border border-gold-500/20">v2.0</span>
                </h1>
              </div>
            </div>
            <NotificationBell
              notifications={notifications}
              unreadCount={unreadCount}
              onMarkAllAsRead={markAllAsRead}
              onNotificationClick={handleNotificationClick}
              theme="dark"
              align="left"
            />
          </div>

          {/* Navigation Links Column */}
          <nav className="flex flex-col gap-1.5">
            {(user.role === "admin" || user.role === "vendedor") && (
              <button
                type="button"
                onClick={() => setActiveTab("catalogo")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                  activeTab === "catalogo"
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <Search size={14} className="stroke-[2px]" /> Catálogo e Reservas
              </button>
            )}

            {user.role !== "vendedor" && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveTab("unified")}
                  className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                    activeTab === "unified"
                      ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                      : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                  }`}
                >
                  <Warehouse size={14} className="stroke-[2px]" /> Estoque Unificado
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("analytics")}
                  className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                    activeTab === "analytics" 
                      ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                      : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                  }`}
                >
                  <TrendingUp size={14} className="stroke-[2px]" /> Painel de Indicadores
                </button>

                {(user.role === "alimentador" || user.role === "admin") && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("inventory")}
                    className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                      activeTab === "inventory" 
                        ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                        : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                    }`}
                  >
                    <Layers size={14} className="stroke-[2px]" /> Cadastros e Ajustes
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setActiveTab("stock-flow")}
                  className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                    activeTab === "stock-flow"
                      ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                      : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                  }`}
                >
                  <ArrowDownUp size={14} className="stroke-[2px]" /> Entradas e Saídas
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("pdf-import")}
                  className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                    activeTab === "pdf-import" 
                      ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                      : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                  }`}
                >
                  <FileUp size={14} className="stroke-[2px]" /> Importar Estoque
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("reports")}
                  className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                    activeTab === "reports" 
                      ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                      : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                  }`}
                >
                  <Activity size={14} className="stroke-[2px]" /> Auditoria & Histórico
                </button>
              </>
            )}

            {/* Reservas fica ANTES de Transferências de propósito: é a fila que
                tem cliente esperando do outro lado, e a que trava saldo no
                estoque enquanto ninguém decide. */}
            <button
              type="button"
              onClick={() => setActiveTab("reservations")}
              className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2.5 border ${
                activeTab === "reservations"
                  ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                  : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <ShoppingBag size={14} className="stroke-[2px]" /> {user.role === "vendedor" ? "Minhas Reservas" : "Reservas"}
              </span>
              {pendingReservationsCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                  {pendingReservationsCount}
                </span>
              )}
            </button>

            {/* Sugestões: a fila que vem DEPOIS da venda que não aconteceu.
                Fica colada em Reservas de propósito — as duas são demanda de
                cliente trazida pelo vendedor; a diferença é que aqui o pneu
                nem existe no estoque ainda. */}
            {canSeeSuggestions && (
              <button
                type="button"
                onClick={() => setActiveTab("suggestions")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2.5 border ${
                  activeTab === "suggestions"
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Lightbulb size={14} className="stroke-[2px]" /> Sugestões
                </span>
                {pendingSuggestionsCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-gold-500 text-slate-900 text-[9px] font-black">
                    {pendingSuggestionsCount}
                  </span>
                )}
              </button>
            )}

            {user.role !== "vendedor" && (
              <button
                type="button"
                onClick={() => setActiveTab("transfers")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                  activeTab === "transfers"
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <ArrowLeftRight size={14} className="stroke-[2px]" /> Transferências
              </button>
            )}

            {canManageUsers && (
              <button
                type="button"
                onClick={() => setActiveTab("users-admin")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                  activeTab === "users-admin" 
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <Users size={14} className="stroke-[2px]" /> {user.role === "admin" ? "Operadores e Senhas" : "Meus Vendedores"}
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab("how-to-use")}
              className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                activeTab === "how-to-use" 
                  ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                  : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
              }`}
            >
              <BookOpen size={14} className="stroke-[2px]" /> Como Usar o Sistema
            </button>

            {user.role === "admin" && (
              <button
                type="button"
                onClick={() => setActiveTab("apk-installer")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                  activeTab === "apk-installer" 
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <Smartphone size={14} className="stroke-[2px]" /> Instalar App
              </button>
            )}
          </nav>
        </div>

        {/* Bottom Section: Profile Card & Logout */}
        <div className="p-4 border-t border-slate-900 bg-slate-950/40">
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-slate-900 border border-gold-500/30 flex items-center justify-center text-gold-400 font-extrabold text-xs uppercase shadow-inner shrink-0">
                {user.displayName.substring(0, 2)}
              </div>
              <div className="text-left leading-none space-y-1 min-w-0">
                <span className="text-xs font-extrabold text-white block truncate max-w-[110px]" title={user.displayName}>
                  {user.displayName}
                </span>
                {user.role === "admin" ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-black bg-gold-600/20 text-gold-400 border border-gold-500/30 uppercase tracking-widest font-mono">
                    <ShieldCheck size={8} className="stroke-[2.5px]" /> Admin Master
                  </span>
                ) : user.role === "vendedor" ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-bold bg-blue-900/40 border border-blue-500/30 text-blue-300 uppercase tracking-wider">
                    Vendedor
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-bold bg-slate-800 border border-slate-700 text-slate-300 uppercase tracking-wider">
                    Dono da Empresa
                  </span>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-0.5">
              {user.credentialId && (
                <button
                  type="button"
                  onClick={() => {
                    setChangePasswordError("");
                    setNewPassword("");
                    setShowChangePasswordModal(true);
                  }}
                  className="p-1.5 text-slate-400 hover:text-gold-400 rounded-lg hover:bg-slate-900 transition-all cursor-pointer shrink-0"
                  title="Alterar minha senha de acesso"
                >
                  <Key size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-900 transition-all cursor-pointer shrink-0"
                title="Sair do sistema piloto"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>

      </aside>

      {/* ====== MOBILE HEADER: Visible only on cellphones ====== */}
      <header className="md:hidden bg-[#0b0f19] border-b border-gold-500/10 text-white p-4 flex items-center justify-between z-40 sticky top-0 backdrop-blur-md bg-opacity-95">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] flex items-center justify-center border border-gold-300/30">
            <Warehouse className="h-4.5 w-4.5 stroke-[2.2]" />
          </div>
          <div>
            <h1 className="text-xs font-black text-white tracking-tight leading-none uppercase">
              Central Stoque <span className="text-[8px] text-gold-400 font-bold lowercase italic px-1 py-0.2 rounded border border-gold-500/10">v2.0</span>
            </h1>
          </div>
        </div>
        
        <div className="flex items-center gap-1">
          <NotificationBell
            notifications={notifications}
            unreadCount={unreadCount}
            onMarkAllAsRead={markAllAsRead}
            onNotificationClick={handleNotificationClick}
            theme="dark"
            align="right"
          />
          <button
            type="button"
            onClick={handleLogout}
            className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-900 transition-all"
            title="Sair do sistema"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Mobile navigation bottom bar */}
      <div className="md:hidden bg-[#0b0f19] border-t border-gold-500/20 fixed bottom-0 inset-x-0 h-16 z-40 flex items-stretch divide-x divide-slate-800 shadow-[0_-4px_25px_rgba(0,0,0,0.2)] overflow-x-auto">
        {(user.role === "admin" || user.role === "vendedor") && (
          <button
            type="button"
            onClick={() => setActiveTab("catalogo")}
            className={`min-w-[70px] flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 ${
              activeTab === "catalogo" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
            }`}
          >
            <Search size={18} />
            <span className="text-[9px] font-extrabold uppercase tracking-wide">Catálogo</span>
          </button>
        )}

        {user.role !== "vendedor" && (
          <>
            <button
              type="button"
              onClick={() => setActiveTab("unified")}
              className={`min-w-[70px] flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 ${
                activeTab === "unified" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
              }`}
            >
              <Warehouse size={18} />
              <span className="text-[9px] font-extrabold uppercase tracking-wide">Geral</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("analytics")}
              className={`min-w-[70px] flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 ${
                activeTab === "analytics" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
              }`}
            >
              <TrendingUp size={18} />
              <span className="text-[9px] font-extrabold uppercase tracking-wide">Painel</span>
            </button>

            {(user.role === "alimentador" || user.role === "admin") && (
              <button
                type="button"
                onClick={() => setActiveTab("inventory")}
                className={`min-w-[70px] flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 ${
                  activeTab === "inventory" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
                }`}
              >
                <Layers size={18} />
                <span className="text-[9px] font-extrabold uppercase tracking-wide">Cadastros</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab("stock-flow")}
              className={`min-w-[70px] flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 ${
                activeTab === "stock-flow" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
              }`}
            >
              <ArrowDownUp size={18} />
              <span className="text-[9px] font-extrabold uppercase tracking-wide">Ent/Saí</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("pdf-import")}
              className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all ${
                activeTab === "pdf-import" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
              }`}
            >
              <FileUp size={18} />
              <span className="text-[9px] font-extrabold uppercase tracking-wide">Importar</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("reports")}
              className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all ${
                activeTab === "reports" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
              }`}
            >
              <Activity size={18} />
              <span className="text-[9px] font-extrabold uppercase tracking-wide">Relatórios</span>
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setActiveTab("reservations")}
          className={`relative flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 min-w-[60px] ${
            activeTab === "reservations" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
          }`}
        >
          <ShoppingBag size={18} />
          {pendingReservationsCount > 0 && (
            <span className="absolute top-2 right-1/2 translate-x-4 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-gold-500 text-slate-900 text-[8px] font-black">
              {pendingReservationsCount}
            </span>
          )}
          <span className="text-[9px] font-extrabold uppercase tracking-wide">Reservas</span>
        </button>

        {canSeeSuggestions && (
          <button
            type="button"
            onClick={() => setActiveTab("suggestions")}
            className={`relative flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 min-w-[60px] ${
              activeTab === "suggestions" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
            }`}
          >
            <Lightbulb size={18} />
            {pendingSuggestionsCount > 0 && (
              <span className="absolute top-2 right-1/2 translate-x-4 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-gold-500 text-slate-900 text-[8px] font-black">
                {pendingSuggestionsCount}
              </span>
            )}
            <span className="text-[9px] font-extrabold uppercase tracking-wide">Sugestões</span>
          </button>
        )}

        {user.role !== "vendedor" && (
          <button
            type="button"
            onClick={() => setActiveTab("transfers")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 min-w-[60px] ${
              activeTab === "transfers" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
            }`}
          >
            <ArrowLeftRight size={18} />
            <span className="text-[9px] font-extrabold uppercase tracking-wide">Transf.</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setActiveTab("how-to-use")}
          className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all px-1 min-w-[50px] ${
            activeTab === "how-to-use" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-slate-900/10"
          }`}
        >
          <BookOpen size={18} />
          <span className="text-[9px] font-extrabold uppercase tracking-wide">Ajuda</span>
        </button>
        {canManageUsers && (
          <button
            type="button"
            onClick={() => setActiveTab("users-admin")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all ${
              activeTab === "users-admin" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-[#0b0f19]"
            }`}
          >
            <Users size={18} />
            <span className="text-[9px] font-extrabold uppercase tracking-wide">
              {user.role === "admin" ? "Operadores" : "Vendedores"}
            </span>
          </button>
        )}
      </div>

      {/* Right Side Content Panel */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 mb-20 md:mb-6 flex-1 space-y-6">
        
        {/* Sub-Header KPI Dashlet Cards */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black tracking-tight text-slate-800">Visão Geral</h2>
            {(user.role === "admin" || user.role === "vendedor") && (
              <select
                value={kpiCompanyId}
                onChange={(e) => setKpiCompanyId(e.target.value)}
                className="text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-1.5 shadow-sm outline-none cursor-pointer focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 transition-all"
              >
                <option value="ALL">Todas as Lojas</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>
          <div className={`grid gap-5 font-sans ${
            isSellerKpi ? "grid-cols-1 sm:max-w-xs" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
          }`}>

            {/* Card 1: Total SKUs */}
            {!isSellerKpi && (
            <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
            <div className="space-y-1">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Modelos Cadastrados</span>
              <p className="text-2xl font-black text-slate-900 tracking-tight">{totalStockItemsCount}</p>
            </div>
            <div className="h-11 w-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-inner">
              <PackageCheck size={20} className="stroke-[1.8]" />
            </div>
          </div>
          )}

          {/* Card 2: Total Sum of physical pneumatics units */}
          {!isSellerKpi && (
          <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
            <div className="space-y-1">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Volume de Pneus</span>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {totalPneumaticsSum} <span className="text-xs font-bold text-slate-500 font-sans uppercase">unid.</span>
              </p>
              {reservedPneumaticsSum > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-black text-amber-700 uppercase tracking-wider">
                  {reservedPneumaticsSum} un reservadas · {Math.max(0, totalPneumaticsSum - reservedPneumaticsSum)} livres
                </span>
              )}
            </div>
            <div className="h-11 w-11 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center border border-sky-100 shadow-inner">
              <TrendingUp size={20} className="stroke-[1.8]" />
            </div>
          </div>
          )}

          {/* Card 3: Alert items — o único que sobra para o vendedor */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
            <div className="space-y-1">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Alertas de Reposição</span>
              <p className="text-2xl font-black text-red-600 tracking-tight flex items-baseline gap-1">
                {lowStockItems} <span className="text-xs font-bold text-slate-500 font-sans uppercase">críticos</span>
              </p>
            </div>
            <div className={`h-11 w-11 rounded-xl flex items-center justify-center border shadow-inner transition-colors duration-300 ${
              lowStockItems > 0 
                ? "bg-red-50 text-red-600 border-red-100 animate-pulse" 
                : "bg-slate-50 text-slate-400 border-slate-100"
            }`}>
              <PackageOpen size={20} className="stroke-[1.8]" />
            </div>
          </div>

          {/* Card 4: Capital Imobilizado */}
          {!isSellerKpi && (
          <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
              <div className="space-y-1">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Capital Imobilizado</span>
                <p className="text-xl font-black text-emerald-600 tracking-tight">
                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalCostValue)}
                </p>
              </div>
              <div className="h-11 w-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shadow-inner">
                <DollarSign size={20} className="stroke-[1.8]" />
              </div>
            </div>
          )}

          </div>
        </div>

        {/* Dynamic Tab Panel switches */}
        <div className="transition-all duration-200">
        {/* Keyed by activeTab so a caught error resets automatically when the user
            switches away instead of leaving this panel permanently broken. */}
        <ErrorBoundary key={activeTab} variant="panel">
        <Suspense fallback={
          <div className="flex items-center justify-center py-20 text-slate-400">
            <div className="h-5 w-5 border-2 border-gold-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        }>
          {activeTab === "catalogo" && (
            <PublicStock
              user={user}
              onCreateTransfer={handleCreateTransfer}
              onCreateSuggestion={handleCreateSuggestion}
            />
          )}


          {activeTab === "unified" && (
            <div className="space-y-4">
              {loadingData && (
                <div className="bg-blue-50 border border-blue-100/60 text-blue-800 px-4 py-3 rounded-xl text-xs flex items-center justify-center gap-2 shadow-sm animate-fadeIn">
                  <div className="h-3 w-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  Sincronizando estoque operacional em tempo real...
                </div>
              )}
              <UnifiedStock 
                items={stock} 
                user={user} 
                companies={companies}
                onUpdateItem={handleUpdateItem} 
                onAddItem={handleAddItem} 
                onAddCompany={handleAddCompany}
                onRegisterFlow={
                  user.role === "admin" || user.role === "alimentador"
                    ? handleRegisterStockFlow
                    : undefined
                }
              />
            </div>
          )}

          {activeTab === "inventory" && (
            <div className="space-y-4">
              {loadingData && (
                <div className="bg-blue-50 border border-blue-100/60 text-blue-800 px-4 py-3 rounded-xl text-xs flex items-center justify-center gap-2 shadow-sm animate-fadeIn">
                  <div className="h-3 w-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  Sincronizando estoque operacional em tempo real...
                </div>
              )}
              <StockTable
                items={ownScopedStock}
                isAdmin={user.role === "admin"}
                user={user}
                companies={companies}
                onAddItem={handleAddItem}
                onUpdateItem={handleUpdateItem}
                onDeleteItem={handleDeleteItem}
                onClearStock={handleClearCompanyStock}
                onRestoreBackup={handleRestoreBackup}
              />
            </div>
          )}

          {activeTab === "stock-flow" && (
            <StockFlow
              stock={stock}
              movements={movements}
              companies={companies}
              user={user}
              transfers={transfers}
              onRegister={handleRegisterStockFlow}
              onReverse={user.role === "admin" ? handleReverseStockFlowOperation : undefined}
              onSyncTransfers={
                user.role === "admin" || user.role === "alimentador"
                  ? handleSyncTransferMovements
                  : undefined
              }
            />
          )}

          {activeTab === "pdf-import" && (
            <PDFImporter
              onSaveImportedItems={handleSaveImportedItems}
              userEmail={user.email}
              companies={companies}
              user={user}
            />
          )}

          {activeTab === "reports" && (
            <MovementReports
              logs={movements}
              isAdmin={user.role === "admin"}
              onDeleteLog={handleDeleteMovementLog}
              onClearLogs={handleClearMovementLogs}
            />
          )}

          {activeTab === "analytics" && (
            <DashboardAnalytics
              items={stock}
              movements={movements}
              companies={companies}
              user={user}
            />
          )}

          {activeTab === "reservations" && (
            <Reservations
              reservations={reservations}
              companies={companies}
              user={user}
              onConfirmSale={handleCompleteSale}
              onApproveStep={handleApproveReservationStep}
              onReject={handleRejectTransferRequest}
              onCancel={handleCancelTransfer}
              onForceRelease={handleForceReleaseReservation}
              onDelete={handleDeleteTransfer}
            />
          )}

          {activeTab === "suggestions" && canSeeSuggestions && (
            <Suggestions
              suggestions={suggestions}
              companies={companies}
              user={user}
              onResolve={handleResolveSuggestion}
              onDelete={handleDeleteSuggestion}
            />
          )}

          {activeTab === "transfers" && (
            <TransferOrders
              transfers={transfers}
              stock={stock}
              companies={companies}
              user={user}
              onCreateTransfer={handleCreateTransfer}
              onCancelTransfer={handleCancelTransfer}
              onApproveRequest={handleApproveTransferRequest}
              onRejectRequest={handleRejectTransferRequest}
              onReserveItems={handleReserveTransferItems}
              onReleaseReservation={handleReleaseTransferReservation}
              onSignSenderDispatch={handleSignSenderDispatch}
              onCompleteDispatch={handleCompleteDispatch}
              onSignReceiverArrival={handleSignReceiverArrival}
              onCompleteArrival={handleCompleteArrival}
              onCompleteSale={handleCompleteSale}
              onReverseTransfer={handleReverseInTransitTransfer}
              onDeleteTransfer={handleDeleteTransfer}
            />
          )}

          {activeTab === "users-admin" && canManageUsers && (
            <UsersAdmin
              companies={companies}
              currentUser={{ role: user.role, companyId: user.companyId, companyName: user.companyName }}
              stock={stock}
            />
          )}

          {activeTab === "how-to-use" && (
            <HowToUse />
          )}

          {activeTab === "apk-installer" && (
            <ApkInstaller />
          )}
        </Suspense>
        </ErrorBoundary>
        </div>

        </main>
      </div>

      {/* CHANGE PASSWORD MODAL */}
      {showChangePasswordModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Key size={16} className="text-gold-600" /> Alterar Minha Senha
              </h3>
              <button 
                onClick={() => setShowChangePasswordModal(false)}
                className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
            
            {changePasswordError && (
              <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-semibold border-l-4 border-red-500">
                {changePasswordError}
              </div>
            )}
            
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Nova Senha Secreta *
                </label>
                <input
                  type="password"
                  required
                  placeholder="Mínimo de 4 caracteres recomendados"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                />
                <span className="text-[10px] text-slate-400 mt-1 block font-semibold leading-relaxed">
                  Atenção: Ao alterar sua senha, você passará a utilizar essa nova credencial na etapa 2 do login.
                </span>
              </div>
              
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowChangePasswordModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={changePasswordLoading}
                  className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5"
                >
                  {changePasswordLoading && <Loader2 size={12} className="animate-spin" />}
                  Salvar Nova Senha
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NOTIFICATION TOAST: pops up for brand-new transfer/stock events regardless of active tab */}
      <NotificationToast notifications={notifications} onNotificationClick={handleNotificationClick} />

      {/* FLOATING REPORT ERROR BUTTON */}
      <button
        onClick={() => {
          setErrorComment("");
          setSendLogs(true);
          setShowReportModal(true);
        }}
        className="fixed bottom-20 md:bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg font-bold text-xs transition-all hover:scale-105 active:scale-95 cursor-pointer border border-red-500/10"
        title="Reportar erro ou dificuldade via WhatsApp"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
        </span>
        Reportar Erro / Dificuldade
      </button>

      {/* REPORT ERROR MODAL */}
      {showReportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5 text-red-600">
                <Warehouse size={16} /> Reportar Suporte / Dificuldade
              </h3>
              <button 
                onClick={() => setShowReportModal(false)}
                className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="text-xs text-slate-500 leading-relaxed font-semibold">
              Descreva o problema, dificuldade ou sugestão de melhoria. Seu relato será enviado diretamente via WhatsApp, junto com os logs do sistema para análise.
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Seu Relato / Dificuldade / Sugestão *
                </label>
                <textarea
                  required
                  rows={4}
                  value={errorComment}
                  onChange={(e) => setErrorComment(e.target.value)}
                  placeholder="Ex: Estou com dificuldade para importar a tabela... / Gostaria de relatar um erro na tela..."
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-red-500/10 focus:border-red-500 transition-all font-semibold resize-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sendLogs"
                  checked={sendLogs}
                  onChange={(e) => setSendLogs(e.target.checked)}
                  className="rounded text-red-600 focus:ring-red-500 h-4 w-4 border-slate-300 cursor-pointer"
                />
                <label htmlFor="sendLogs" className="text-xs font-bold text-slate-600 cursor-pointer select-none">
                  Incluir logs técnicos do sistema (Recomendado)
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSendErrorReport}
                disabled={!errorComment.trim()}
                className="px-4 py-2 bg-gradient-to-r from-red-600 to-red-500 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50"
              >
                Enviar via WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
