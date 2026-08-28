import React, { useState, useMemo } from "react";
import { StockItem, Company, UserRole } from "../types";
import { availableQuantity, formatBRL, matchesTireSize, parsePriceInput, reservedQuantityOf } from "../utils";
import sajEstoqueData from "../saj_estoque.json";
import autocarEstoqueData from "../autocar_estoque.json";
import valencaEstoqueData from "../valenca_estoque.json";
import centralAutocenterEstoqueData from "../central_autocenter_estoque.json";
import { 
  Search, 
  Trash2, 
  Edit, 
  Plus, 
  X, 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  Filter, 
  ShoppingBag, 
  Archive,
  RefreshCw,
  AlertTriangle,
  FileSpreadsheet,
  Loader2,
  Camera,
  Check,
  Lock
} from "lucide-react";

interface StockTableProps {
  items: StockItem[];
  isAdmin: boolean;
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  companies: Company[];
  onUpdateItem: (itemId: string, updatedFields: Partial<StockItem>, movementReason: string, quantityDiff?: number, extraMovementFields?: Record<string, any>) => Promise<void>;
  onDeleteItem: (itemId: string) => Promise<void>;
  onAddItem: (itemData: Omit<StockItem, "id" | "userId" | "userEmail" | "createdAt" | "updatedAt">) => Promise<void>;
  // Omitting companyId wipes every company's stock — only used for the explicit
  // "todas as empresas" choice in the clear-stock modal below, never as a default.
  onClearStock?: (companyId?: string) => Promise<void>;
  onRestoreBackup?: (backupItems: any[]) => Promise<void>;
}

// Sentinel value for the "wipe every company" option in the clear-stock modal —
// distinct from "" (which means "no company picked yet") so admins must make an
// explicit, deliberate choice instead of an empty selection defaulting to "all".
const CLEAR_ALL_COMPANIES = "__ALL_COMPANIES__";

export default function StockTable({ 
  items, 
  isAdmin, 
  user, 
  companies, 
  onUpdateItem, 
  onDeleteItem, 
  onAddItem,
  onClearStock,
  onRestoreBackup
}: StockTableProps) {
  // Filtering & Search
  const [searchTerm, setSearchTerm] = useState("");
  const [searchId, setSearchId] = useState(""); // Dedicated magnifying glass ID search
  const [selectedBrand, setSelectedBrand] = useState("");
  const [selectedSize, setSelectedSize] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "normal">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(15);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [formCompanyId, setFormCompanyId] = useState("");

  // Modals & Sliders
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingItem, setEditingItem] = useState<StockItem | null>(null);
  
  // Checkout Modal (Saída de Estoque)
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutSearch, setCheckoutSearch] = useState("");
  const [checkoutSelectedItemId, setCheckoutSelectedItemId] = useState("");
  const [checkoutQuantityStr, setCheckoutQuantityStr] = useState<string>("");
  const [checkoutItems, setCheckoutItems] = useState<{
    id: string;
    quantity: number;
    priceUnit: number;
    itemRef: StockItem;
  }[]>([]);
  const [checkoutReason, setCheckoutReason] = useState("Venda");

  // Form Fields (Add/Edit)
  const [formSku, setFormSku] = useState("");
  const [formBrand, setFormBrand] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formSize, setFormSize] = useState("");
  const [formQuantity, setFormQuantity] = useState(0);
  // Texto, não número: o campo precisa aceitar a vírgula dos centavos enquanto
  // a pessoa digita. Guardar `number` obrigava `type="number"`, que descarta a
  // vírgula e devolve string vazia — e o `parseFloat(...) || 0` que havia aqui
  // mandava ZERO para o banco. Ver parsePriceInput em utils.
  const [formPriceCash, setFormPriceCash] = useState("");
  const [formPriceInstallment, setFormPriceInstallment] = useState("");

  // Confirmação do que FOI GRAVADO, mostrada fora do modal (que fecha no
  // sucesso). Sem ela, "salvou" e "não salvou" são visualmente idênticos: o
  // modal some nos dois casos e resta olhar a linha da tabela e confiar.
  const [savedMsg, setSavedMsg] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formImageUrl, setFormImageUrl] = useState("");
  const [movementReason, setMovementReason] = useState("");
  
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Batch Clear & Restore States
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [clearTargetCompanyId, setClearTargetCompanyId] = useState(""); // which company's stock to wipe (admin picks; alimentador is always their own)
  const [showBackupRestoreModal, setShowBackupRestoreModal] = useState(false);

  // Barcode Scanner Modal states
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const [html5QrCodeInstance, setHtml5QrCodeInstance] = useState<any>(null);

  // Checkout client info & Receipt states
  const [checkoutClientName, setCheckoutClientName] = useState("");
  const [checkoutClientDoc, setCheckoutClientDoc] = useState("");
  const [checkoutClientVehicle, setCheckoutClientVehicle] = useState("");
  const [lastSaleReceipt, setLastSaleReceipt] = useState<any | null>(null);

  const [isInjecting, setIsInjecting] = useState(false);

  const handleInjectSajEstoque = async () => {
    if (!window.confirm("ATENÇÃO: Deseja injetar todo o estoque da SAJ Pneus no banco de dados agora? Isso pode demorar alguns segundos.")) return;
    setIsInjecting(true);
    let successCount = 0;
    try {
      // Find SAJ company ID
      const sajCompany = companies.find(c => c.name.toUpperCase().includes("SAJ PNEUS") || c.name.toUpperCase().includes("SAJ"));
      const cid = sajCompany ? sajCompany.id : (user.companyId || "");
      const cname = sajCompany ? sajCompany.name : (user.companyName || "");
      
      for (const item of sajEstoqueData) {
        await onAddItem({
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          priceCash: item.priceCash,
          priceInstallment: item.priceInstallment,
          notes: item.notes,
          description: item.description,
          imageUrl: "",
          companyId: cid,
          companyName: cname
        });
        successCount++;
      }
      alert(`Sucesso! ${successCount} itens foram injetados com perfeição.`);
    } catch (err: any) {
      alert("Erro ao injetar: " + err.message);
    } finally {
      setIsInjecting(false);
    }
  };

  const handleInjectAutocarEstoque = async () => {
    if (!window.confirm("ATENÇÃO: Deseja injetar todo o estoque da Autocar no banco de dados agora? Isso pode demorar alguns segundos.")) return;
    setIsInjecting(true);
    let successCount = 0;
    try {
      const autocarCompany = companies.find(c => c.name.toUpperCase().includes("AUTOCAR"));
      const cid = autocarCompany ? autocarCompany.id : (user.companyId || "");
      const cname = autocarCompany ? autocarCompany.name : (user.companyName || "");
      
      for (const item of autocarEstoqueData) {
        await onAddItem({
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          priceCash: item.priceCash,
          priceInstallment: item.priceInstallment,
          notes: item.notes,
          description: item.description,
          imageUrl: "",
          companyId: cid,
          companyName: cname
        });
        successCount++;
      }
      alert(`Sucesso! ${successCount} itens foram injetados com perfeição.`);
    } catch (err: any) {
      alert("Erro ao injetar: " + err.message);
    } finally {
      setIsInjecting(false);
    }
  };

  const handleInjectValencaEstoque = async () => {
    if (!window.confirm("ATENÇÃO: Deseja injetar todo o estoque da Valença no banco de dados agora? Isso pode demorar alguns segundos.")) return;
    setIsInjecting(true);
    let successCount = 0;
    try {
      const valencaCompany = companies.find(c => c.name.toUpperCase().includes("VALENÇA") || c.name.toUpperCase().includes("VALENCA"));
      const cid = valencaCompany ? valencaCompany.id : (user.companyId || "");
      const cname = valencaCompany ? valencaCompany.name : (user.companyName || "");
      
      for (const item of valencaEstoqueData) {
        await onAddItem({
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          priceCash: item.priceCash,
          priceInstallment: item.priceInstallment,
          notes: item.notes,
          description: item.description,
          imageUrl: "",
          companyId: cid,
          companyName: cname
        });
        successCount++;
      }
      alert(`Sucesso! ${successCount} itens foram injetados com perfeição.`);
    } catch (err: any) {
      alert("Erro ao injetar: " + err.message);
    } finally {
      setIsInjecting(false);
    }
  };

  const handleInjectCentralAutocenterEstoque = async () => {
    if (!window.confirm("ATENÇÃO: Deseja injetar todo o estoque da Central Autocenter no banco de dados agora? Isso pode demorar alguns segundos.")) return;
    setIsInjecting(true);
    let successCount = 0;
    try {
      const centralAutocenterCompany = companies.find(c => c.name.toUpperCase().includes("CENTRAL AUTOCENTER") || c.name.toUpperCase().includes("AUTOCENTER"));
      const cid = centralAutocenterCompany ? centralAutocenterCompany.id : (user.companyId || "");
      const cname = centralAutocenterCompany ? centralAutocenterCompany.name : (user.companyName || "");

      for (const item of centralAutocenterEstoqueData) {
        await onAddItem({
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          priceCash: item.priceCash,
          priceInstallment: item.priceInstallment,
          notes: item.notes,
          description: item.description,
          imageUrl: "",
          companyId: cid,
          companyName: cname
        });
        successCount++;
      }
      alert(`Sucesso! ${successCount} itens foram injetados com perfeição.`);
    } catch (err: any) {
      alert("Erro ao injetar: " + err.message);
    } finally {
      setIsInjecting(false);
    }
  };

  // Helper to open print window for thermal receipt
  const handlePrintReceipt = (receipt: any) => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    
    printWindow.document.write(`
      <html>
        <head>
          <title>Recibo - Central Estoque</title>
          <style>
            @media print {
              body { margin: 0; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.4; color: #000; }
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
            @media print {
              .btn-print { display: none; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="company">\${receipt.companyName.toUpperCase()}</div>
            <div class="title">Comprovante de Saída</div>
            <div>Data: \${receipt.date}</div>
            <div>Op: \${receipt.userName}</div>
          </div>
          
          <div style="margin-bottom: 10px;"><strong>ITENS:</strong></div>
          \${receipt.items?.map((item: any) => \`
            <div style="margin-bottom: 8px;">
              [\${item.sku}] \${item.brand} \${item.model} (Medida: \${item.size})<br/>
              <div class="item-row" style="margin-top: 2px;">
                <span>\${item.quantity} un x R$ \${item.priceUnit.toFixed(2).replace(".", ",")}</span>
                <span>R$ \${item.total.toFixed(2).replace(".", ",")}</span>
              </div>
            </div>
          \`).join('')}
          <div class="divider"></div>
          <div class="total-row">
            <span>TOTAL GERAL:</span>
            <span>R$ \${receipt.totalAmount?.toFixed(2).replace(".", ",")}</span>
          </div>
          
          <div class="divider"></div>
          
          <div>
            <strong>CLIENTE:</strong><br/>
            Nome: \${receipt.clientName || "Não informado"}<br/>
            CPF/CNPJ: \${receipt.clientDoc || "Não informado"}<br/>
            Placa: \${receipt.clientVehicle || "Não informado"}
          </div>
          
          <div class="footer">
            Obrigado pela preferência!<br/>
            Central Estoque - Auditoria Garantida
          </div>
          
          <button class="btn-print" onclick="window.print()">Imprimir Recibo</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // Helper to load html5-qrcode dynamically from CDN
  const loadHtml5Qrcode = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      if ((window as any).Html5Qrcode) {
        resolve((window as any).Html5Qrcode);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      script.onload = () => {
        resolve((window as any).Html5Qrcode);
      };
      script.onerror = (e) => reject(new Error("Falha ao carregar o scanner de câmera. Verifique sua conexão."));
      document.body.appendChild(script);
    });
  };

  const handleOpenScanner = async () => {
    setShowScannerModal(true);
    setScannerLoading(true);
    setScannerError("");
    try {
      const Html5Qrcode = await loadHtml5Qrcode();
      setTimeout(() => {
        try {
          const qrCode = new Html5Qrcode("scanner-reader");
          setHtml5QrCodeInstance(qrCode);
          
          qrCode.start(
            { facingMode: "environment" },
            {
              fps: 10,
              qrbox: (width: number, height: number) => {
                const size = Math.min(width, height) * 0.7;
                return { width: size, height: size };
              }
            },
            (decodedText: string) => {
              setSearchId(decodedText.trim().toUpperCase());
              try {
                const context = new (window.AudioContext || (window as any).webkitAudioContext)();
                const osc = context.createOscillator();
                const gain = context.createGain();
                osc.type = "sine";
                osc.frequency.setValueAtTime(1000, context.currentTime);
                gain.gain.setValueAtTime(0.1, context.currentTime);
                osc.connect(gain);
                gain.connect(context.destination);
                osc.start();
                osc.stop(context.currentTime + 0.15);
              } catch (soundErr) {}
              
              qrCode.stop().then(() => {
                setShowScannerModal(false);
                setHtml5QrCodeInstance(null);
              }).catch(() => {
                setShowScannerModal(false);
                setHtml5QrCodeInstance(null);
              });
            },
            () => {}
          ).then(() => {
            setScannerLoading(false);
          }).catch((err: any) => {
            console.error("Camera error:", err);
            setScannerError("Permissão de câmera negada ou nenhuma câmera disponível.");
            setScannerLoading(false);
          });
        } catch (initErr: any) {
          setScannerError("Erro ao inicializar câmera: " + initErr.message);
          setScannerLoading(false);
        }
      }, 300);
    } catch (err: any) {
      setScannerError(err.message || "Erro de conexão.");
      setScannerLoading(false);
    }
  };

  const handleCloseScanner = async () => {
    if (html5QrCodeInstance) {
      try {
        await html5QrCodeInstance.stop();
      } catch (e) {}
    }
    setHtml5QrCodeInstance(null);
    setShowScannerModal(false);
  };

  // Unique Brands in existing stock for filters
  const availableBrands = useMemo(() => {
    const list = items.map(item => item.brand.trim());
    return Array.from(new Set(list)).filter(b => b.length > 0).sort();
  }, [items]);

  // Unique Sizes in existing stock for filters
  const availableSizes = useMemo(() => {
    const list = items.map(item => item.size.trim());
    return Array.from(new Set(list)).filter(s => s.length > 0).sort();
  }, [items]);

  // Combined Filtering
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      // 1. Text Search (Brand, Model, Size, Description)
      const matchesSearchText = searchTerm === "" || 
        item.brand.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
        matchesTireSize(item.size, searchTerm) ||
        (item.description && item.description.toLowerCase().includes(searchTerm.toLowerCase())) ||
        item.userEmail.toLowerCase().includes(searchTerm.toLowerCase());

      // 2. ID / SKU Search (Magnifier Dedicated Search)
      const matchesIdSearch = searchId === "" || 
        item.sku.toLowerCase().includes(searchId.toLowerCase()) ||
        item.id.toLowerCase().includes(searchId.toLowerCase());

      // 3. Brand Filter
      const matchesBrand = selectedBrand === "" || item.brand === selectedBrand;

      // 4. Size Filter
      const matchesSize = selectedSize === "" || item.size === selectedSize;

      // 5. Stock alert warnings (Low <= 4 units)
      const matchesStock = stockFilter === "all" ||
        (stockFilter === "low" && item.quantity <= 4) ||
        (stockFilter === "normal" && item.quantity > 4);

      // 6. Company Filter
      const matchesCompany = selectedCompanyId === "" || item.companyId === selectedCompanyId;

      return matchesSearchText && matchesIdSearch && matchesBrand && matchesSize && matchesStock && matchesCompany;
    });
  }, [items, searchTerm, searchId, selectedBrand, selectedSize, stockFilter, selectedCompanyId]);

  // Reset pagination to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, searchId, selectedBrand, selectedSize, stockFilter, selectedCompanyId]);

  // Stats calculation
  const totalValue = useMemo(() => {
    return filteredItems.reduce((acc, item) => acc + (item.quantity * (item.priceCash || item.price || 0)), 0);
  }, [filteredItems]);

  const totalQuantity = useMemo(() => {
    return filteredItems.reduce((acc, item) => acc + item.quantity, 0);
  }, [filteredItems]);

  const lowStockCount = useMemo(() => {
    return filteredItems.filter(item => item.quantity <= 4).length;
  }, [filteredItems]);

  // Paginated Items
  const paginatedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredItems.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredItems, currentPage, itemsPerPage]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredItems.length / itemsPerPage));
  }, [filteredItems, itemsPerPage]);

  // Export to CSV Function
  const exportToCSV = () => {
    if (filteredItems.length === 0) return;

    const headers = ["SKU", "Marca", "Modelo", "Medida", "Quantidade", "Preco a Vista", "Preco a Prazo", "Empresa", "Anotacoes", "Descricao"];
    const rows = filteredItems.map(item => [
      item.sku,
      item.brand,
      item.model,
      item.size,
      item.quantity,
      item.priceCash || item.price || 0,
      item.priceInstallment || item.price || 0,
      item.companyName || "N/A",
      item.notes || "",
      item.description || ""
    ]);

    const csvContent = [
      headers.join(";"),
      ...rows.map(row => row.map(val => {
        const strVal = String(val).replace(/"/g, '""');
        return `"${strVal}"`;
      }).join(";"))
    ].join("\n");

    const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `estoque_filtrado_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Open Edit Modals
  const handleOpenEdit = (item: StockItem) => {
    setSavedMsg("");
    setEditingItem(item);
    setFormSku(item.sku);
    setFormBrand(item.brand);
    setFormModel(item.model);
    setFormSize(item.size);
    setFormQuantity(item.quantity);
    setFormPriceCash(String(item.priceCash || item.price || 0).replace(".", ","));
    setFormPriceInstallment(String(item.priceInstallment || item.price || 0).replace(".", ","));
    setFormNotes(item.notes);
    setFormDescription(item.description || "");
    setFormImageUrl(item.imageUrl || "");
    setFormCompanyId(item.companyId || "");
    setMovementReason("Geral / Ajuste de cadastro");
    setShowEditModal(true);
    setErrorMsg("");
  };

  const handleOpenAdd = () => {
    // Generate automatic suggestive SKU
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    setFormSku(`PNEU-${randomSuffix}`);
    setFormBrand("");
    setFormModel("");
    setFormSize("");
    setFormQuantity(4);
    setFormPriceCash("399,00");
    setFormPriceInstallment("420,00");
    setFormNotes("");
    setFormDescription("");
    setFormImageUrl("");
    setFormCompanyId(user.companyId || "");
    setShowAddModal(true);
    setErrorMsg("");
  };

  const handleSaveAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSku || !formBrand || !formModel || !formSize) {
      setErrorMsg("Por favor, preencha todos os campos obrigatórios.");
      return;
    }

    let matchedCompId = formCompanyId || user.companyId || "";
    let matchedCompName = "";
    if (matchedCompId) {
      const match = companies.find(c => c.id === matchedCompId);
      if (match) matchedCompName = match.name;
    }

    const priceCash = parsePriceInput(formPriceCash);
    const priceInstallment = parsePriceInput(formPriceInstallment);
    if (priceCash === null || priceInstallment === null) {
      setErrorMsg("Confira os preços: use apenas números, com vírgula nos centavos (ex: 375,50).");
      return;
    }

    setSubmitting(true);
    setErrorMsg("");

    try {
      await onAddItem({
        sku: formSku,
        brand: formBrand,
        model: formModel,
        size: formSize,
        quantity: Number(formQuantity),
        price: priceCash,
        priceCash,
        priceInstallment,
        notes: formNotes,
        description: formDescription,
        imageUrl: formImageUrl,
        companyId: matchedCompId,
        companyName: matchedCompName
      });
      setShowAddModal(false);
    } catch (err: any) {
      setErrorMsg(err.message || "Erro ao adicionar produto.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    if (!formBrand || !formModel || !formSize) {
      setErrorMsg("Marcas, Modelos e Medidas são campos obrigatórios.");
      return;
    }

    let matchedCompId = formCompanyId || editingItem.companyId || user.companyId || "";
    let matchedCompName = "";
    if (matchedCompId) {
      const match = companies.find(c => c.id === matchedCompId);
      if (match) matchedCompName = match.name;
    }

    const priceCash = parsePriceInput(formPriceCash);
    const priceInstallment = parsePriceInput(formPriceInstallment);
    if (priceCash === null || priceInstallment === null) {
      setErrorMsg("Confira os preços: use apenas números, com vírgula nos centavos (ex: 375,50).");
      return;
    }

    setSubmitting(true);
    setErrorMsg("");

    try {
      const updatedFields: Partial<StockItem> = {
        sku: formSku,
        brand: formBrand,
        model: formModel,
        size: formSize,
        quantity: Number(formQuantity),
        price: priceCash,
        priceCash,
        priceInstallment,
        notes: formNotes,
        description: formDescription,
        imageUrl: formImageUrl,
        companyId: matchedCompId,
        companyName: matchedCompName
      };

      const quantityDiff = Number(formQuantity) - editingItem.quantity;
      await onUpdateItem(editingItem.id, updatedFields, movementReason || "Edição de cadastro", quantityDiff);
      setShowEditModal(false);
      setSavedMsg(
        `${formBrand} ${formModel} (${formSize}) gravado — à vista ${formatBRL(priceCash)}, ` +
        `a prazo ${formatBRL(priceInstallment)}, ${Number(formQuantity)} un.`
      );
    } catch (err: any) {
      setErrorMsg(err.message || "Erro ao atualizar dados.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenCheckout = (preselectedItem?: StockItem) => {
    setErrorMsg("");
    setCheckoutSearch("");
    setCheckoutSelectedItemId("");
    setCheckoutQuantityStr("");
    setCheckoutItems([]);
    setCheckoutReason("Venda");
    setCheckoutClientName("");
    setCheckoutClientDoc("");
    setCheckoutClientVehicle("");
    if (preselectedItem) {
      setCheckoutSelectedItemId(preselectedItem.id);
      setCheckoutQuantityStr("1");
    }
    setShowCheckoutModal(true);
  };

  const handleAddCheckoutItem = () => {
    if (!checkoutSelectedItemId) {
      setErrorMsg("Selecione um item para adicionar.");
      return;
    }
    const qty = parseInt(checkoutQuantityStr, 10);
    if (isNaN(qty) || qty <= 0) {
      setErrorMsg("Quantidade inválida.");
      return;
    }
    const item = items.find(i => i.id === checkoutSelectedItemId);
    if (!item) {
      setErrorMsg("Item não encontrado.");
      return;
    }
    const free = availableQuantity(item);
    const reserved = reservedQuantityOf(item);
    if (qty > free) {
      setErrorMsg(
        `Quantidade insuficiente em estoque. Disponível para baixa: ${free}` +
        (reserved > 0 ? ` (${reserved} un reservadas para clientes ou transferências).` : ".")
      );
      return;
    }
    if (checkoutItems.some(i => i.id === item.id)) {
      setErrorMsg("Este item já foi adicionado à lista.");
      return;
    }
    
    setCheckoutItems(prev => [...prev, {
      id: item.id,
      quantity: qty,
      priceUnit: item.priceCash || item.price || 0,
      itemRef: item
    }]);
    
    setCheckoutSelectedItemId("");
    setCheckoutQuantityStr("");
    setCheckoutSearch("");
    setErrorMsg("");
  };

  const handleRemoveCheckoutItem = (id: string) => {
    setCheckoutItems(prev => prev.filter(i => i.id !== id));
  };

  const handleSaveCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checkoutItems.length === 0) {
      setErrorMsg("Adicione pelo menos um item à lista.");
      return;
    }

    setSubmitting(true);
    setErrorMsg("");

    try {
      const reason = checkoutReason.trim() || "Saída / Baixa manual";
      let totalAmount = 0;
      const receiptItems = [];
      let companyName = user.companyName || "Central Estoque";

      for (const checkoutItem of checkoutItems) {
        const item = checkoutItem.itemRef;
        const newQty = item.quantity - checkoutItem.quantity;
        const unitPrice = checkoutItem.priceUnit;
        const itemTotal = unitPrice * checkoutItem.quantity;
        totalAmount += itemTotal;
        
        const extraFields: Record<string, any> = {};
        if (checkoutReason === "Venda") {
          extraFields.clientName = checkoutClientName.trim();
          extraFields.clientDoc = checkoutClientDoc.trim();
          extraFields.clientVehicle = checkoutClientVehicle.trim().toUpperCase();
          extraFields.priceUnit = unitPrice;
          extraFields.totalAmount = itemTotal;
        }

        await onUpdateItem(item.id, { quantity: newQty }, reason, -checkoutItem.quantity, extraFields);
        
        receiptItems.push({
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          quantity: checkoutItem.quantity,
          priceUnit: unitPrice,
          total: itemTotal,
        });

        if (item.companyName) {
          companyName = item.companyName;
        }
      }
      
      // Prepare receipt data
      const receiptData = {
        items: receiptItems,
        totalAmount,
        clientName: checkoutClientName.trim(),
        clientDoc: checkoutClientDoc.trim(),
        clientVehicle: checkoutClientVehicle.trim().toUpperCase(),
        companyName,
        userName: user.displayName,
        date: new Date().toLocaleDateString("pt-BR") + " " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      };
      
      setLastSaleReceipt(receiptData);
      setShowCheckoutModal(false);
      setCheckoutItems([]);
      setCheckoutReason("Venda");
    } catch (err: any) {
      setErrorMsg(err.message || "Erro ao dar baixa nos itens.");
    } finally {
      setSubmitting(false);
    }
  };
  const checkoutStockOptions = useMemo(() => {
    const lower = checkoutSearch.toLowerCase();
    return items
      // Pneu totalmente reservado para uma transferência não pode ser vendido.
      .filter(item => availableQuantity(item) > 0)
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
  }, [items, checkoutSearch]);

  const checkoutSelectedItemRef = items.find(i => i.id === checkoutSelectedItemId) || null;

  return (
    <div className="space-y-5 animate-fadeIn">
      {/* Indicadores Financeiros e Estatísticos em tempo real */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Card 1: Capital Estimado */}
        <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-[0_4px_15px_rgba(0,0,0,0.015)] flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Capital Estimado</span>
            <span className="text-xl font-black text-slate-900 mt-1 block">
              {formatBRL(totalValue)}
            </span>
            <span className="text-[9px] text-slate-500 font-bold block mt-1">Valor total de pneus/peças ativos</span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center shrink-0">
            <TrendingUp size={20} className="stroke-[2.2]" />
          </div>
        </div>

        {/* Card 2: Quantidade Total */}
        <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-[0_4px_15px_rgba(0,0,0,0.015)] flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Volume de Estoque</span>
            <span className="text-xl font-black text-slate-900 mt-1 block">
              {totalQuantity} <span className="text-xs font-bold text-slate-450 uppercase">unidades</span>
            </span>
            <span className="text-[9px] text-slate-500 font-bold block mt-1">Total de itens no filtro atual</span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-blue-50 text-blue-600 border border-blue-100 flex items-center justify-center shrink-0">
            <ShoppingBag size={18} className="stroke-[2.2]" />
          </div>
        </div>

        {/* Card 3: Alertas Críticos */}
        <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-[0_4px_15px_rgba(0,0,0,0.015)] flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Alertas de Reposição</span>
            <span className={`text-xl font-black mt-1 block ${lowStockCount > 0 ? "text-red-600" : "text-slate-900"}`}>
              {lowStockCount} <span className="text-xs font-bold uppercase">críticos</span>
            </span>
            <span className="text-[9px] text-slate-500 font-bold block mt-1">Itens com 4 ou menos unidades</span>
          </div>
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${lowStockCount > 0 ? "bg-red-50 text-red-600 border border-red-100 animate-pulse" : "bg-slate-50 text-slate-400 border border-slate-200"}`}>
            <AlertTriangle size={18} className="stroke-[2.2]" />
          </div>
        </div>
      </div>

      {/* Search and Filters Hub */}
      <div className="bg-white p-5 rounded-2xl border-t-4 border-t-gold-500 border-x border-b border-slate-200/85 shadow-[0_10px_25px_rgba(0,0,0,0.02)] space-y-4">
        
        {/* SEARCH ROW */}
        <div className="flex flex-col lg:flex-row gap-3.5 items-stretch justify-between">
          
          {/* Main search bar */}
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
              <Search size={16} className="stroke-[2.2px] text-gold-600" />
            </div>
            <input
              type="text"
              placeholder="Filtre por marca, modelo, medida (ex: 225/65R17) ou descrição..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2.5 w-full border border-slate-200 rounded-xl bg-slate-50/50 text-slate-900 font-semibold text-xs focus:bg-white focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 hover:border-slate-350 transition-all placeholder-slate-400 outline-none"
            />
          </div>

          {/* DEDICATED ID / SKU SEARCH (With a specific search layout - Magnifying glass focus) */}
          <div className="relative w-full lg:w-72 flex gap-1 bg-slate-50 p-1 rounded-xl border border-slate-200 items-center">
            <button
              type="button"
              onClick={handleOpenScanner}
              className="p-1.5 text-gold-700 bg-gold-400/10 hover:bg-gold-400/20 border border-gold-300/30 rounded-lg transition-colors flex items-center justify-center shrink-0 cursor-pointer"
              title="Escanear Código de Barras"
            >
              <Camera size={14} className="stroke-[2.2px]" />
            </button>
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-slate-400">
                <Search size={14} className="stroke-[2.5px] text-gold-600" />
              </div>
              <input
                type="text"
                placeholder="PROCURAR ID / SKU..."
                value={searchId}
                onChange={(e) => setSearchId(e.target.value)}
                className="pl-8 pr-3 py-1.5 w-full bg-white border border-slate-200/80 rounded-lg text-slate-800 font-mono text-[11px] font-bold outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-400 tracking-wider placeholder:text-slate-355 uppercase"
              />
            </div>
            {searchId && (
              <button 
                type="button"
                onClick={() => setSearchId("")} 
                className="px-2 py-1 text-[9px] uppercase font-black text-slate-500 hover:text-red-650 transition-colors cursor-pointer"
              >
                Limpar
              </button>
            )}
          </div>
        </div>

        {/* ACTION BUTTONS ROW */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Checkout product action trigger */}
          <button
            type="button"
            onClick={() => handleOpenCheckout()}
            className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-extrabold rounded-xl text-xs shadow-md border border-slate-700/30 transition-all cursor-pointer whitespace-nowrap shrink-0 hover:scale-[1.02] active:scale-[0.98]"
          >
            <TrendingDown size={15} className="stroke-[2.5px] text-red-400" /> Saída de Pneus
          </button>

          {/* Export to CSV Button */}
          <button
            type="button"
            onClick={exportToCSV}
            disabled={filteredItems.length === 0}
            className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <FileSpreadsheet size={15} className="text-emerald-600" /> Exportar CSV
          </button>

          {/* INJETAR ESTOQUE SAJ PNEUS */}
          {user.role === "admin" && (
            <button
              type="button"
              onClick={handleInjectSajEstoque}
              disabled={isInjecting}
              className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-700 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isInjecting ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />} Injetar Estoque SAJ
            </button>
          )}

          {/* INJETAR ESTOQUE AUTOCAR */}
          {user.role === "admin" && (
            <button
              type="button"
              onClick={handleInjectAutocarEstoque}
              disabled={isInjecting}
              className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-fuchsia-600 hover:bg-fuchsia-700 text-white border border-fuchsia-700 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isInjecting ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />} Injetar Estoque Autocar
            </button>
          )}

          {/* INJETAR ESTOQUE VALENÇA */}
          {user.role === "admin" && (
            <button
              type="button"
              onClick={handleInjectValencaEstoque}
              disabled={isInjecting}
              className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-cyan-600 hover:bg-cyan-700 text-white border border-cyan-700 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isInjecting ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />} Injetar Estoque Valença
            </button>
          )}

          {/* INJETAR ESTOQUE CENTRAL AUTOCENTER */}
          {user.role === "admin" && (
            <button
              type="button"
              onClick={handleInjectCentralAutocenterEstoque}
              disabled={isInjecting}
              className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white border border-orange-700 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isInjecting ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />} Injetar Estoque Central Autocenter
            </button>
          )}

          {/* Admin/Owner Actions: Clear & Restore Backups */}
          {(user.role === "admin" || user.role === "alimentador") && (
            <>
              {/* Clear Stock Button */}
              <button
                type="button"
                onClick={() => {
                  setClearConfirmText("");
                  // Default to whatever company the table is currently filtered to (if any) —
                  // never defaults to "all companies", that requires an explicit pick below.
                  setClearTargetCompanyId(isAdmin ? selectedCompanyId : (user.companyId || ""));
                  setShowClearConfirmModal(true);
                }}
                className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-red-50 hover:bg-red-100 text-red-650 border border-red-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer shrink-0"
              >
                <Trash2 size={15} className="stroke-[2.5px]" /> Apagar Estoque
              </button>

              {/* Restore Backup Button */}
              <button
                type="button"
                onClick={() => setShowBackupRestoreModal(true)}
                className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer shrink-0"
              >
                <Archive size={15} className="stroke-[2.5px]" /> Restaurar Backup
              </button>
            </>
          )}

          {/* Add product action trigger */}
          <button
            type="button"
            onClick={handleOpenAdd}
            className="flex items-center justify-center gap-1.5 px-5 py-2.5 bg-gradient-to-r from-gold-600 via-gold-500 to-amber-500 text-white font-extrabold rounded-xl text-xs shadow-md shadow-gold-600/10 hover:shadow-gold-600/20 border border-gold-400/30 transition-all cursor-pointer whitespace-nowrap shrink-0 hover:scale-[1.02] active:scale-[0.98] hover:brightness-105"
          >
            <Plus size={15} className="stroke-[2.5px]" /> Cadastrar Peça / Pneu
          </button>
        </div>

        {/* Dynamic Filters Section */}
        <div className="flex flex-wrap items-center gap-3.5 border-t border-slate-100 pt-4 text-[11px] font-sans">
          
          {/* Brand filtering */}
          <div className="flex items-center gap-1.5 text-slate-700 font-medium">
            <Filter size={13} className="text-gold-600 shrink-0" />
            <span className="text-slate-500 font-semibold">Marca:</span>
            <select
              value={selectedBrand}
              onChange={(e) => setSelectedBrand(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-slate-900 focus:outline-none focus:ring-2 focus:ring-gold-500/15 focus:border-gold-500 font-semibold cursor-pointer"
            >
              <option value="">Todas</option>
              {availableBrands.map(brand => (
                <option key={brand} value={brand}>{brand}</option>
              ))}
            </select>
          </div>

          {/* Size filtering */}
          <div className="flex items-center gap-1.5 text-slate-700 font-medium">
            <Filter size={13} className="text-gold-600 shrink-0" />
            <span className="text-slate-500 font-semibold">Tamanho:</span>
            <select
              value={selectedSize}
              onChange={(e) => setSelectedSize(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-900 focus:outline-none focus:ring-2 focus:ring-gold-500/15 focus:border-gold-500 font-semibold max-w-[180px] truncate cursor-pointer"
            >
              <option value="">Todas</option>
              {availableSizes.map(size => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>

          {/* Stock inventory filters */}
          <div className="flex items-center gap-1 p-1 bg-slate-100/60 rounded-xl border border-slate-200/80">
            <span className="text-slate-500 font-bold px-2 text-[9px] uppercase tracking-wider">Estoque:</span>
            <button
              type="button"
              onClick={() => setStockFilter("all")}
              className={`px-3 py-1 rounded-lg font-bold transition-all cursor-pointer ${
                stockFilter === "all" ? "bg-white text-gold-700 shadow-xs border border-slate-200 font-black" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Todos ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setStockFilter("low")}
              className={`px-3 py-1 rounded-lg font-extrabold transition-all flex items-center gap-1 cursor-pointer ${
                stockFilter === "low" ? "bg-red-650 text-white shadow-xs" : "text-red-700 hover:bg-red-50"
              }`}
            >
              Estoque Baixo (≤4 un)
            </button>
            <button
              type="button"
              onClick={() => setStockFilter("normal")}
              className={`px-3 py-1 rounded-lg font-bold transition-all cursor-pointer ${
                stockFilter === "normal" ? "bg-white text-gold-700 shadow-xs border border-slate-200 font-black" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Normal
            </button>
          </div>

          {/* Company filtering (Admins only) */}
          {isAdmin && companies.length > 0 && (
            <div className="flex items-center gap-1.5 text-slate-700 font-medium">
              <Filter size={13} className="text-gold-600 shrink-0" />
              <span className="text-slate-500 font-semibold">Empresa:</span>
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-900 focus:outline-none focus:ring-2 focus:ring-gold-500/15 focus:border-gold-500 font-semibold max-w-[180px] truncate cursor-pointer"
              >
                <option value="">Todas</option>
                {companies.map(comp => (
                  <option key={comp.id} value={comp.id}>{comp.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Quick Clear filters */}
          {(searchTerm !== "" || searchId !== "" || selectedBrand !== "" || selectedSize !== "" || stockFilter !== "all" || selectedCompanyId !== "") && (
            <button
              type="button"
              onClick={() => {
                setSearchTerm("");
                setSearchId("");
                setSelectedBrand("");
                setSelectedSize("");
                setStockFilter("all");
                setSelectedCompanyId("");
              }}
              className="text-[10px] font-bold text-red-650 hover:text-red-700 flex items-center gap-1 bg-red-50 px-2 py-1.5 rounded-lg border border-red-100 transition-colors cursor-pointer"
            >
              Limpar Filtros
            </button>
          )}

          {/* Dynamic counter logs */}
          <div className="ml-auto text-slate-400 font-extrabold text-[10px] uppercase tracking-widest hidden sm:block">
            Auditados: <span className="text-slate-800 font-extrabold text-xs">{filteredItems.length}</span> / {items.length} itens
          </div>
        </div>
      </div>

      {savedMsg && (
        <div className="mb-3 flex items-start gap-2 bg-emerald-50 border-l-4 border-emerald-500 text-emerald-800 px-3.5 py-2.5 rounded-xl text-xs font-semibold leading-relaxed animate-fadeIn">
          <Check size={14} className="shrink-0 mt-0.5 stroke-[3px]" />
          <span className="flex-1">{savedMsg}</span>
          <button
            type="button"
            onClick={() => setSavedMsg("")}
            className="shrink-0 text-emerald-600 hover:text-emerald-900 cursor-pointer"
            title="Fechar"
          >
            <X size={14} className="stroke-[2.5px]" />
          </button>
        </div>
      )}

      {/* Main Stock Container */}
      <div className="bg-transparent overflow-hidden font-sans">
        {filteredItems.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col items-center justify-center py-12 text-center text-slate-400">
            <Archive size={48} className="stroke-[1.5px] mb-3 text-slate-200" />
            <p className="font-bold text-slate-800 text-base">Nenhum produto encontrado</p>
            <p className="text-xs text-slate-500 max-w-sm mt-1 px-4">
              {items.length === 0 
                ? "Seu estoque está vazio. Comece clicando em 'Cadastrar Produto' ou faça uma importação inteligente de PDF de compras no botão acima."
                : "Ajuste os filtros de busca para visualizar outros resultados cadastrados."
              }
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            
            {/* ====== DESKTOP TABLE VIEW: Visible on tablets and PCs ====== */}
            <div className="hidden md:block bg-white rounded-2xl border-t-2 border-t-gold-500/80 border-x border-b border-slate-200/80 shadow-[0_4px_25px_rgba(0,0,0,0.015)] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100 text-left text-sm table-fixed">
                  <thead className="bg-slate-50 text-slate-400 text-[10px] uppercase tracking-widest font-extrabold sticky top-0">
                    <tr>
                      <th className="py-3 px-2 border-b border-slate-100 w-[60px] text-center font-black">Foto</th>
                      <th className="py-3 px-2 border-b border-slate-100 w-[110px] font-black">ID / SKU</th>
                      <th className="py-3 px-2 border-b border-slate-100 font-black">Produto & Especificações</th>
                      {isAdmin && <th className="py-3 px-2 border-b border-slate-100 w-[120px] font-black">Proprietário</th>}
                      <th className="py-3 px-2 border-b border-slate-100 w-[90px] text-center font-black">Estoque</th>
                      <th className="py-3 px-2 border-b border-slate-100 w-[85px] text-right font-black">À Vista</th>
                      <th className="py-3 px-2 border-b border-slate-100 w-[85px] text-right font-black">A Prazo</th>
                      <th className="py-3 px-2 border-b border-slate-100 w-[150px] font-black">Anotações</th>
                      <th className="py-3 px-2 border-b border-slate-100 w-[90px] text-center font-black">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white text-slate-800">
                    {paginatedItems.map(item => {
                      const fallbackImg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDQ5MzIxIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PHBhdGggZD0iTTEyIDJ2NCBNMTIgMTh2NCBNNC45MyA0LjkzbDIuODMgMi44MyBNMTYuMjQgMTYuMjRsMi44MyAyLjgzIE0yIDEyaDQgTTE4IDEyaDQgTTQuOTMgMTkuMDdsMi44My0yLjgzIE0xNi4yNCA3Ljc2bDIuODMtMi44MyIvPjwvc3ZnPg==";
                      const activeImg = item.imageUrl || fallbackImg;
                      // Pneu com reserva ativa ganha a linha inteira em ambar e uma
                      // barra na lateral. O selo pequeno na coluna de quantidade
                      // continua dizendo QUANTO esta preso; a cor da linha e o que
                      // faz a pessoa notar de longe, passando o olho pela tabela.
                      const rowReserved = reservedQuantityOf(item);
                      
                      return (
                        <tr
                          key={item.id}
                          title={rowReserved > 0
                            ? `${rowReserved} un reservadas — livre para venda: ${availableQuantity(item)} un.`
                            : undefined}
                          className={`text-slate-800 transition-all border-b ${
                            rowReserved > 0
                              ? "bg-amber-50/70 hover:bg-amber-100/70 border-amber-200/70 border-l-4 border-l-amber-400"
                              : "hover:bg-gold-50/10 border-slate-100/60"
                          }`}
                        >
                          
                          {/* Image Thumbnail Column */}
                          <td className="py-2 px-2 text-center align-middle">
                            <div className="h-10 w-10 mx-auto rounded-lg overflow-hidden border border-slate-200 bg-slate-50 hover:border-gold-400 group hover:scale-[1.08] transition-all shadow-sm">
                              <img 
                                src={activeImg} 
                                className="h-full w-full object-cover group-hover:brightness-105" 
                                alt={item.model}
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          </td>

                          {/* ID column with high density styling */}
                          <td className="py-2 px-2 font-semibold text-xs align-middle">
                            <span className="inline-block px-2 py-0.5 text-gold-700 bg-gold-400/10 rounded-lg border border-gold-500/20 font-mono tracking-wider font-extrabold uppercase shadow-xs">
                              {item.sku}
                            </span>
                          </td>

                          {/* Brand, Model, Size, and Description Column */}
                          <td className="py-2 px-2 align-middle">
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-900 uppercase text-xs sm:text-sm">
                                <span className="text-gold-600 font-extrabold mr-1.5">{item.size}</span>
                                {item.brand} <span className="font-normal text-slate-650">{item.model}</span>
                              </span>
                              {item.description && (
                                <p className="text-[11px] text-slate-405 truncate max-w-md mt-0.5" title={item.description}>
                                  {item.description}
                                </p>
                              )}
                            </div>
                          </td>

                          {/* Owner column (Visible to admin only) */}
                          {isAdmin && (
                            <td className="py-2 px-2 text-xs truncate align-middle max-w-[100px]" title={item.companyName || item.userEmail}>
                              {item.companyName ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[10px] font-black bg-[#1e1a12] text-gold-400 border border-gold-500/30 uppercase tracking-widest leading-none">
                                  {item.companyName}
                                </span>
                              ) : (
                                <>
                                  <span className="font-semibold text-slate-700 block max-w-full truncate">
                                    {item.userEmail.split('@')[0]}
                                  </span>
                                  <span className="text-[10px] text-slate-400 tracking-wider font-semibold block truncate">
                                    {item.userEmail}
                                  </span>
                                </>
                              )}
                            </td>
                          )}

                          {/* Quantity column */}
                          <td className="py-2 px-2 text-center align-middle">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-bold text-xs ${
                              item.quantity <= 4 
                                ? "bg-red-55 text-red-700 border border-red-200 ring-4 ring-red-100/30 animate-pulse font-extrabold" 
                                : "bg-emerald-50 text-emerald-800 border border-emerald-100"
                            }`}>
                              {item.quantity <= 4 && <AlertTriangle size={12} className="text-red-600 shrink-0" />}
                              {item.quantity} un
                            </span>
                            {rowReserved > 0 && (
                              <span
                                className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white border border-amber-600 text-[9px] font-black uppercase tracking-wider whitespace-nowrap shadow-sm"
                                title={`${rowReserved} un reservadas para clientes ou transferências — livre: ${availableQuantity(item)} un.`}
                              >
                                <Lock size={9} className="stroke-[3px]" /> {rowReserved} reservado{rowReserved > 1 ? "s" : ""}
                              </span>
                            )}
                          </td>

                          {/* Unit Price columns */}
                          <td className="py-2 px-2 text-right font-bold text-emerald-700 align-middle whitespace-nowrap text-xs">
                            {(item.priceCash || item.price) > 0 ? formatBRL(item.priceCash || item.price) : <span className="text-slate-300 font-normal">—</span>}
                          </td>
                          <td className="py-2 px-2 text-right font-bold text-slate-900 align-middle whitespace-nowrap text-xs">
                            {(item.priceInstallment || item.price) > 0 ? formatBRL(item.priceInstallment || item.price) : <span className="text-slate-300 font-normal">—</span>}
                          </td>

                          {/* Shelf Location or generic notes */}
                          <td className="py-2 px-2 text-[11px] text-slate-500 align-middle truncate max-w-[150px]" title={item.notes}>
                            {item.notes || <span className="text-slate-305 italic">Sem notas</span>}
                          </td>

                          {/* Actions column */}
                          <td className="py-2 px-2 text-center align-middle">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => handleOpenCheckout(item)}
                                className="p-1.5 text-red-550 hover:bg-red-50 rounded transition-colors border border-transparent hover:border-red-200 cursor-pointer"
                                title="Registrar saída deste pneu (Baixa)"
                              >
                                <TrendingDown size={13} className="stroke-[2.5px]" />
                              </button>
                              <button
                                onClick={() => handleOpenEdit(item)}
                                className="p-1.5 text-blue-600 hover:bg-slate-100 rounded transition-colors border border-transparent hover:border-slate-200 cursor-pointer"
                                title="Ajustar estoque ou dados"
                              >
                                <Edit size={13} className="stroke-[2.5px]" />
                              </button>
                              <button
                                onClick={() => {
                                  if (window.confirm(`Tem certeza que deseja DELETAR do estoque o produto ${item.brand} ${item.model} (${item.size})?`)) {
                                    onDeleteItem(item.id).catch((err: any) => alert(err?.message || "Erro ao excluir produto."));
                                  }
                                }}
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors border border-transparent hover:border-red-200 cursor-pointer"
                                title="Deletar permanentemente"
                              >
                                <Trash2 size={13} className="stroke-[2.5px]" />
                              </button>
                            </div>
                          </td>

                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ====== MOBILE CARD VIEW: Visible only on cellphones ====== */}
            <div className="block md:hidden space-y-3">
              {paginatedItems.map(item => {
                const fallbackImg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDQ5MzIxIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PHBhdGggZD0iTTEyIDJ2NCBNMTIgMTh2NCBNNC45MyA0LjkzbDIuODMgMi44MyBNMTYuMjQgMTYuMjRsMi44MyAyLjgzIE0yIDEyaDQgTTE4IDEyaDQgTTQuOTMgMTkuMDdsMi44My0yLjgzIE0xNi4yNCA3Ljc2bDIuODMtMi44MyIvPjwvc3ZnPg==";
                const activeImg = item.imageUrl || fallbackImg;
                
                return (
                  <div 
                    key={item.id} 
                    className={`bg-white rounded-xl p-3.5 border shadow-xs transition-all flex flex-col space-y-3 ${
                      item.quantity <= 4 ? "border-l-4 border-l-red-500 border-y border-r border-slate-200 bg-red-50/15" : "border-l-4 border-l-gold-500 border-y border-r border-slate-200"
                    }`}
                  >
                    
                    {/* Header line of product Card */}
                    <div className="flex items-center justify-between">
                      <span className="px-2.5 py-0.5 text-[10px] text-gold-700 bg-gold-400/10 rounded-md border border-gold-300/30 font-mono font-black tracking-wider uppercase">
                        {item.sku}
                      </span>
                      {item.quantity <= 4 ? (
                        <span className="flex items-center gap-1 bg-red-100/90 text-red-800 text-[9px] font-black uppercase px-2 py-0.5 rounded-full animate-pulse">
                          <AlertTriangle size={10} /> Alerta Crítico
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full font-extrabold">
                          Estoque Seguro
                        </span>
                      )}
                    </div>

                    {/* Main item details row */}
                    <div className="flex gap-3">
                      
                      {/* Product Thumbnail image */}
                      <div className="h-16 w-16 rounded border border-slate-200 overflow-hidden bg-slate-50 flex-shrink-0 self-center">
                        <img 
                          src={activeImg} 
                          className="h-full w-full object-cover" 
                          alt={item.model} 
                          referrerPolicy="no-referrer"
                        />
                      </div>

                      {/* Info details */}
                      <div className="flex-1 min-w-0">
                        <h4 className="font-extrabold text-slate-900 leading-tight truncate text-xs uppercase">
                          <span className="text-gold-600 font-extrabold mr-1.5">{item.size}</span>
                          {item.brand} <span className="font-semibold text-slate-700">{item.model}</span>
                        </h4>
                        {item.description ? (
                          <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                            {item.description}
                          </p>
                        ) : (
                          <p className="text-[10px] text-slate-300 italic mt-0.5">
                            Sem descrição cadastrada
                          </p>
                        )}
                        {item.notes && (
                          <p className="text-[10px] text-slate-400 mt-1 font-semibold">
                            Localização: {item.notes}
                          </p>
                        )}
                        {isAdmin && (
                          <div className="mt-1">
                            {item.companyName ? (
                              <span className="inline-block text-[10px] font-black bg-[#1e1a12] text-gold-400 px-2 py-0.5 rounded border border-gold-500/20 uppercase tracking-widest leading-none">
                                {item.companyName}
                              </span>
                            ) : (
                              <span className="text-[9px] text-[#1a5fb4] font-extrabold uppercase tracking-widest">
                                User: {item.userEmail.split('@')[0]}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Touch Quick Price and Inventory Adjuster */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                      
                      <div className="flex gap-4">
                        <div>
                          <span className="text-[9px] text-emerald-600 block font-bold uppercase leading-none">À Vista</span>
                          <span className="font-black text-emerald-700 text-sm">
                            {(item.priceCash || item.price) > 0 ? formatBRL(item.priceCash || item.price) : "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-slate-400 block font-bold uppercase leading-none">A Prazo</span>
                          <span className="font-black text-slate-900 text-sm">
                            {(item.priceInstallment || item.price) > 0 ? formatBRL(item.priceInstallment || item.price) : "—"}
                          </span>
                        </div>
                      </div>

                      {/* Interactive direct mobile quick amount adjusters */}
                      <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                        <button
                          type="button"
                          title="Remover 1 unidade"
                          onClick={() => {
                            if (availableQuantity(item) <= 0) {
                              alert(
                                reservedQuantityOf(item) > 0
                                  ? `Todas as ${reservedQuantityOf(item)} un deste pneu estão reservadas para clientes ou transferências.`
                                  : "Este pneu está com saldo zerado."
                              );
                            } else {
                              onUpdateItem(item.id, { quantity: item.quantity - 1 }, "Baixa rápida via celular", -1)
                                .catch((err: any) => alert(err?.message || "Erro ao dar baixa."));
                            }
                          }}
                          className="h-8 w-8 text-red-600 active:bg-slate-200 font-extrabold hover:text-red-700 flex items-center justify-center cursor-pointer select-none rounded text-lg transition-colors border border-transparent"
                        >
                          -
                        </button>
                        
                        <div className="px-2 text-center min-w-[2.5rem]">
                          <span className="block text-[11px] font-extrabold text-slate-900 font-mono">
                            {item.quantity}
                          </span>
                          <span className="text-[8px] text-slate-400 font-bold block uppercase leading-none">Unidade</span>
                        </div>

                        <button
                          type="button"
                          title="Adicionar 1 unidade"
                          onClick={() => {
                            onUpdateItem(item.id, { quantity: item.quantity + 1 }, "Entrada rápida via celular", 1)
                              .catch((err: any) => alert(err?.message || "Erro ao lançar entrada."));
                          }}
                          className="h-8 w-8 text-emerald-600 active:bg-slate-200 font-extrabold hover:text-emerald-700 flex items-center justify-center cursor-pointer select-none rounded text-lg transition-colors border border-transparent"
                        >
                          +
                        </button>
                      </div>

                    </div>

                    {/* Additional standard actions for edit/delete */}
                    <div className="flex justify-end gap-2 pt-1 border-t border-slate-50">
                      <button
                        onClick={() => handleOpenCheckout(item)}
                        className="py-1 px-3 text-[10px] font-bold text-red-650 bg-red-50 hover:bg-red-100 rounded border border-red-150 transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <TrendingDown size={10} /> Registrar Saída
                      </button>
                      <button
                        onClick={() => handleOpenEdit(item)}
                        className="py-1 px-3 text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200 transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Edit size={10} /> Ajustar Cadastro
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Deseja deletar ${item.brand} ${item.model} permanentemente?`)) {
                            onDeleteItem(item.id).catch((err: any) => alert(err?.message || "Erro ao excluir produto."));
                          }
                        }}
                        className="py-1 px-3 text-[10px] font-bold text-red-650 bg-red-50 hover:bg-red-150 rounded border border-red-150 transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 size={10} /> Remover
                      </button>
                    </div>

                  </div>
                );
              })}
            </div>

            {/* Paginação do Estoque */}
            {totalPages > 1 && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs mt-4 text-xs font-semibold text-slate-700">
                <div className="flex items-center gap-2">
                  <span>Itens por página:</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => {
                      setItemsPerPage(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-800 focus:outline-none focus:ring-2 focus:ring-gold-500/10 cursor-pointer font-bold"
                  >
                    {[10, 15, 25, 50].map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <span className="text-slate-400 font-normal">
                    | Mostrando {Math.min(filteredItems.length, (currentPage - 1) * itemsPerPage + 1)} - {Math.min(filteredItems.length, currentPage * itemsPerPage)} de {filteredItems.length} itens
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Anterior
                  </button>
                  
                  {/* Page Numbers */}
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(page => page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1)
                    .map((page, idx, arr) => {
                      const showEllipsis = idx > 0 && page - arr[idx - 1] > 1;
                      return (
                        <React.Fragment key={page}>
                          {showEllipsis && <span className="px-2 text-slate-400 font-normal">...</span>}
                          <button
                            type="button"
                            onClick={() => setCurrentPage(page)}
                            className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                              currentPage === page
                                ? "bg-slate-900 text-white font-extrabold shadow-sm"
                                : "border border-slate-200 hover:bg-slate-50 text-slate-700"
                            }`}
                          >
                            {page}
                          </button>
                        </React.Fragment>
                      );
                    })}

                  <button
                    type="button"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Próximo
                  </button>
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* MODAL: ADD PRODUCT MANUAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-6 border border-slate-200 shadow-2xl animate-scaleUp overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-slate-105 pb-3">
              <h3 className="text-lg font-bold text-slate-900">Cadastrar Novo Produto</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1 text-slate-400 hover:text-slate-900 rounded">
                <X size={18} />
              </button>
            </div>

            {errorMsg && (
              <div className="mt-3 bg-red-50 text-red-700 text-xs p-2.5 rounded border border-red-100">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleSaveAdd} className="mt-4 space-y-3 font-sans text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Identificador / SKU *</label>
                  <input
                    type="text"
                    required
                    value={formSku}
                    onChange={(e) => setFormSku(e.target.value.toUpperCase())}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-mono font-bold uppercase outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Marca / Fabricante *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Michelin / Bosch"
                    value={formBrand}
                    onChange={(e) => setFormBrand(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Modelo / Nome *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Primacy 4 / H7"
                    value={formModel}
                    onChange={(e) => setFormModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Medida / Especificações *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: 205/55R16 ou 12V 55W"
                    value={formSize}
                    onChange={(e) => setFormSize(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-mono font-bold outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Estoque Inicial *</label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={formQuantity}
                    onChange={(e) => setFormQuantity(parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold text-center outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="w-1/2">
                    <label className="block text-xs font-semibold text-emerald-700 mb-1">À Vista (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formPriceCash}
                      onChange={(e) => setFormPriceCash(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold text-right outline-none focus:ring-1 focus:ring-emerald-500 bg-emerald-50 text-emerald-800"
                    />
                  </div>
                  <div className="w-1/2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">A Prazo (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formPriceInstallment}
                      onChange={(e) => setFormPriceInstallment(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold text-right outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                    />
                  </div>
                </div>
              </div>

              {/* Field: Company Selector (Visible to Admin only) */}
              {isAdmin && companies.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 font-sans">Empresa Proprietária *</label>
                  <select
                    value={formCompanyId}
                    onChange={(e) => setFormCompanyId(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-slate-205 rounded text-xs font-bold font-sans outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  >
                    <option value="">Selecione uma Empresa...</option>
                    {companies.map(comp => (
                      <option key={comp.id} value={comp.id}>{comp.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Descrição Detalhada</label>
                <textarea
                  rows={2}
                  placeholder="Escreva detalhes do produto, compatibilidade, lote, etc."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Imagem do Produto (URL ou Seleção Rápida)</label>
                <input
                  type="url"
                  placeholder="Cole uma URL da internet ou escolha uma das opções abaixo:"
                  value={formImageUrl}
                  onChange={(e) => setFormImageUrl(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded text-[11px] font-mono outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-800"
                />
                <div className="mt-2 flex items-center gap-1.5 bg-slate-100/55 p-1 rounded border border-slate-200">
                  <span className="text-[9px] uppercase font-bold text-slate-500 pl-1">Rápida:</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDQ5MzIxIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PHBhdGggZD0iTTEyIDJ2NCBNMTIgMTh2NCBNNC45MyA0LjkzbDIuODMgMi44My BNMTYuMjQgMTYuMjRsMi44MyAyLjgzIE0yIDEyaDQgTTE4IDEyaDQgTTQuOTMgMTkuMDdsMi44My0yLjgzIE0xNi2yNCA3Ljc2bDIuODMtMi44MyIvPjwvc3ZnPg==")}
                      className={`h-6 w-6 rounded-full overflow-hidden border p-1 bg-slate-50 transition-all ${formImageUrl.startsWith("data:image") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Pneu/Roda (Leve)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d49321" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1486006920555-c77dce18193b") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Auto Peças"
                    >
                      <img src="https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1507136566006-cfc505b114fc") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Ferramentas"
                    >
                      <img src="https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1511919884226-fd3cad34687c") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Motor/Peça"
                    >
                      <img src="https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                  </div>
                </div>

                {formImageUrl && (
                  <div className="mt-2 flex items-center gap-2 p-1.5 bg-blue-50/60 rounded border border-blue-100">
                    <img src={formImageUrl} className="h-8 w-8 object-cover rounded border border-blue-200" alt="Preview" referrerPolicy="no-referrer" />
                    <span className="text-[10px] text-blue-700 font-bold truncate">Visualização ativa para exibição</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Anotações Internas / Prateleira</label>
                <textarea
                  rows={1}
                  placeholder="Ex: Corredor B, Prateleira 4"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-750 hover:bg-slate-50 rounded border border-slate-200 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {submitting ? "Cadastrando..." : "Cadastrar Produto"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDIT PRODUCT + MANAGE QUANTITY INPUT (Logs actual entry/exit movements) */}
      {showEditModal && editingItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-6 border border-slate-200 shadow-2xl animate-scaleUp overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-slate-105 pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Ficha e Ajuste do Produto</h3>
                <span className="text-[10px] text-slate-500 font-mono font-semibold tracking-wider">SKU: {editingItem.sku}</span>
              </div>
              <button onClick={() => setShowEditModal(false)} className="p-1 text-slate-400 hover:text-slate-900 rounded">
                <X size={18} />
              </button>
            </div>

            {errorMsg && (
              <div className="mt-3 bg-red-50 text-red-700 text-xs p-2.5 rounded border border-red-100">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleSaveEdit} className="mt-4 space-y-3 font-sans text-sm">
              
              {/* Core Attributes */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Marca</label>
                  <input
                    type="text"
                    required
                    value={formBrand}
                    onChange={(e) => setFormBrand(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Modelo</label>
                  <input
                    type="text"
                    required
                    value={formModel}
                    onChange={(e) => setFormModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Medida</label>
                  <input
                    type="text"
                    required
                    value={formSize}
                    onChange={(e) => setFormSize(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-mono font-bold outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="w-1/2">
                    <label className="block text-xs font-semibold text-emerald-700 mb-1">À Vista (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formPriceCash}
                      onChange={(e) => setFormPriceCash(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold text-right outline-none focus:ring-1 focus:ring-emerald-500 bg-emerald-50 text-emerald-800"
                    />
                  </div>
                  <div className="w-1/2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">A Prazo (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formPriceInstallment}
                      onChange={(e) => setFormPriceInstallment(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-xs font-bold text-right outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                    />
                  </div>
                </div>
              </div>

              {/* Field: Company Selector (Visible to Admin only) */}
              {isAdmin && companies.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 font-sans">Empresa Proprietária *</label>
                  <select
                    value={formCompanyId}
                    onChange={(e) => setFormCompanyId(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-slate-205 rounded text-xs font-bold font-sans outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                  >
                    <option value="">Selecione uma Empresa...</option>
                    {companies.map(comp => (
                      <option key={comp.id} value={comp.id}>{comp.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Advanced Movement update section - super user friendly */}
              <div className="bg-slate-50 p-3.5 rounded border border-slate-205 space-y-2.5">
                <span className="block text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                  <Activity size={14} className="text-blue-600" /> Movimentar Estoque
                </span>

                <div className="grid grid-cols-2 gap-3 items-center">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">Qtd Atual: <strong className="text-slate-900 font-bold">{editingItem.quantity} un</strong></label>
                    <input
                      type="number"
                      required
                      min={0}
                      value={formQuantity}
                      onChange={(e) => setFormQuantity(parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-200 bg-white rounded text-xs font-bold text-center text-slate-900 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  
                  {/* Dynamic calculation of entry/exit to make it perfectly safe */}
                  <div className="text-center">
                    <span className="block text-[10px] font-semibold text-slate-400 uppercase">Ajuste de Saldo</span>
                    {formQuantity - editingItem.quantity > 0 ? (
                      <span className="inline-flex items-center gap-1.5 mt-1 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs font-bold">
                        <TrendingUp size={12} /> +{formQuantity - editingItem.quantity} un (Entrada)
                      </span>
                    ) : formQuantity - editingItem.quantity < 0 ? (
                      <span className="inline-flex items-center gap-1.5 mt-1 px-2.5 py-1 rounded-md bg-red-50 text-red-700 text-xs font-bold">
                        <TrendingDown size={12} /> {formQuantity - editingItem.quantity} un (Saída)
                      </span>
                    ) : (
                      <span className="inline-block mt-2 text-xs font-semibold text-slate-400">
                        Nenhum impacto físico
                      </span>
                    )}
                  </div>
                </div>

                {formQuantity - editingItem.quantity !== 0 && (
                  <div>
                    <label className="block text-[10px] font-bold text-slate-700 uppercase tracking-wide mb-1">Motivo da Movimentação *</label>
                    <select
                      required
                      value={movementReason}
                      onChange={(e) => setMovementReason(e.target.value)}
                      className="w-full px-3 py-1.5 border border-slate-205 bg-white rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 text-slate-900"
                    >
                      <option value="">Selecione o motivo...</option>
                      <option value="Venda">Venda</option>
                      <option value="Transferência">Transferência</option>
                      <option value="Ajuste">Ajuste de Estoque</option>
                      <option value="Perda">Perda / Avaria</option>
                      <option value="Outros">Outros</option>
                    </select>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Descrição Detalhada</label>
                <textarea
                  rows={2}
                  placeholder="Escreva detalhes do produto, compatibilidade, lote, etc."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Imagem do Produto (URL ou Seleção Rápida)</label>
                <input
                  type="url"
                  placeholder="Cole uma URL da internet ou escolha uma das opções abaixo:"
                  value={formImageUrl}
                  onChange={(e) => setFormImageUrl(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded text-[11px] font-mono outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-800"
                />
                <div className="mt-2 flex items-center gap-1.5 bg-slate-100/55 p-1 rounded border border-slate-200">
                  <span className="text-[9px] uppercase font-bold text-slate-500 pl-1">Rápida:</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDQ5MzIxIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PHBhdGggZD0iTTEyIDJ2NCBNMTIgMTh2NCBNNC45MyA0LjkzbDIuODMgMi44My BNMTYuMjQgMTYuMjRsMi44MyAyLjgzIE0yIDEyaDQgTTE4IDEyaDQgTTQuOTMgMTkuMDdsMi44My0yLjgzIE0xNi2yNCA3Ljc2bDIuODMtMi44MyIvPjwvc3ZnPg==")}
                      className={`h-6 w-6 rounded-full overflow-hidden border p-1 bg-slate-50 transition-all ${formImageUrl.startsWith("data:image") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Pneu/Roda (Leve)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d49321" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1486006920555-c77dce18193b") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Auto Peças"
                    >
                      <img src="https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1507136566006-cfc505b114fc") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Ferramentas"
                    >
                      <img src="https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormImageUrl("https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=300&q=80")}
                      className={`h-6 w-6 rounded-full overflow-hidden border transition-all ${formImageUrl.includes("photo-1511919884226-fd3cad34687c") ? "ring-2 ring-blue-600 scale-105" : "border-slate-300"}`}
                      title="Anexar Motor/Peça"
                    >
                      <img src="https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=50&q=50" className="h-full w-full object-cover" alt="" />
                    </button>
                  </div>
                </div>

                {formImageUrl && (
                  <div className="mt-2 flex items-center gap-2 p-1.5 bg-blue-50/60 rounded border border-blue-100">
                    <img src={formImageUrl} className="h-8 w-8 object-cover rounded border border-blue-200" alt="Preview" referrerPolicy="no-referrer" />
                    <span className="text-[10px] text-blue-700 font-bold truncate">Visualização ativa para exibição</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Anotações Internas / Prateleira</label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500 bg-slate-50 text-slate-900"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-750 hover:bg-slate-50 rounded border border-slate-200 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {submitting ? "Gravando..." : "Salvar Alterações"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: BAIXA DE ESTOQUE (SAÍDA DE PNEUS) */}
      {showCheckoutModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 border border-slate-200/85 shadow-2xl animate-scaleUp overflow-y-auto max-h-[90vh] font-sans">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-red-50 text-red-650 flex items-center justify-center border border-red-100/50 shadow-inner">
                  <TrendingDown size={16} className="stroke-[2.5px]" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide">Saída de Pneus</h3>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest leading-none">Baixa de estoque</p>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setShowCheckoutModal(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {errorMsg && (
              <div className="mt-3 bg-red-50 text-red-750 text-xs p-2.5 rounded-xl border border-red-100/80 font-semibold">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleSaveCheckout} className="mt-4 space-y-4 text-sm text-left">
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Selecionar Pneu / Peça
                  </label>
                  {checkoutSelectedItemRef ? (
                    <div className="flex flex-col gap-3 p-3 rounded-xl border border-gold-300/40 bg-gold-50/30">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs">
                          <span className="font-mono font-extrabold text-gold-700">{checkoutSelectedItemRef.sku}</span>{" "}
                          <span className="font-bold text-slate-800">{checkoutSelectedItemRef.brand} {checkoutSelectedItemRef.model}</span>{" "}
                          <span className="text-slate-400 font-mono">({checkoutSelectedItemRef.size})</span>
                          <div className="text-[10px] text-slate-500 font-semibold mt-0.5">Saldo disponível: {checkoutSelectedItemRef.quantity} un</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCheckoutSelectedItemId("")}
                          className="text-[10px] font-black text-red-600 hover:underline cursor-pointer shrink-0 mt-0.5"
                        >
                          Alterar
                        </button>
                      </div>
                      
                      <div className="flex items-end gap-3 mt-2">
                        <div className="w-1/3">
                          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                            Qtd *
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={checkoutSelectedItemRef.quantity}
                            value={checkoutQuantityStr}
                            onChange={e => setCheckoutQuantityStr(e.target.value)}
                            placeholder={`Máx. ${checkoutSelectedItemRef.quantity}`}
                            className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleAddCheckoutItem}
                          className="flex-1 py-2 bg-emerald-600 text-white rounded-xl text-xs font-extrabold hover:bg-emerald-700 transition-colors shadow-sm flex justify-center items-center gap-1 cursor-pointer"
                        >
                          <Plus size={14} /> Confirmar Item na Lista
                        </button>
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
                          placeholder="Pesquise por SKU, marca, modelo ou medida..."
                          value={checkoutSearch}
                          onChange={e => setCheckoutSearch(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                        />
                      </div>
                      <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100 bg-white">
                        {checkoutStockOptions.length === 0 ? (
                          <div className="p-3 text-xs text-slate-400 font-semibold text-center">Nenhum item com saldo disponível encontrado.</div>
                        ) : (
                          checkoutStockOptions.map(item => (
                            <button
                              type="button"
                              key={item.id}
                              onClick={() => {
                                setCheckoutSelectedItemId(item.id);
                                setCheckoutQuantityStr("1");
                              }}
                              className="w-full text-left p-2.5 hover:bg-gold-50/40 transition-colors cursor-pointer flex items-center justify-between gap-2"
                            >
                              <span className="text-xs min-w-0 truncate">
                                <span className="font-mono font-extrabold text-gold-700">{item.sku}</span>{" "}
                                <span className="font-bold text-slate-800">{item.brand} {item.model}</span>{" "}
                                <span className="text-slate-400 font-mono">({item.size})</span>
                              </span>
                              <span className="text-[10px] font-mono font-bold text-slate-500 shrink-0 text-right">
                                {availableQuantity(item)} un
                                {reservedQuantityOf(item) > 0 && (
                                  <span className="block text-[9px] text-amber-700 font-bold">{reservedQuantityOf(item)} reserv.</span>
                                )}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2 border border-slate-200 rounded-xl p-3 bg-slate-50">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">
                    Lista de Itens para Baixa ({checkoutItems.length})
                  </label>
                  
                  {checkoutItems.length === 0 ? (
                    <div className="text-center py-6 border-2 border-dashed border-slate-200 rounded-lg bg-white">
                      <p className="text-xs text-slate-500 font-bold">Nenhum item adicionado ainda.</p>
                      <p className="text-[10px] text-slate-400 mt-1">Pesquise um produto acima e clique em "Confirmar Item na Lista".</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
                      {checkoutItems.map(cItem => (
                        <div key={cItem.id} className="flex justify-between items-center p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                          <div className="flex flex-col min-w-0 pr-2">
                            <span className="font-mono text-xs font-extrabold text-gold-700 truncate">{cItem.itemRef.sku}</span>
                            <span className="text-xs font-bold text-slate-800 truncate">{cItem.itemRef.brand} {cItem.itemRef.model} <span className="font-mono text-slate-400">({cItem.itemRef.size})</span></span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="font-mono font-bold text-slate-900 bg-slate-100 px-2 py-0.5 rounded">{cItem.quantity} un</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCheckoutItem(cItem.id)}
                              className="text-red-500 hover:text-red-700 p-1 cursor-pointer hover:bg-red-50 rounded"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Motivo da Saída</label>
                <select
                  value={checkoutReason}
                  onChange={(e) => setCheckoutReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 bg-slate-50 text-slate-900 font-semibold cursor-pointer"
                >
                  <option value="Venda">Venda</option>
                  <option value="Ajuste de Estoque">Ajuste de Estoque</option>
                  <option value="Defeito / Descarte">Defeito / Descarte</option>
                  <option value="Uso Interno">Uso Interno</option>
                  <option value="Outro">Outro</option>
                </select>
              </div>

              {checkoutReason === "Outro" && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Especificar Outro Motivo</label>
                  <input
                    type="text"
                    placeholder="Ex: Doação, brinde, etc..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 bg-slate-50 text-slate-900 font-semibold"
                    onChange={(e) => setCheckoutReason(e.target.value)}
                    required
                  />
                </div>
              )}

              {checkoutReason === "Venda" && (
                <div className="bg-slate-50/50 p-3.5 rounded-xl border border-slate-200/80 space-y-3">
                  <span className="block text-[10px] font-black text-slate-500 uppercase tracking-widest font-sans">Identificação do Cliente (Opcional)</span>
                  <div className="space-y-2 font-sans">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-700 uppercase tracking-wide mb-0.5">Nome do Cliente</label>
                      <input
                        type="text"
                        placeholder="Ex: João da Silva"
                        value={checkoutClientName}
                        onChange={(e) => setCheckoutClientName(e.target.value)}
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 bg-white text-slate-900 font-semibold"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-700 uppercase tracking-wide mb-0.5">CPF / CNPJ</label>
                        <input
                          type="text"
                          placeholder="Ex: 000.000.000-00"
                          value={checkoutClientDoc}
                          onChange={(e) => setCheckoutClientDoc(e.target.value)}
                          className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 bg-white text-slate-900 font-semibold"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-700 uppercase tracking-wide mb-0.5">Placa do Veículo</label>
                        <input
                          type="text"
                          placeholder="Ex: ABC-1234"
                          value={checkoutClientVehicle}
                          onChange={(e) => setCheckoutClientVehicle(e.target.value)}
                          className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 bg-white text-slate-900 font-mono font-bold uppercase placeholder:font-normal"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCheckoutModal(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl border border-slate-200 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting || checkoutItems.length === 0}
                  className="px-5 py-2 text-xs font-extrabold text-white bg-slate-900 hover:bg-slate-800 rounded-xl disabled:opacity-50 transition-colors cursor-pointer shadow-md flex items-center gap-1.5"
                >
                  {submitting ? "Processando..." : "Confirmar Saída"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: COMPROVANTE / RECIBO DE VENDA */}
      {lastSaleReceipt && (
        <div className="fixed inset-0 z-55 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 border border-slate-200 shadow-2xl relative flex flex-col space-y-4 font-sans text-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-xs font-black text-emerald-700 uppercase tracking-widest flex items-center gap-1.5">
                <ShoppingBag size={16} /> Saída Confirmada!
              </h3>
              <button 
                onClick={() => setLastSaleReceipt(null)}
                className="p-1 text-slate-400 hover:text-slate-900 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Thermal Receipt Visual Container */}
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/80 font-mono text-[11px] leading-relaxed shadow-inner max-h-[350px] overflow-y-auto">
              <div className="text-center border-b border-dashed border-slate-300 pb-2.5 mb-2.5">
                <span className="font-bold text-xs uppercase tracking-wider block text-slate-900">{lastSaleReceipt.companyName}</span>
                <span className="text-[9px] text-slate-400 block mt-0.5">COMPROVANTE DE SAÍDA</span>
                <span className="text-[9px] text-slate-400 block">{lastSaleReceipt.date}</span>
              </div>

              <div className="space-y-2 text-slate-700">
                <p><strong>ITENS:</strong></p>
                {lastSaleReceipt.items?.map((item: any, idx: number) => (
                  <div key={idx} className="pb-1.5 border-b border-dashed border-slate-200 last:border-0">
                    <div>[{item.sku}] {item.brand} {item.model} (Medida: {item.size})</div>
                    <div className="flex justify-between mt-0.5">
                      <span>{item.quantity} un x R$ {item.priceUnit.toFixed(2).replace(".", ",")}</span>
                      <span>R$ {item.total.toFixed(2).replace(".", ",")}</span>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between font-bold text-xs text-slate-900 border-t border-dashed border-slate-300 pt-1.5 mt-1.5">
                  <span>TOTAL GERAL:</span>
                  <span>R$ {lastSaleReceipt.totalAmount?.toFixed(2).replace(".", ",") || "0,00"}</span>
                </div>
              </div>

              {(lastSaleReceipt.clientName || lastSaleReceipt.clientDoc || lastSaleReceipt.clientVehicle) && (
                <div className="border-t border-dashed border-slate-300 pt-2.5 mt-2.5 text-slate-700">
                  <strong>CLIENTE:</strong><br />
                  {lastSaleReceipt.clientName && <span>Nome: {lastSaleReceipt.clientName}<br /></span>}
                  {lastSaleReceipt.clientDoc && <span>Doc: {lastSaleReceipt.clientDoc}<br /></span>}
                  {lastSaleReceipt.clientVehicle && <span>Placa: {lastSaleReceipt.clientVehicle}<br /></span>}
                </div>
              )}

              <div className="text-center border-t border-dashed border-slate-300 pt-2.5 mt-2.5 text-[9px] text-slate-400">
                Operador: {lastSaleReceipt.userName}
              </div>
            </div>

            {/* Print trigger buttons */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setLastSaleReceipt(null)}
                className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-xl transition-all cursor-pointer"
              >
                Concluir
              </button>
              <button
                type="button"
                onClick={() => handlePrintReceipt(lastSaleReceipt)}
                className="px-4 py-2.5 text-xs font-extrabold text-white bg-slate-900 hover:bg-slate-800 rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                Imprimir Recibo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CLEAR STOCK CONFIRMATION (admins pick which company; alimentadores are always scoped to their own) */}
      {showClearConfirmModal && (() => {
        const clearIsAllCompanies = isAdmin && clearTargetCompanyId === CLEAR_ALL_COMPANIES;
        const clearTargetCompanyName = companies.find(c => c.id === clearTargetCompanyId)?.name || "";
        const clearSelectionPending = isAdmin && !clearTargetCompanyId;
        const clearScopeDescription = !isAdmin
          ? "todos os pneus/peças pertencentes à sua filial"
          : clearIsAllCompanies
          ? "TODOS os pneus/peças de TODAS as empresas cadastradas no sistema"
          : clearTargetCompanyName
          ? `todos os pneus/peças da empresa "${clearTargetCompanyName}"`
          : "os pneus/peças da empresa que você selecionar abaixo";

        return (
        <div className="fixed inset-0 z-55 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 border border-slate-200 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-red-650 flex items-center gap-1.5">
                <AlertTriangle size={20} /> {isAdmin ? "Excluir Estoque de uma Empresa?" : "Excluir Todo o Estoque?"}
              </h3>
              <button
                onClick={() => setShowClearConfirmModal(false)}
                className="p-1 text-slate-400 hover:text-slate-900 rounded"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 py-4 text-xs text-slate-700">
              <p>
                <strong>ATENÇÃO!</strong> Esta ação irá apagar permanentemente {clearScopeDescription}.
              </p>
              <p className="bg-red-50 text-red-700 p-3 rounded-lg border border-red-100 font-semibold leading-relaxed">
                Todas as exclusões serão registradas individualmente no histórico de auditoria para segurança.
              </p>

              {isAdmin && (
                <div className="space-y-1.5">
                  <label className="block font-bold text-slate-800 uppercase tracking-wide">
                    Qual estoque você deseja apagar?
                  </label>
                  <select
                    value={clearTargetCompanyId}
                    onChange={(e) => setClearTargetCompanyId(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-4 focus:ring-red-500/10 focus:border-red-500 font-bold bg-slate-50/50 cursor-pointer"
                  >
                    <option value="" disabled>Selecione uma empresa...</option>
                    {companies.map(comp => (
                      <option key={comp.id} value={comp.id}>{comp.name}</option>
                    ))}
                    <option value={CLEAR_ALL_COMPANIES}>⚠️ TODAS AS EMPRESAS (ação total)</option>
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="block font-bold text-slate-800 uppercase tracking-wide">
                  Digite <span className="font-mono text-red-650 bg-red-50/50 px-1 py-0.5 rounded font-black border border-red-200">APAGAR</span> abaixo para prosseguir:
                </label>
                <input
                  type="text"
                  placeholder="APAGAR"
                  value={clearConfirmText}
                  onChange={(e) => setClearConfirmText(e.target.value)}
                  className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-4 focus:ring-red-500/10 focus:border-red-500 font-bold uppercase tracking-wider bg-slate-50/50 placeholder:text-slate-300"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowClearConfirmModal(false)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl border border-slate-200 transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={clearConfirmText.trim().toUpperCase() !== "APAGAR" || submitting || clearSelectionPending}
                onClick={async () => {
                  if (onClearStock) {
                    setSubmitting(true);
                    try {
                      const scopeCompanyId = isAdmin
                        ? (clearIsAllCompanies ? undefined : clearTargetCompanyId)
                        : undefined; // handleClearCompanyStock always scopes alimentadores to their own company
                      await onClearStock(scopeCompanyId);
                      setShowClearConfirmModal(false);
                    } catch (err: any) {
                      alert(err.message || "Erro ao apagar o estoque.");
                    } finally {
                      setSubmitting(false);
                    }
                  }
                }}
                className="px-5 py-2 text-xs font-extrabold text-white bg-red-650 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all cursor-pointer shadow-md shadow-red-600/10"
              >
                {submitting ? "Excluindo..." : "Sim, Apagar Estoque"}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* MODAL: BARCODE SCANNER VIA CAMERA */}
      {showScannerModal && (
        <div className="fixed inset-0 z-55 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#0b0f19] text-white rounded-3xl w-full max-w-sm p-6 border border-slate-800 shadow-2xl relative flex flex-col space-y-4 font-sans">
            <style>{`
              @keyframes scanLaser {
                0% { top: 15%; opacity: 0.3; }
                50% { top: 85%; opacity: 1; }
                100% { top: 15%; opacity: 0.3; }
              }
              .animate-laserLine {
                animation: scanLaser 2s infinite linear;
              }
            `}</style>
            
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <h3 className="text-xs font-black text-gold-400 uppercase tracking-widest flex items-center gap-2">
                <Camera size={16} /> Escanear Código
              </h3>
              <button 
                onClick={handleCloseScanner}
                className="p-1 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center min-h-[250px] relative rounded-2xl bg-slate-950 overflow-hidden border border-slate-800">
              {scannerLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0b0f19]/90 z-10 text-xs text-slate-300">
                  <Loader2 className="animate-spin text-gold-500" size={24} />
                  Iniciando câmera...
                </div>
              )}

              {scannerError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center gap-3 bg-[#0b0f19]/95 z-10 text-xs text-red-400">
                  <AlertTriangle size={24} className="text-red-500" />
                  <p className="font-semibold leading-relaxed">{scannerError}</p>
                  <button 
                    onClick={handleOpenScanner}
                    className="px-3.5 py-1.5 bg-slate-850 hover:bg-slate-800 text-gold-400 rounded-xl font-bold uppercase tracking-wider text-[9px] border border-slate-700/50 cursor-pointer"
                  >
                    Tentar Novamente
                  </button>
                </div>
              )}

              <div id="scanner-reader" className="w-full h-full"></div>

              {/* Laser line overlay animation */}
              {!scannerLoading && !scannerError && (
                <div className="absolute left-0 right-0 top-1/2 h-0.5 bg-red-500/80 shadow-[0_0_8px_#ef4444] animate-laserLine z-10 pointer-events-none"></div>
              )}
            </div>

            <div className="text-center text-[10px] text-slate-400 font-bold leading-relaxed">
              Aponte a câmera traseira do celular para o código de barras do pneu. O sistema irá bipar e carregar o produto na busca.
            </div>
          </div>
        </div>
      )}

      {/* MODAL: BACKUP RESTORE */}
      {showBackupRestoreModal && (
        <div className="fixed inset-0 z-55 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 border border-slate-200 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-1.5">
                <Archive size={20} className="text-gold-600" /> Restauração de Backup
              </h3>
              <button 
                onClick={() => setShowBackupRestoreModal(false)} 
                className="p-1 text-slate-400 hover:text-slate-900 rounded"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 py-4 text-xs text-slate-700">
              <p>
                Restaure os dados de estoque a partir de uma cópia de segurança local ou envie um arquivo JSON de backup.
              </p>

              {/* Action 1: Local Storage Backup */}
              <div className="p-3 border border-slate-200 rounded-xl hover:border-gold-300 transition-all space-y-2">
                <p className="font-bold text-slate-900">1. Cópia de Segurança Local (Local Storage)</p>
                {(() => {
                  const localDataStr = localStorage.getItem(`stock_backup_data_${user.uid}`);
                  if (!localDataStr) {
                    return <span className="text-[10px] text-slate-400 italic">Nenhum backup automático diário encontrado no navegador.</span>;
                  }
                  try {
                    const parsed = JSON.parse(localDataStr);
                    return (
                      <div className="space-y-2">
                        <div className="bg-slate-50 p-2 rounded border text-[10px] space-y-0.5">
                          <p>📅 <strong>Data:</strong> {new Date(parsed.date).toLocaleString()}</p>
                          <p>📦 <strong>Total de Itens:</strong> {parsed.items?.length || 0}</p>
                          <p>👤 <strong>Responsável:</strong> {parsed.userEmail}</p>
                        </div>
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={async () => {
                            if (onRestoreBackup && window.confirm(`Deseja mesmo restaurar ${parsed.items?.length || 0} itens deste backup automático? Isso adicionará os registros ao banco.`)) {
                              setSubmitting(true);
                              try {
                                await onRestoreBackup(parsed.items);
                                setShowBackupRestoreModal(false);
                              } catch (err: any) {
                                alert(err.message);
                              } finally {
                                setSubmitting(false);
                              }
                            }
                          }}
                          className="w-full py-1.5 bg-gold-600 hover:bg-gold-700 text-white font-extrabold rounded-lg text-[10px] uppercase shadow-sm transition-all cursor-pointer"
                        >
                          Restaurar Cópia do Navegador
                        </button>
                      </div>
                    );
                  } catch {
                    return <span className="text-[10px] text-red-500 font-bold">Erro ao processar backup do navegador.</span>;
                  }
                })()}
              </div>

              {/* Action 2: Upload JSON file */}
              <div className="p-3 border border-slate-200 rounded-xl hover:border-gold-300 transition-all space-y-2">
                <p className="font-bold text-slate-900 font-sans">2. Upload de Arquivo de Backup (.json)</p>
                <input
                  type="file"
                  accept=".json"
                  className="w-full text-[10px] file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border file:border-slate-200 file:text-[10px] file:font-black file:bg-slate-50 file:text-slate-700 hover:file:bg-slate-100 cursor-pointer"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const json = JSON.parse(event.target?.result as string);
                        const items = Array.isArray(json) ? json : json.items;
                        if (!Array.isArray(items)) {
                          throw new Error("Formato inválido. O arquivo JSON deve ser um array ou conter uma propriedade 'items'.");
                        }
                        
                        if (onRestoreBackup && window.confirm(`Deseja importar ${items.length} itens do arquivo JSON de backup?`)) {
                          setSubmitting(true);
                          try {
                            await onRestoreBackup(items);
                            setShowBackupRestoreModal(false);
                          } catch (err: any) {
                            alert(err.message);
                          } finally {
                            setSubmitting(false);
                          }
                        }
                      } catch (err: any) {
                        alert("Erro ao ler JSON: " + (err.message || err));
                      }
                    };
                    reader.readAsText(file);
                  }}
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowBackupRestoreModal(false)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl border border-slate-200 transition-all cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
