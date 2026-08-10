import { useState, useEffect, useMemo, lazy, Suspense } from "react";
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
import { StockItem, MovementLog, UserProfile, UserRole, Company, TransferOrder } from "./types";

// Components
// AuthScreen is needed immediately on first paint (logged-out users see nothing else),
// so it stays a static import. Every tab below is only ever rendered one at a time behind
// activeTab, so each is code-split into its own chunk and fetched on first visit to that
// tab — keeps the initial bundle from dragging in things like the WebUSB ADB stack
// (ApkInstaller) for users who never open that tab.
import AuthScreen from "./components/AuthScreen";
const PDFImporter = lazy(() => import("./components/PDFImporter"));
const StockTable = lazy(() => import("./components/StockTable"));
const MovementReports = lazy(() => import("./components/MovementReports"));
const UsersAdmin = lazy(() => import("./components/UsersAdmin"));
const UnifiedStock = lazy(() => import("./components/UnifiedStock"));
const DashboardAnalytics = lazy(() => import("./components/DashboardAnalytics"));
const HowToUse = lazy(() => import("./components/HowToUse"));
const TransferOrders = lazy(() => import("./components/TransferOrders"));
const ApkInstaller = lazy(() =>
  import("./components/ApkInstaller").then(m => ({ default: m.ApkInstaller }))
);

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
  Smartphone
} from "lucide-react";

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
    requestedByUid: data.requestedByUid || "",
    requestedByEmail: data.requestedByEmail || "",
    requestedByName: data.requestedByName || "",
    requestedAt: data.requestedAt,
    delivery: data.delivery || null,
    receipt: data.receipt || null,
    cancelledByUid: data.cancelledByUid || "",
    cancelledByName: data.cancelledByName || "",
    cancelledAt: data.cancelledAt,
    cancelReason: data.cancelReason || "",
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

// Helper: resolves a Firestore Timestamp (or plain Date/string) into milliseconds since epoch
function toMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value.seconds) return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export default function App() {
  const [user, setUser] = useState<{ uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string; credentialId?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // Data State
  const [stock, setStock] = useState<StockItem[]>([]);
  const [movements, setMovements] = useState<MovementLog[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Inter-company Transfer Orders State (raw per-query arrays, merged below)
  const [transfersAsSource, setTransfersAsSource] = useState<TransferOrder[]>([]);
  const [transfersAsDestination, setTransfersAsDestination] = useState<TransferOrder[]>([]);

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
  const [activeTab, setActiveTab] = useState<"inventory" | "unified" | "analytics" | "pdf-import" | "reports" | "transfers" | "users-admin" | "how-to-use" | "apk-installer">("analytics");

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
          setActiveTab("unified");
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

    // Admins and vendors query everything, alimentadores query only their own company's items!
    const stockQuery = (user.role === "admin" || user.role === "vendedor" || !user.companyId)
      ? stockCollectionRef
      : query(stockCollectionRef, where("companyId", "==", user.companyId));

    const movementsQuery = (user.role === "admin" || user.role === "vendedor" || !user.companyId)
      ? query(movementsCollectionRef, orderBy("timestamp", "desc"), limit(150))
      : query(movementsCollectionRef, where("companyId", "==", user.companyId), orderBy("timestamp", "desc"), limit(150));

    // Listen to inventory changes
    const unsubStock = onSnapshot(stockQuery, (snapshot) => {
      const itemsList: StockItem[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        itemsList.push({
          id: docSnap.id,
          sku: data.sku || "",
          brand: data.brand || "",
          model: data.model || "",
          size: data.size || "",
          quantity: data.quantity ?? 0,
          price: data.price ?? 0,
          notes: data.notes || "",
          description: data.description || "",
          imageUrl: data.imageUrl || "",
          userId: data.userId || "",
          userEmail: data.userEmail || "",
          companyId: data.companyId || "",
          companyName: data.companyName || "",
          createdAt: data.createdAt,
          updatedAt: data.updatedAt
        });
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

    // Listen to audit logs changes
    const unsubMovements = onSnapshot(movementsQuery, (snapshot) => {
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
          reason: data.reason || ""
        });
      });

      // Sort logs by newest first in memory
      const sortedLogs = logsList.sort((a, b) => {
        const timeA = a.timestamp?.seconds || 0;
        const timeB = b.timestamp?.seconds || 0;
        return timeB - timeA;
      });

      setMovements(sortedLogs);
    }, (error) => {
      console.error("Error fetching movements:", error);
    });

    return () => {
      unsubStock();
      unsubMovements();
    };
  }, [user]);

  // Trigger backup once a day when logged in as admin or alimentador
  useEffect(() => {
    if (!user || loadingData || stock.length === 0) return;
    if (user.role !== "admin" && user.role !== "alimentador") return;

    const runDailyBackup = async () => {
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        const lastBackupDate = localStorage.getItem(`last_stock_backup_date_${user.uid}`);
        
        if (lastBackupDate === todayStr) {
          return; // Already backed up today
        }

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
        } else {
          console.warn("[BACKUP] Server daily backup failed.");
        }

        // Save last backup date to prevent duplicate runs today
        localStorage.setItem(`last_stock_backup_date_${user.uid}`, todayStr);
      } catch (backupErr) {
        console.error("[BACKUP] Error running daily backup:", backupErr);
      }
    };

    runDailyBackup();
  }, [user, stock, loadingData]);

  // Trigger automatic download of stock backup file at 18:00
  useEffect(() => {
    if (!user || loadingData || stock.length === 0) return;
    if (user.role !== "admin" && user.role !== "alimentador") return;

    const checkAndDownloadBackup = () => {
      try {
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
              items: stock
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
  }, [user, stock, loadingData]);

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
      return;
    }

    const transfersRef = collection(db, "transfers");
    const isGlobalViewer = user.role === "admin" || user.role === "vendedor" || !user.companyId;

    const sourceQuery = isGlobalViewer
      ? transfersRef
      : query(transfersRef, where("sourceCompanyId", "==", user.companyId));

    const unsubSource = onSnapshot(sourceQuery, (snapshot) => {
      const list: TransferOrder[] = [];
      snapshot.forEach(docSnap => list.push(mapTransferDoc(docSnap)));
      setTransfersAsSource(list);
    }, (error) => {
      console.error("Error fetching source transfers:", error);
    });

    let unsubDestination = () => {};
    if (!isGlobalViewer) {
      const destinationQuery = query(transfersRef, where("destinationCompanyId", "==", user.companyId));
      unsubDestination = onSnapshot(destinationQuery, (snapshot) => {
        const list: TransferOrder[] = [];
        snapshot.forEach(docSnap => list.push(mapTransferDoc(docSnap)));
        setTransfersAsDestination(list);
      }, (error) => {
        console.error("Error fetching destination transfers:", error);
      });
    } else {
      setTransfersAsDestination([]);
    }

    return () => {
      unsubSource();
      unsubDestination();
    };
  }, [user]);

  // Merge + dedupe the two transfer listeners into a single sorted list.
  // (For a global viewer, transfersAsDestination is always empty, so this is a no-op merge.)
  const transfers = useMemo(() => {
    const map = new Map<string, TransferOrder>();
    transfersAsSource.forEach(t => map.set(t.id, t));
    transfersAsDestination.forEach(t => map.set(t.id, t));
    return Array.from(map.values()).sort((a, b) => {
      const timeA = toMillis(a.updatedAt) || toMillis(a.requestedAt);
      const timeB = toMillis(b.updatedAt) || toMillis(b.requestedAt);
      return timeB - timeA;
    });
  }, [transfersAsSource, transfersAsDestination]);

  // Heartbeat: promote scheduled transfers (AGENDADO) to actionable (PENDENTE) once their
  // scheduled date/time has passed. Runs on mount and every 30s while the app is open —
  // the same "check on load / while open" pattern already used for the daily backup
  // automations below, since there is no server-side cron in this project.
  useEffect(() => {
    if (!user) return;

    const promoteDueScheduledTransfers = async () => {
      const now = Date.now();
      const due = transfers.filter(t => t.status === "AGENDADO" && t.scheduledFor && toMillis(t.scheduledFor) <= now);

      for (const t of due) {
        try {
          await updateDoc(doc(db, "transfers", t.id), {
            status: "PENDENTE",
            updatedAt: serverTimestamp()
          });
          console.log(`[TRANSFERENCIAS] Pedido ${t.id} liberado para assinatura (data agendada atingida).`);
        } catch (err) {
          console.error(`[TRANSFERENCIAS] Falha ao liberar pedido agendado ${t.id}:`, err);
        }
      }
    };

    promoteDueScheduledTransfers();
    const interval = setInterval(promoteDueScheduledTransfers, 30000);
    return () => clearInterval(interval);
  }, [user, transfers]);

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
      console.error("Erro ao atualizar item:", err);
      throw new Error("Erro ao gravar alterações.");
    }
  };

  // Remove pneu & audit exit
  const handleDeleteItem = async (itemId: string) => {
    if (!user) return;

    try {
      const itemToDrop = stock.find(item => item.id === itemId);
      if (!itemToDrop) return;

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
    } catch (err) {
      console.error("Erro ao excluir item:", err);
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

  // Clear all stock items belonging to the company or all stock if admin
  const handleClearCompanyStock = async () => {
    if (!user) return;
    if (user.role !== "admin" && user.role !== "alimentador") {
      throw new Error("Apenas administradores ou donos de empresa podem apagar o estoque.");
    }

    const itemsToClear = user.role === "admin"
      ? stock
      : stock.filter(item => item.companyId === user.companyId);

    if (itemsToClear.length === 0) {
      throw new Error("Nenhum item localizado no estoque para apagar.");
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
          reason: `Exclusao em lote do estoque por ${user.displayName}`
        });
      });
      await batch.commit();
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
  // Inter-company Transfer Orders: create, cancel, sign delivery/receipt, admin reversal
  // ─────────────────────────────────────────────────────────────────

  // Create a new transfer request (immediate or scheduled for later). Nothing is
  // moved in stock yet — that only happens once both signatures are collected.
  const handleCreateTransfer = async (data: {
    items: { sourceStockItemId: string; sku: string; brand: string; model: string; size: string; quantity: number; }[];
    sourceCompanyId: string;
    sourceCompanyName: string;
    destinationCompanyId: string;
    destinationCompanyName: string;
    reason: string;
    scheduledFor: Date | null;
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
    if (!data.destinationCompanyId || data.sourceCompanyId === data.destinationCompanyId) {
      throw new Error("Selecione uma empresa de destino diferente da empresa de origem.");
    }

    const isScheduled = !!data.scheduledFor && data.scheduledFor.getTime() > Date.now();

    try {
      await addDoc(collection(db, "transfers"), {
        items: data.items,
        sourceCompanyId: data.sourceCompanyId,
        sourceCompanyName: data.sourceCompanyName,
        destinationCompanyId: data.destinationCompanyId,
        destinationCompanyName: data.destinationCompanyName,
        reason: data.reason?.trim() || "",
        status: isScheduled ? "AGENDADO" : "PENDENTE",
        scheduledFor: isScheduled ? data.scheduledFor : null,
        requestedByUid: user.uid,
        requestedByEmail: user.email,
        requestedByName: user.displayName,
        requestedAt: serverTimestamp(),
        delivery: null,
        receipt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Erro ao criar pedido de transferência:", err);
      throw new Error("Erro ao salvar o pedido de transferência no banco de dados.");
    }
  };

  // Cancel a transfer that hasn't been dispatched yet (nothing physically moved,
  // so this is a plain status update — no stock/movements writes needed).
  const handleCancelTransfer = async (transferId: string, reason: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, "transfers", transferId), {
        status: "CANCELADO",
        cancelledByUid: user.uid,
        cancelledByName: user.displayName,
        cancelledAt: serverTimestamp(),
        cancelReason: reason?.trim() || "Cancelado pelo solicitante",
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Erro ao cancelar transferência:", err);
      throw new Error("Erro ao cancelar o pedido de transferência.");
    }
  };

  // Hard-delete a transfer record (e.g. cleaning up test data). Admin-only,
  // mirrored by the Firestore rule on the transfers collection.
  const handleDeleteTransfer = async (transferId: string) => {
    if (!user || user.role !== "admin") return;
    try {
      await deleteDoc(doc(db, "transfers", transferId));
    } catch (err) {
      console.error("Erro ao excluir transferência:", err);
      throw new Error("Erro ao excluir o pedido de transferência.");
    }
  };

  // Sign the delivery (source company confirms the goods are leaving). This is where
  // stock actually leaves the source company — decremented atomically inside a
  // transaction so a stale/insufficient balance or a duplicate signature attempt
  // fails cleanly instead of double-counting or driving stock negative.
  const handleSignDelivery = async (transferId: string, signatureDataUrl: string, driverPickupSignatureDataUrl: string, driverName: string) => {
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

        const items = transferData.items || [];
        if (items.length === 0) {
          throw new Error("Pedido não contém itens.");
        }

        // --- ALL READS ---
        const stockDataToUpdate = [];
        for (const item of items) {
          const sourceStockRef = doc(db, "stock", item.sourceStockItemId);
          const sourceStockSnap = await transaction.get(sourceStockRef);
          
          if (!sourceStockSnap.exists()) {
            throw new Error(`O item de estoque ${item.sku} não foi encontrado (pode ter sido excluído).`);
          }
          const currentQty = sourceStockSnap.data().quantity ?? 0;

          if (currentQty < item.quantity) {
            throw new Error(`Estoque insuficiente para ${item.sku}. Saldo atual: ${currentQty} un, necessário: ${item.quantity} un.`);
          }

          stockDataToUpdate.push({
            ref: sourceStockRef,
            newQty: currentQty - item.quantity,
            item: item
          });
        }

        // --- ALL WRITES ---
        for (const updateData of stockDataToUpdate) {
          transaction.update(updateData.ref, {
            quantity: updateData.newQty,
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

        transaction.update(transferRef, {
          status: "EM_TRANSITO",
          dispatch: {
            sender: {
              signedByUid: user.uid,
              signedByEmail: user.email,
              signedByName: user.displayName,
              signedAt: serverTimestamp(),
              signatureDataUrl: signatureDataUrl
            },
            driver: {
              signedByUid: "MOTORISTA",
              signedByEmail: "",
              signedByName: driverName.trim(),
              signedAt: serverTimestamp(),
              signatureDataUrl: driverPickupSignatureDataUrl
            }
          },
          delivery: {
            signedByUid: user.uid,
            signedByEmail: user.email,
            signedByName: user.displayName,
            signedAt: serverTimestamp(),
            signatureDataUrl: signatureDataUrl
          },
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao assinar envio:", err);
      throw new Error(err.message || "Erro ao registrar a assinatura de envio.");
    }
  };

  const handleSignReceipt = async (transferId: string, signatureDataUrl: string, driverDropoffSignatureDataUrl: string, driverName: string) => {
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

        // --- ALL READS ---
        const stockDataToUpdate = [];
        for (const item of latestTData.items) {
          let destStockRef = destDocsMap.get(item.sku);
          let newQty = item.quantity;
          let isNewStockDoc = false;

          if (destStockRef) {
            const freshDestSnap = await transaction.get(destStockRef);
            const freshData: any = freshDestSnap.data() || {};
            newQty = (freshData.quantity ?? 0) + item.quantity;
          } else {
            destStockRef = doc(collection(db, "stock"));
            isNewStockDoc = true;
          }
          
          stockDataToUpdate.push({
            ref: destStockRef,
            newQty,
            isNewStockDoc,
            item
          });
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

          const movementRef = doc(collection(db, "movements"));
          transaction.set(movementRef, {
            sku: updateData.item.sku,
            brand: updateData.item.brand,
            model: updateData.item.model,
            size: updateData.item.size,
            type: "TRANSFERENCIA_ENTRADA",
            quantity: updateData.item.quantity,
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

        transaction.update(transferRef, {
          status: "CONCLUIDO",
          arrival: {
            driver: {
              signedByUid: "MOTORISTA",
              signedByEmail: "",
              signedByName: driverName.trim(),
              signedAt: serverTimestamp(),
              signatureDataUrl: driverDropoffSignatureDataUrl
            },
            receiver: {
              signedByUid: user.uid,
              signedByEmail: user.email,
              signedByName: user.displayName,
              signedAt: serverTimestamp(),
              signatureDataUrl: signatureDataUrl
            }
          },
          receipt: {
            signedByUid: user.uid,
            signedByEmail: user.email,
            signedByName: user.displayName,
            signedAt: serverTimestamp(),
            signatureDataUrl
          },
          updatedAt: serverTimestamp()
        });
      });
    } catch (err: any) {
      console.error("Erro ao assinar recebimento:", err);
      throw new Error(err.message || "Erro ao registrar a assinatura de recebimento.");
    }
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

        const sourceStockRef = doc(db, "stock", transferData.sourceStockItemId);
        const sourceStockSnap = await transaction.get(sourceStockRef);
        const currentQty = sourceStockSnap.exists() ? (sourceStockSnap.data().quantity ?? 0) : 0;
        const restoredQty = currentQty + transferData.quantity;

        if (sourceStockSnap.exists()) {
          transaction.update(sourceStockRef, {
            quantity: restoredQty,
            updatedAt: serverTimestamp()
          });
        }

        const movementRef = doc(collection(db, "movements"));
        transaction.set(movementRef, {
          sku: transferData.sku,
          brand: transferData.brand,
          model: transferData.model,
          size: transferData.size,
          type: "AJUSTE",
          quantity: transferData.quantity,
          balanceAfter: restoredQty,
          companyId: transferData.sourceCompanyId,
          companyName: transferData.sourceCompanyName,
          userId: user.uid,
          userEmail: user.email,
          timestamp: serverTimestamp(),
          reason: `Estorno de transferência abandonada em trânsito para ${transferData.destinationCompanyName}`,
          transferId
        });

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

  // Calculate overview metrics for top panel header
  const totalStockItemsCount = stock.length;
  const totalPneumaticsSum = stock.reduce((acc, item) => acc + item.quantity, 0);
  const lowStockItems = stock.filter(item => item.quantity <= 4).length;

  return (
    <div className="min-h-screen bg-slate-50/70 flex flex-col md:flex-row font-sans transition-colors text-slate-800">
      
      {/* ====== DESKTOP SIDEBAR: Visible only on medium screens and up ====== */}
      <aside className="hidden md:flex md:w-64 bg-[#0b0f19] text-white flex-col justify-between border-r border-gold-500/10 sticky top-0 h-screen z-40 shrink-0">
        
        {/* Top Section: Brand Logo & Vertical Nav */}
        <div className="flex flex-col p-5 space-y-7">
          
          {/* Logo Area */}
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] flex items-center justify-center shadow-lg shadow-gold-500/20 font-black hover:scale-105 active:scale-95 transition-all duration-300 border border-gold-300/30">
              <Warehouse className="h-5 w-5 stroke-[2.2]" />
            </div>
            <div>
              <h1 className="text-sm font-black text-white tracking-tight leading-none uppercase flex items-center gap-1">
                Central Stoque <span className="text-[9px] text-gold-400 font-black tracking-normal lowercase italic bg-gold-500/10 px-1.5 py-0.5 rounded-md border border-gold-500/20">v2.0</span>
              </h1>
            </div>
          </div>

          {/* Navigation Links Column */}
          <nav className="flex flex-col gap-1.5">
            {(user.role === "vendedor" || user.role === "admin") && (
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
            )}

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

            {user.role === "admin" && (
              <button
                type="button"
                onClick={() => setActiveTab("users-admin")}
                className={`w-full px-3.5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-2.5 border ${
                  activeTab === "users-admin" 
                    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black" 
                    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white"
                }`}
              >
                <Users size={14} className="stroke-[2px]" /> Operadores e Senhas
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
        
        <button
          type="button"
          onClick={handleLogout}
          className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-900 transition-all"
          title="Sair do sistema"
        >
          <LogOut size={16} />
        </button>
      </header>

      {/* Mobile navigation bottom bar */}
      <div className="md:hidden bg-[#0b0f19] border-t border-gold-500/20 fixed bottom-0 inset-x-0 h-16 z-40 flex items-stretch divide-x divide-slate-800 shadow-[0_-4px_25px_rgba(0,0,0,0.2)] overflow-x-auto">
        {(user.role === "vendedor" || user.role === "admin") && (
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
        )}

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
        {user.role === "admin" && (
          <button
            type="button"
            onClick={() => setActiveTab("users-admin")}
            className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all ${
              activeTab === "users-admin" ? "text-gold-400 bg-slate-950 font-black shadow-inner" : "text-slate-400 hover:bg-[#0b0f19]"
            }`}
          >
            <Users size={18} />
            <span className="text-[9px] font-extrabold uppercase tracking-wide">Operadores</span>
          </button>
        )}
      </div>

      {/* Right Side Content Panel */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 mb-20 md:mb-6 flex-1 space-y-6">
        
        {/* Sub-Header KPI Dashlet Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 font-sans">
          
          {/* Card 1: Total SKUs */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
            <div className="space-y-1">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Modelos Cadastrados</span>
              <p className="text-2xl font-black text-slate-900 tracking-tight">{totalStockItemsCount}</p>
            </div>
            <div className="h-11 w-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-inner">
              <PackageCheck size={20} className="stroke-[1.8]" />
            </div>
          </div>

          {/* Card 2: Total Sum of physical pneumatics units */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgba(0,0,0,0.015)] flex items-center justify-between hover:scale-[1.01] transition-transform duration-250">
            <div className="space-y-1">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Volume de Pneus</span>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {totalPneumaticsSum} <span className="text-xs font-bold text-slate-500 font-sans uppercase">unid.</span>
              </p>
            </div>
            <div className="h-11 w-11 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center border border-sky-100 shadow-inner">
              <TrendingUp size={20} className="stroke-[1.8]" />
            </div>
          </div>

          {/* Card 3: Alert items */}
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

        </div>

        {/* Dynamic Tab Panel switches */}
        <div className="transition-all duration-200">
        <Suspense fallback={
          <div className="flex items-center justify-center py-20 text-slate-400">
            <div className="h-5 w-5 border-2 border-gold-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        }>
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
                items={stock}
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

          {activeTab === "transfers" && (
            <TransferOrders
              transfers={transfers}
              stock={stock}
              companies={companies}
              user={user}
              onCreateTransfer={handleCreateTransfer}
              onCancelTransfer={handleCancelTransfer}
              onSignDelivery={handleSignDelivery}
              onSignReceipt={handleSignReceipt}
              onReverseTransfer={handleReverseInTransitTransfer}
              onDeleteTransfer={handleDeleteTransfer}
            />
          )}

          {activeTab === "users-admin" && user.role === "admin" && (
            <UsersAdmin />
          )}

          {activeTab === "how-to-use" && (
            <HowToUse />
          )}

          {activeTab === "apk-installer" && (
            <ApkInstaller />
          )}
        </Suspense>
        </div>

        </main>
      </div>

      {/* CHANGE PASSWORD MODAL */}
      {showChangePasswordModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4">
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
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4">
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
