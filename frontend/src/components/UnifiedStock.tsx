import React, { useState, useMemo } from "react";
import { StockItem, Company } from "../types";
import { Search, Plus, Building2, X, Loader2, Share2, Check, Printer, Image as ImageIcon } from "lucide-react";
import { matchesTireSize, reservedQuantityOf, toMillis } from "../utils";
import PrintableReport, { PrintableReportMeta } from "./PrintableReport";

interface UnifiedStockProps {
  items: StockItem[];
  user: { uid: string; email: string; displayName: string; role: string; companyId?: string; companyName?: string };
  companies: Company[];
  onUpdateItem: (itemId: string, updatedFields: Partial<StockItem>, reason: string, quantityDiff?: number) => Promise<void>;
  onAddItem: (itemData: Omit<StockItem, "id" | "userId" | "userEmail" | "createdAt" | "updatedAt">) => Promise<void>;
  onAddCompany?: (name: string, description?: string) => Promise<void>;
}

interface ConsolidatedItem {
  sku: string;
  description: string; // combined size + brand + model
  brand: string;
  model: string;
  size: string;
  priceCash: number;
  priceInstallment: number;
  docs: Record<string, StockItem>; // Keyed by companyId
}

export default function UnifiedStock({ items, user, companies, onUpdateItem, onAddItem, onAddCompany }: UnifiedStockProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [editingCell, setEditingCell] = useState<{ sku: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [loadingSku, setLoadingSku] = useState("");

  // Add Company Modal State
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyDesc, setNewCompanyDesc] = useState("");
  const [addCompanyLoading, setAddCompanyLoading] = useState(false);

  // Add Product Modal State
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [newProductSku, setNewProductSku] = useState("");
  const [newProductBrand, setNewProductBrand] = useState("");
  const [newProductModel, setNewProductModel] = useState("");
  const [newProductSize, setNewProductSize] = useState("");
  const [newProductPriceCash, setNewProductPriceCash] = useState("");
  const [newProductPriceInst, setNewProductPriceInst] = useState("");
  const [newProductQuantities, setNewProductQuantities] = useState<Record<string, number>>({});
  const [addProductLoading, setAddProductLoading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const reportRef = React.useRef<HTMLDivElement>(null);

  const isAdmin = user.role === "admin";
  const isVendedor = user.role === "vendedor";

  const consolidatedItems = useMemo(() => {
    const map = new Map<string, ConsolidatedItem>();

    items.forEach(item => {
      const key = item.sku;
      if (!map.has(key)) {
        map.set(key, {
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          description: `${item.size} ${item.brand} ${item.model}`.trim(),
          priceCash: item.priceCash || item.price || 0,
          priceInstallment: item.priceInstallment || item.price || 0,
          docs: {}
        });
      }

      const cons = map.get(key)!;
      
      let compId = item.companyId;
      if (!compId && item.companyName) {
        const found = companies.find(c => c.name.toLowerCase() === item.companyName!.toLowerCase());
        if (found) compId = found.id;
      }
      
      if (compId) {
        cons.docs[compId] = item;
      }
      
      if (item.priceCash && item.priceCash > cons.priceCash) cons.priceCash = item.priceCash;
      if (item.priceInstallment && item.priceInstallment > cons.priceInstallment) cons.priceInstallment = item.priceInstallment;
    });

    return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  }, [items, companies]);

  const filteredItems = useMemo(() => {
    if (!searchTerm) return consolidatedItems;
    const lower = searchTerm.toLowerCase();
    return consolidatedItems.filter(item =>
      item.sku.toLowerCase().includes(lower) ||
      item.description.toLowerCase().includes(lower) ||
      item.brand.toLowerCase().includes(lower) ||
      item.size.toLowerCase().includes(lower) ||
      matchesTireSize(item.size, lower)
    );
  }, [consolidatedItems, searchTerm]);

  // Export Unified Stock to CSV
  const exportUnifiedToCSV = () => {
    if (filteredItems.length === 0) return;

    const compHeaders = companies.map(c => c.name.toUpperCase());
    const headers = ["CODIGO", "MEDIDA", "DESCRICAO", ...compHeaders, "P/ A VISTA", "P/ PRAZO"];

    const rows = filteredItems.map(item => {
      const compQty = companies.map(comp => {
        const docItem = item.docs[comp.id];
        return docItem ? docItem.quantity : 0;
      });
      return [
        item.sku,
        item.size,
        `${item.brand} ${item.model}`.trim(),
        ...compQty,
        item.priceCash,
        item.priceInstallment
      ];
    });

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
    link.setAttribute("download", `estoque_unificado_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };


  // ─────────────────────────────────────────────────────────────────
  // Configurador do Relatório (empresa, período, saldo, ordenação)
  // Antes, "Imprimir Relatório" era um window.print() seco: saía sempre o
  // estoque de TODAS as empresas, e o cabeçalho trazia "FILTRO: TODOS |
  // ORDENADO: CÓDIGO" escrito fixo no código, independente do conteúdo.
  // ─────────────────────────────────────────────────────────────────
  const [showReportModal, setShowReportModal] = useState(false);

  // Padrão consciente: o dono da empresa imprime a SUA filial; o admin, todas.
  const defaultReportCompanyIds = useMemo(
    () => (isAdmin || isVendedor
      ? companies.map(c => c.id)
      : companies.filter(c => c.id === user.companyId).map(c => c.id)),
    [companies, isAdmin, isVendedor, user.companyId]
  );

  const [reportCompanyIds, setReportCompanyIds] = useState<string[]>([]);
  const [reportBalance, setReportBalance] = useState<"ALL" | "WITH" | "LOW" | "ZERO">("ALL");
  const [reportBrand, setReportBrand] = useState("");
  const [reportSort, setReportSort] = useState<"SKU" | "BRAND" | "SIZE" | "QTY">("SKU");
  const [reportUseSearch, setReportUseSearch] = useState(true);
  const [reportShowPrices, setReportShowPrices] = useState(true);
  const [reportShowCheckColumn, setReportShowCheckColumn] = useState(true);

  // Mantém a seleção alinhada com a lista real de empresas: ela chega vazia no
  // primeiro render e só preenche quando o snapshot do Firestore responde.
  React.useEffect(() => {
    setReportCompanyIds(prev =>
      prev.length === 0 ? defaultReportCompanyIds : prev.filter(id => companies.some(c => c.id === id))
    );
  }, [defaultReportCompanyIds, companies]);

  const reportCompanies = useMemo(
    () => companies.filter(c => reportCompanyIds.includes(c.id)),
    [companies, reportCompanyIds]
  );

  const availableBrands = useMemo(() => {
    const set = new Set<string>();
    consolidatedItems.forEach(i => { if (i.brand) set.add(i.brand); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [consolidatedItems]);

  // Itens que realmente vão para o papel.
  const reportItems = useMemo(() => {
    const activeCompanyIds = reportCompanyIds;

    // Soma apenas das empresas selecionadas — é isso que sai impresso.
    const qtyIn = (item: ConsolidatedItem) =>
      activeCompanyIds.reduce((acc, id) => acc + (item.docs[id] ? Number(item.docs[id].quantity) || 0 : 0), 0);

    const base = reportUseSearch ? filteredItems : consolidatedItems;

    return base
      // Um produto só entra se existir em alguma das empresas escolhidas — é
      // isso que separa de fato o estoque de cada filial no relatório.
      .filter(item => activeCompanyIds.some(id => !!item.docs[id]))
      .filter(item => !reportBrand || item.brand === reportBrand)
      .filter(item => {
        const total = qtyIn(item);
        if (reportBalance === "WITH") return total > 0;
        if (reportBalance === "LOW") return total > 0 && total <= 4;
        if (reportBalance === "ZERO") return total === 0;
        return true;
      })
      .sort((a, b) => {
        if (reportSort === "BRAND") return (a.brand || "").localeCompare(b.brand || "") || a.sku.localeCompare(b.sku);
        if (reportSort === "SIZE") return (a.size || "").localeCompare(b.size || "") || a.sku.localeCompare(b.sku);
        if (reportSort === "QTY") return qtyIn(b) - qtyIn(a) || a.sku.localeCompare(b.sku);
        return a.sku.localeCompare(b.sku);
      });
  }, [filteredItems, consolidatedItems, reportUseSearch, reportCompanyIds, reportBrand, reportBalance, reportSort]);

  const reportTotalUnits = useMemo(
    () => reportItems.reduce((acc, item) =>
      acc + reportCompanyIds.reduce((sum, id) => sum + (item.docs[id] ? Number(item.docs[id].quantity) || 0 : 0), 0), 0),
    [reportItems, reportCompanyIds]
  );

  // Texto do cabeçalho impresso — descreve exatamente o que foi filtrado.
  const reportMeta = useMemo(() => {
    const balanceLabel =
      reportBalance === "WITH" ? "SOMENTE COM SALDO"
      : reportBalance === "LOW" ? "SOMENTE CRÍTICOS (ATÉ 4 UN)"
      : reportBalance === "ZERO" ? "SOMENTE ZERADOS"
      : "TODOS OS SALDOS";

    const sortLabel =
      reportSort === "BRAND" ? "MARCA"
      : reportSort === "SIZE" ? "MEDIDA"
      : reportSort === "QTY" ? "QUANTIDADE"
      : "CÓDIGO";

    const brandLabel = reportBrand ? ` | MARCA: ${reportBrand.toUpperCase()}` : "";

    const companyLine = reportCompanies.length === 0
      ? "NENHUMA EMPRESA SELECIONADA"
      : reportCompanies.length === companies.length && companies.length > 1
        ? `TODAS AS EMPRESAS (${companies.length})`
        : reportCompanies.map(c => c.name).join(" • ");

    return {
      title: "Listagem de Produtos em Estoque",
      companyLine: companyLine.toUpperCase(),
      addressLine: reportCompanies.length === 1 ? (reportCompanies[0].description || "") : "",
      scopeLine: `SALDO: ${balanceLabel} | ORDENADO POR: ${sortLabel}${brandLabel}`,
      searchLine: reportUseSearch && searchTerm ? searchTerm.toUpperCase() : "",
      generatedBy: user.displayName,
      showPrices: reportShowPrices,
      showCheckColumn: reportShowCheckColumn
    };
  }, [reportBalance, reportSort, reportBrand, reportCompanies, companies, reportUseSearch, searchTerm, user.displayName, reportShowPrices, reportShowCheckColumn]);

  const openReportModal = () => {
    if (reportCompanyIds.length === 0) setReportCompanyIds(defaultReportCompanyIds);
    setShowReportModal(true);
  };

  const toggleReportCompany = (companyId: string) => {
    setReportCompanyIds(prev =>
      prev.includes(companyId) ? prev.filter(id => id !== companyId) : [...prev, companyId]
    );
  };


  // Planilha do relatório configurado: mesmas linhas e mesmas colunas de empresa
  // que saem no papel. Diferente do "Exportar Planilha" da barra, que é um
  // atalho para a tela inteira com todas as empresas.
  const exportReportToCSV = () => {
    if (reportItems.length === 0 || reportCompanies.length === 0) return;

    const headers = [
      "CODIGO", "MEDIDA", "DESCRICAO",
      ...reportCompanies.map(c => c.name.toUpperCase()),
      "TOTAL",
      ...(reportShowPrices ? ["P/ A VISTA", "P/ PRAZO"] : [])
    ];

    const rows = reportItems.map(item => {
      const quantities = reportCompanies.map(c => (item.docs[c.id] ? Number(item.docs[c.id].quantity) || 0 : 0));
      const total = quantities.reduce((acc, q) => acc + q, 0);
      return [
        item.sku,
        item.size,
        `${item.brand} ${item.model}`.trim(),
        ...quantities,
        total,
        ...(reportShowPrices ? [item.priceCash, item.priceInstallment] : [])
      ];
    });

    const csvContent = [
      `"RELATORIO: ${reportMeta.companyLine}"`,
      `"${reportMeta.scopeLine}"`,
      "",
      headers.join(";"),
      ...rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(";"))
    ].join("\n");

    const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `relatorio_estoque_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Fecha o modal antes de imprimir e dá um frame para o React repintar o
  // relatório oculto com a configuração atual.
  const handlePrint = () => {
    setShowReportModal(false);
    setTimeout(() => window.print(), 250);
  };


  const handleExportImage = async () => {
    if (!reportRef.current) return;
    setIsExporting(true);
    try {
      // Dynamic import to avoid bloating initial bundle
      const html2canvas = (await import("html2canvas")).default;
      
      const canvas = await html2canvas(reportRef.current, {
        scale: 2, // Higher quality
        useCORS: true,
        backgroundColor: "#ffffff",
      });
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `estoque_unificado_${new Date().toISOString().slice(0,10)}.png`;
      link.click();
    } catch (err) {
      console.error("Erro ao gerar imagem", err);
      alert("Não foi possível gerar a imagem.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyPublicLink = async () => {
    try {
      const publicUrl = window.location.origin + "/consulta";
      await navigator.clipboard.writeText(publicUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 3000);
    } catch (err) {
      alert("Erro ao copiar o link. Tente copiar manualmente: " + window.location.origin + "/consulta");
    }
  };

  const canEditCompany = (colCompanyId: string) => {
    if (isVendedor) return false;
    if (isAdmin) return true;
    return user.companyId === colCompanyId;
  };

  const startEdit = (item: ConsolidatedItem, field: string, currentValue: string) => {
    if (isVendedor) return;
    
    const isCompanyField = companies.some(c => c.id === field);
    if (isCompanyField && !canEditCompany(field)) return;
    if ((field === "priceCash" || field === "priceInstallment") && !isAdmin && !companies.some(c => canEditCompany(c.id))) {
      return;
    }

    setEditingCell({ sku: item.sku, field });
    setEditValue(currentValue);
  };

  const handleSaveEdit = async (item: ConsolidatedItem) => {
    if (!editingCell) return;
    setLoadingSku(item.sku);
    
    try {
      const field = editingCell.field;
      const rawValue = editValue.trim();
      const isTextField = ["sku", "brand", "model", "size"].includes(field);

      const targetCompany = companies.find(c => c.id === field);

      if (targetCompany) {
        const numValue = parseFloat(rawValue.replace(",", ".")) || 0;
        const existingDoc = item.docs[field];
        if (existingDoc) {
          const diff = numValue - existingDoc.quantity;
          if (diff !== 0) {
            // Baixar abaixo do que está reservado para uma transferência aprovada
            // é recusado em App.tsx (e pelas regras do Firestore). Avisa antes de
            // gastar uma ida ao banco, com a conta já feita.
            const reserved = reservedQuantityOf(existingDoc);
            if (reserved > 0 && numValue < reserved) {
              throw new Error(
                `${reserved} un deste pneu estão reservadas para uma transferência aprovada em ` +
                `${targetCompany.name}. O saldo não pode ficar abaixo disso — libere a reserva na aba Transferências.`
              );
            }
            const reason = diff > 0 ? "Ajuste manual de entrada" : "Baixa manual";
            await onUpdateItem(existingDoc.id, { quantity: numValue }, reason, diff);
          }
        } else {
          if (numValue > 0) {
            await onAddItem({
              sku: item.sku,
              brand: item.brand,
              model: item.model,
              size: item.size,
              description: `${item.size} ${item.brand} ${item.model}`.trim(),
              imageUrl: "",
              priceCash: item.priceCash,
              priceInstallment: item.priceInstallment,
              quantity: numValue,
              notes: "Criado via planilha unificada",
              companyId: targetCompany.id,
              companyName: targetCompany.name
            });
          }
        }
      } else if (field === "priceCash" || field === "priceInstallment") {
        const numValue = parseFloat(rawValue.replace(",", ".")) || 0;
        for (const comp of companies) {
          if (canEditCompany(comp.id) && item.docs[comp.id]) {
            const docToUpdate = item.docs[comp.id];
            if (docToUpdate[field as keyof StockItem] !== numValue) {
              await onUpdateItem(docToUpdate.id, { [field]: numValue }, "Atualização de Preço", 0);
            }
          }
        }
      } else if (isTextField) {
        if (rawValue) {
          for (const comp of companies) {
            if (canEditCompany(comp.id) && item.docs[comp.id]) {
              const docToUpdate = item.docs[comp.id];
              const updatedFields: Partial<StockItem> = { [field]: rawValue };
              
              const newBrand = field === "brand" ? rawValue : docToUpdate.brand;
              const newModel = field === "model" ? rawValue : docToUpdate.model;
              const newSize  = field === "size" ? rawValue : docToUpdate.size;
              updatedFields.description = `${newSize} ${newBrand} ${newModel}`.trim();

              if (docToUpdate[field as keyof StockItem] !== rawValue) {
                await onUpdateItem(docToUpdate.id, updatedFields, `Edição de ${field.toUpperCase()}`, 0);
              }
            }
          }
        }
      }
    } catch (err: any) {
      // A trava de reserva explica exatamente por que a baixa foi recusada:
      // engolir a mensagem aqui deixaria o operador sem saber o que fazer.
      alert(err?.message || "Erro ao salvar alteração.");
    }

    setEditingCell(null);
    setLoadingSku("");
  };

  const handleKeyDown = (e: React.KeyboardEvent, item: ConsolidatedItem) => {
    if (e.key === "Enter") {
      handleSaveEdit(item);
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  // Save New Company (adds a new column)
  const handleSaveNewCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAddCompany || !newCompanyName.trim()) return;
    setAddCompanyLoading(true);
    try {
      await onAddCompany(newCompanyName.trim(), newCompanyDesc.trim());
      alert("Coluna (Empresa) adicionada com sucesso!");
      setShowAddCompanyModal(false);
      setNewCompanyName("");
      setNewCompanyDesc("");
    } catch (err: any) {
      alert(err.message || "Erro ao adicionar empresa.");
    } finally {
      setAddCompanyLoading(false);
    }
  };

  // Save New Product (adds rows)
  const handleSaveNewProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductBrand.trim() || !newProductModel.trim()) {
      alert("Preencha a marca e o modelo.");
      return;
    }

    setAddProductLoading(true);
    try {
      let sku = newProductSku.trim();
      if (!sku) {
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        sku = `PNEU-${randomSuffix}`;
      }

      const skuExists = consolidatedItems.some(i => i.sku.toLowerCase() === sku.toLowerCase());
      if (skuExists) {
        throw new Error(`O código/SKU "${sku}" já está cadastrado no sistema.`);
      }

      const brand = newProductBrand.trim();
      const model = newProductModel.trim();
      const size = newProductSize.trim() || "—";
      const priceCash = parseFloat(newProductPriceCash) || 0;
      const priceInstallment = parseFloat(newProductPriceInst) || priceCash || 0;

      let addedAtLeastOne = false;
      for (const comp of companies) {
        if (!canEditCompany(comp.id)) continue; // defense in depth — the form only renders inputs for these anyway
        const quantity = newProductQuantities[comp.id] || 0;
        if (quantity > 0) {
          await onAddItem({
            sku,
            brand,
            model,
            size,
            quantity,
            price: priceCash,
            priceCash,
            priceInstallment,
            notes: "Cadastrado via planilha geral",
            description: `${size} ${brand} ${model}`.trim(),
            imageUrl: "",
            companyId: comp.id,
            companyName: comp.name
          });
          addedAtLeastOne = true;
        }
      }

      if (!addedAtLeastOne && companies.length > 0) {
        // Zero-stock placeholder registration (no quantity entered anywhere) — must
        // land in a company this user is actually allowed to write to, not just
        // whichever company happens to be first in the list.
        const firstComp = companies.find(c => canEditCompany(c.id)) || companies[0];
        await onAddItem({
          sku,
          brand,
          model,
          size,
          quantity: 0,
          price: priceCash,
          priceCash,
          priceInstallment,
          notes: "Cadastrado com estoque zero",
          description: `${size} ${brand} ${model}`.trim(),
          imageUrl: "",
          companyId: firstComp.id,
          companyName: firstComp.name
        });
      }

      alert("Produto adicionado ao estoque unificado!");
      setShowAddProductModal(false);
      
      setNewProductSku("");
      setNewProductBrand("");
      setNewProductModel("");
      setNewProductSize("");
      setNewProductPriceCash("");
      setNewProductPriceInst("");
      setNewProductQuantities({});
    } catch (err: any) {
      alert(err.message || "Erro ao adicionar produto.");
    } finally {
      setAddProductLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-5">
      
      {/* Header section with search and actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Search Input */}
        <div className="flex items-center border border-slate-200 px-3 py-2 rounded-xl max-w-md w-full focus-within:ring-2 focus-within:ring-gold-500/20 focus-within:border-gold-500 transition-all">
          <Search size={16} className="text-slate-400 mr-2" />
          <input 
            type="text" 
            placeholder="Pesquisar por SKU, modelo, marca ou medida..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full outline-none text-xs text-slate-800 bg-transparent font-semibold"
          />
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {(isAdmin || isVendedor) && (
            <button
              type="button"
              onClick={handleCopyPublicLink}
              className={`flex items-center gap-1.5 px-4 py-2 border font-bold rounded-xl text-xs shadow-sm transition-all cursor-pointer ${copiedLink ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-800 hover:bg-slate-900 text-white border-slate-800'}`}
            >
              {copiedLink ? <Check size={14} className="stroke-[3px]" /> : <Share2 size={14} />} 
              {copiedLink ? "Copiado!" : "Copiar Link Catálogo"}
            </button>
          )}

          <button
            type="button"
            onClick={exportUnifiedToCSV}
            disabled={filteredItems.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50"
          >
            <Building2 size={14} className="text-emerald-600" /> Exportar Planilha
          </button>
          
          <button
            type="button"
            onClick={handleExportImage}
            disabled={reportItems.length === 0 || reportCompanies.length === 0 || isExporting}
            className="flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50"
          >
            {isExporting ? <Loader2 size={14} className="animate-spin text-purple-600" /> : <ImageIcon size={14} className="text-purple-600" />} 
            {isExporting ? "Gerando..." : "Exportar Imagem"}
          </button>

          <button
            type="button"
            onClick={openReportModal}
            disabled={consolidatedItems.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50"
          >
            <Printer size={14} className="text-blue-600" /> Imprimir Relatório
          </button>

          {(!isVendedor) && (
            <button
              onClick={() => {
                setNewProductSku("");
                setNewProductBrand("");
                setNewProductModel("");
                setNewProductSize("");
                setNewProductPriceCash("");
                setNewProductPriceInst("");
                setNewProductQuantities({});
                setShowAddProductModal(true);
              }}
              className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white font-extrabold rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer"
            >
              <Plus size={14} className="stroke-[3px]" /> Adicionar Produto
            </button>
          )}

          {isAdmin && onAddCompany && (
            <button
              onClick={() => {
                setNewCompanyName("");
                setNewCompanyDesc("");
                setShowAddCompanyModal(true);
              }}
              className="flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold rounded-xl text-xs shadow-sm hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer"
            >
              <Building2 size={14} /> Adicionar Empresa (Coluna)
            </button>
          )}
        </div>
      </div>

      {/* Unified Stock Table - Desktop View */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full border-collapse text-left text-sm font-sans text-slate-850">
          <thead className="bg-slate-50 text-slate-450 text-[10px] uppercase tracking-wider font-extrabold border-b border-slate-200">
            <tr>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>CODIGO</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>MEDIDA</th>
              <th className="border-r border-slate-200 px-2 py-3" rowSpan={2}>DESCRIÇÃO</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" colSpan={companies.length}>QUANTIDADE</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>P/ A VISTA</th>
              <th className="px-2 py-3 text-center" rowSpan={2}>P/PRAZO</th>
            </tr>
            <tr className="border-t border-slate-200">
              {companies.map(comp => (
                <th key={comp.id} className="border-r border-slate-200 px-1 py-2 text-center text-[9px] min-w-[70px]">{comp.name.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {filteredItems.map((item) => {
              const isProcessing = loadingSku === item.sku;
              return (
                <tr key={item.sku} className={`hover:bg-gold-50/5 text-slate-800 transition-colors ${isProcessing ? "opacity-50" : ""}`}>
                  <td 
                    className="border-r border-slate-200 px-2 py-3 text-center font-bold text-slate-900 whitespace-nowrap cursor-pointer hover:bg-gold-400/10 text-xs"
                    onClick={() => !isVendedor && startEdit(item, "sku", item.sku)}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "sku" ? (
                      <input 
                        autoFocus
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-24 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                      />
                    ) : (
                      item.sku
                    )}
                  </td>
                  <td 
                    className="border-r border-slate-200 px-2 py-3 text-center whitespace-nowrap cursor-pointer hover:bg-slate-50"
                    onClick={() => !isVendedor && startEdit(item, "size", item.size)}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "size" ? (
                      <input 
                        autoFocus
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-24 px-1 text-center outline-none bg-white border border-sky-400 rounded font-bold"
                      />
                    ) : (
                      <span className="inline-block px-2.5 py-1 bg-sky-50 text-sky-700 border border-sky-200/80 rounded-lg font-extrabold text-[13px] tracking-wide shadow-sm font-sans">
                        {item.size}
                      </span>
                    )}
                  </td>
                  <td className="border-r border-slate-200 px-2 py-3 font-semibold text-slate-700 min-w-[150px] text-xs">
                    <span 
                      className="cursor-pointer hover:bg-gold-400/10 px-1.5 py-0.5 rounded"
                      onClick={() => !isVendedor && startEdit(item, "brand", item.brand)}
                    >
                      {editingCell?.sku === item.sku && editingCell?.field === "brand" ? (
                        <input 
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveEdit(item)}
                          onKeyDown={(e) => handleKeyDown(e, item)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 px-1 outline-none bg-white border border-gold-400 rounded font-bold"
                        />
                      ) : (
                        item.brand
                      )}
                    </span>
                    {" "}
                    <span 
                      className="font-normal text-slate-600 cursor-pointer hover:bg-gold-400/10 px-1.5 py-0.5 rounded"
                      onClick={() => !isVendedor && startEdit(item, "model", item.model)}
                    >
                      {editingCell?.sku === item.sku && editingCell?.field === "model" ? (
                        <input 
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveEdit(item)}
                          onKeyDown={(e) => handleKeyDown(e, item)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-32 px-1 outline-none bg-white border border-gold-400 rounded font-normal"
                        />
                      ) : (
                        item.model
                      )}
                    </span>
                  </td>
                  
                  {/* Quantity Cells */}
                  {companies.map(comp => {
                    const docItem = item.docs[comp.id];
                    const qty = docItem ? docItem.quantity : 0;
                    const isEditing = editingCell?.sku === item.sku && editingCell?.field === comp.id;
                    const editable = canEditCompany(comp.id);

                    return (
                      <td 
                        key={comp.id} 
                        className={`border-r border-slate-200 px-1 py-3 text-center ${editable ? "cursor-pointer hover:bg-gold-400/10" : "bg-slate-50/30"}`}
                        onClick={() => editable && startEdit(item, comp.id, qty.toString())}
                      >
                        {isEditing ? (
                          <input 
                            autoFocus
                            type="number"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => handleSaveEdit(item)}
                            onKeyDown={(e) => handleKeyDown(e, item)}
                            className="w-16 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                          />
                        ) : (
                          qty ? (
                            <span className={`inline-block px-2 py-0.5 rounded-lg border font-black text-xs ${qty > 5 ? "bg-gold-500/10 text-gold-700 border-gold-400/20" : "bg-amber-100/60 text-amber-800 border-amber-300/30"}`}>
                              {qty} un
                            </span>
                          ) : (
                            <span className="text-slate-300 font-bold">—</span>
                          )
                        )}
                      </td>
                    );
                  })}

                  {/* Price Cash */}
                  <td 
                    className={`border-r border-slate-200 px-2 py-3 text-center font-bold text-slate-900 text-xs whitespace-nowrap ${(!isVendedor) ? "cursor-pointer hover:bg-gold-400/10" : ""}`}
                    onClick={() => startEdit(item, "priceCash", item.priceCash.toString())}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "priceCash" ? (
                      <input 
                        autoFocus
                        type="number"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        className="w-20 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                      />
                    ) : (
                      item.priceCash > 0 ? `R$ ${item.priceCash.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>
                    )}
                  </td>

                  {/* Price Installment */}
                  <td 
                    className={`px-2 py-3 text-center font-bold text-slate-900 text-xs whitespace-nowrap ${(!isVendedor) ? "cursor-pointer hover:bg-gold-400/10" : ""}`}
                    onClick={() => startEdit(item, "priceInstallment", item.priceInstallment.toString())}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "priceInstallment" ? (
                      <input 
                        autoFocus
                        type="number"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        className="w-20 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                      />
                    ) : (
                      item.priceInstallment > 0 ? `R$ ${item.priceInstallment.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={6 + companies.length} className="p-8 text-center text-slate-400 font-semibold">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Unified Stock - Mobile Card View */}
      <div className="block md:hidden space-y-4">
        {filteredItems.map((item) => {
          const isProcessing = loadingSku === item.sku;
          return (
            <div 
              key={item.sku} 
              className={`bg-slate-50/40 rounded-2xl p-4 border border-slate-200 shadow-xs space-y-3 relative transition-all ${isProcessing ? "opacity-50" : ""}`}
            >
              {/* Product Info */}
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  {/* SKU / Code */}
                  <span 
                    onClick={() => !isVendedor && startEdit(item, "sku", item.sku)}
                    className="inline-block px-2.5 py-0.5 text-gold-700 bg-gold-400/10 rounded-lg border border-gold-500/20 font-mono tracking-wider font-extrabold uppercase text-[10px] shadow-xs cursor-pointer hover:bg-gold-400/20"
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "sku" ? (
                      <input 
                        autoFocus
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-20 px-1 outline-none bg-white border border-gold-400 rounded font-bold text-[10px]"
                      />
                    ) : (
                      item.sku
                    )}
                  </span>
                  
                  {/* Size, Brand, Model */}
                  <h4 className="font-bold text-slate-900 uppercase text-xs mt-1">
                    {/* Size (Medida) */}
                    <span 
                      onClick={() => !isVendedor && startEdit(item, "size", item.size)}
                      className="text-gold-600 font-extrabold mr-1.5 cursor-pointer hover:bg-gold-400/10 px-0.5 rounded"
                    >
                      {editingCell?.sku === item.sku && editingCell?.field === "size" ? (
                        <input 
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveEdit(item)}
                          onKeyDown={(e) => handleKeyDown(e, item)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 px-1 outline-none bg-white border border-gold-400 rounded font-bold text-xs"
                        />
                      ) : (
                        item.size
                      )}
                    </span>
                    
                    {/* Brand */}
                    <span 
                      onClick={() => !isVendedor && startEdit(item, "brand", item.brand)}
                      className="cursor-pointer hover:bg-gold-400/10 px-0.5 rounded mr-1"
                    >
                      {editingCell?.sku === item.sku && editingCell?.field === "brand" ? (
                        <input 
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveEdit(item)}
                          onKeyDown={(e) => handleKeyDown(e, item)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 px-1 outline-none bg-white border border-gold-400 rounded font-bold text-xs"
                        />
                      ) : (
                        item.brand
                      )}
                    </span>

                    {/* Model */}
                    <span 
                      onClick={() => !isVendedor && startEdit(item, "model", item.model)}
                      className="font-normal text-slate-650 cursor-pointer hover:bg-gold-400/10 px-0.5 rounded"
                    >
                      {editingCell?.sku === item.sku && editingCell?.field === "model" ? (
                        <input 
                          autoFocus
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveEdit(item)}
                          onKeyDown={(e) => handleKeyDown(e, item)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-24 px-1 outline-none bg-white border border-gold-400 rounded font-normal text-xs"
                        />
                      ) : (
                        item.model
                      )}
                    </span>
                  </h4>
                </div>
              </div>

              {/* Quantities Section */}
              <div className="border-t border-slate-150/60 pt-3 space-y-2">
                <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">Quantidades</span>
                <div className="grid grid-cols-2 gap-2">
                  {companies.map(comp => {
                    const docItem = item.docs[comp.id];
                    const qty = docItem ? docItem.quantity : 0;
                    const isEditing = editingCell?.sku === item.sku && editingCell?.field === comp.id;
                    const editable = canEditCompany(comp.id);

                    return (
                      <div 
                        key={comp.id} 
                        className={`p-2 rounded-xl border border-slate-200/80 flex flex-col justify-center items-center text-center ${editable ? "cursor-pointer hover:bg-gold-400/10 bg-white" : "bg-slate-100/50"}`}
                        onClick={() => editable && startEdit(item, comp.id, qty.toString())}
                      >
                        <span className="text-[8px] text-slate-500 font-bold block truncate max-w-full uppercase">{comp.name}</span>
                        {isEditing ? (
                          <input 
                            autoFocus
                            type="number"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => handleSaveEdit(item)}
                            onKeyDown={(e) => handleKeyDown(e, item)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-16 px-1 mt-1 text-center outline-none bg-white border border-gold-400 rounded font-bold text-xs"
                          />
                        ) : (
                          <span className={`mt-1 font-black text-xs ${qty > 0 ? "text-gold-700 font-black" : "text-slate-300"}`}>
                            {qty ? `${qty} un` : "—"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Prices Section */}
              <div className="border-t border-slate-150/60 pt-3 grid grid-cols-2 gap-2">
                {/* Price Cash */}
                <div 
                  className={`p-2 rounded-xl border border-slate-200/80 text-center ${(!isVendedor) ? "cursor-pointer hover:bg-gold-400/10 bg-white" : "bg-slate-100/50"}`}
                  onClick={() => (!isVendedor) && startEdit(item, "priceCash", item.priceCash.toString())}
                >
                  <span className="text-[8px] text-slate-500 font-bold block uppercase">À Vista</span>
                  {editingCell?.sku === item.sku && editingCell?.field === "priceCash" ? (
                    <input 
                      autoFocus
                      type="number"
                      step="0.01"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSaveEdit(item)}
                      onKeyDown={(e) => handleKeyDown(e, item)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-20 px-1 mt-1 text-center outline-none bg-white border border-gold-400 rounded font-bold text-xs"
                    />
                  ) : (
                    <span className="mt-0.5 block font-black text-xs text-emerald-700">
                      {item.priceCash > 0 ? `R$ ${item.priceCash.toFixed(2).replace(".", ",")}` : "—"}
                    </span>
                  )}
                </div>

                {/* Price Installment */}
                <div 
                  className={`p-2 rounded-xl border border-slate-200/80 text-center ${(!isVendedor) ? "cursor-pointer hover:bg-gold-400/10 bg-white" : "bg-slate-100/50"}`}
                  onClick={() => (!isVendedor) && startEdit(item, "priceInstallment", item.priceInstallment.toString())}
                >
                  <span className="text-[8px] text-slate-500 font-bold block uppercase">A Prazo</span>
                  {editingCell?.sku === item.sku && editingCell?.field === "priceInstallment" ? (
                    <input 
                      autoFocus
                      type="number"
                      step="0.01"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSaveEdit(item)}
                      onKeyDown={(e) => handleKeyDown(e, item)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-20 px-1 mt-1 text-center outline-none bg-white border border-gold-400 rounded font-bold text-xs"
                    />
                  ) : (
                    <span className="mt-0.5 block font-black text-xs text-slate-900">
                      {item.priceInstallment > 0 ? `R$ ${item.priceInstallment.toFixed(2).replace(".", ",")}` : "—"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filteredItems.length === 0 && (
          <div className="p-8 text-center text-slate-400 font-semibold bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
            Nenhum registro encontrado.
          </div>
        )}
      </div>
      
      <div className="text-[10px] text-slate-400 font-semibold leading-relaxed">
        💡 Dica: Clique em qualquer célula de quantidade ou preço para editar o valor diretamente na planilha e pressione <kbd className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Enter</kbd> para salvar (Alimentadores e Administradores).
      </div>

      {/* ADD COMPANY MODAL */}
      {showAddCompanyModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Building2 size={16} className="text-gold-600" /> Adicionar Nova Empresa (Coluna)
              </h3>
              <button 
                onClick={() => setShowAddCompanyModal(false)}
                className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSaveNewCompany} className="space-y-4">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Nome da Empresa / Filial *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: SAJ PNEUS, CENTRAL AUTOCAR"
                  value={newCompanyName}
                  onChange={(e) => setNewCompanyName(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Descrição (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Filial Santo Antônio de Jesus"
                  value={newCompanyDesc}
                  onChange={(e) => setNewCompanyDesc(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                />
              </div>

              <div className="text-[10px] text-slate-400 font-semibold leading-relaxed">
                💡 Nota: Ao adicionar uma empresa, ela aparecerá automaticamente como uma nova coluna de quantidade na planilha de estoque unificado.
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddCompanyModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={addCompanyLoading}
                  className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5"
                >
                  {addCompanyLoading && <Loader2 size={12} className="animate-spin" />}
                  Adicionar Coluna
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADD PRODUCT MODAL */}
      {showAddProductModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full border border-slate-200 shadow-2xl space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Plus size={16} className="text-gold-600" /> Adicionar Novo Produto ao Estoque
              </h3>
              <button 
                onClick={() => setShowAddProductModal(false)}
                className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSaveNewProduct} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Código / SKU (Opcional)
                  </label>
                  <input
                    type="text"
                    placeholder="Gerado automaticamente se em branco"
                    value={newProductSku}
                    onChange={(e) => setNewProductSku(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Medida (Ex: 205/55R16)
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: 205/55R16 ou —"
                    value={newProductSize}
                    onChange={(e) => setNewProductSize(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Marca *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: PIRELLI, MICHELIN, XBRI"
                    value={newProductBrand}
                    onChange={(e) => setNewProductBrand(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Modelo / Descrição *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: CINTURATO P7, RODA AR25"
                    value={newProductModel}
                    onChange={(e) => setNewProductModel(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Preço à Vista (R$) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="0.00"
                    value={newProductPriceCash}
                    onChange={(e) => setNewProductPriceCash(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                    Preço a Prazo (R$)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Igual ao valor à vista se em branco"
                    value={newProductPriceInst}
                    onChange={(e) => setNewProductPriceInst(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  />
                </div>
              </div>

              <div className="border-t border-slate-100 pt-3">
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">
                  Quantidades Iniciais por Empresa / Filial
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[160px] overflow-y-auto pr-1">
                  {/* Only companies this user is allowed to write to — a dono/alimentador
                      can only stock their own filial, admin can seed any of them. */}
                  {companies.filter(comp => canEditCompany(comp.id)).map(comp => (
                    <div key={comp.id} className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 bg-slate-50/50">
                      <span className="text-xs font-bold text-slate-700 truncate max-w-[140px]" title={comp.name}>
                        {comp.name}
                      </span>
                      <input
                        type="number"
                        min="0"
                        placeholder="0"
                        value={newProductQuantities[comp.id] || ""}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setNewProductQuantities(prev => ({ ...prev, [comp.id]: val }));
                        }}
                        className="w-20 px-2 py-1 text-xs border border-slate-200 rounded-lg text-center font-bold bg-white outline-none focus:border-gold-500"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddProductModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={addProductLoading}
                  className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5"
                >
                  {addProductLoading && <Loader2 size={12} className="animate-spin" />}
                  Adicionar Produto
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* ═══════════ CONFIGURADOR DO RELATÓRIO ═══════════ */}
      {showReportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-fadeIn print:hidden">
          <div className="bg-white rounded-3xl max-w-2xl w-full border border-slate-200 shadow-2xl my-8 flex flex-col max-h-[92vh]">

            <div className="flex items-center justify-between border-b border-slate-100 p-5 shrink-0">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <Printer size={16} className="text-blue-600" /> Configurar Relatório de Estoque
              </h3>
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">

              {/* Empresas */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                    Empresas no relatório *
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setReportCompanyIds(companies.map(c => c.id))}
                      className="text-[10px] font-black text-gold-700 hover:underline cursor-pointer uppercase tracking-wider"
                    >
                      Todas
                    </button>
                    {user.companyId && (
                      <button
                        type="button"
                        onClick={() => setReportCompanyIds(companies.filter(c => c.id === user.companyId).map(c => c.id))}
                        className="text-[10px] font-black text-gold-700 hover:underline cursor-pointer uppercase tracking-wider"
                      >
                        Só a minha
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto p-1">
                  {companies.length === 0 ? (
                    <p className="text-xs text-slate-400 font-semibold col-span-2 py-2">Nenhuma empresa cadastrada.</p>
                  ) : companies.map(c => {
                    const checked = reportCompanyIds.includes(c.id);
                    const isMine = c.id === user.companyId;
                    return (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => toggleReportCompany(c.id)}
                        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          checked ? "border-gold-500 bg-gold-50/50 shadow-xs" : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <span className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                          checked ? "bg-gold-600 border-gold-600 text-white" : "border-slate-300 bg-white"
                        }`}>
                          {checked && <Check size={11} className="stroke-[3.5px]" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-bold text-slate-800 truncate">{c.name}</span>
                          {isMine && <span className="block text-[9px] font-black text-gold-700 uppercase tracking-wider">Sua empresa</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-400 font-semibold mt-1.5">
                  Cada empresa marcada vira uma coluna de quantidade. Produtos que não existem em nenhuma
                  das empresas marcadas ficam de fora.
                </p>
              </div>

              {/* Saldo / Marca / Ordenação */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Saldo</label>
                  <select
                    value={reportBalance}
                    onChange={e => setReportBalance(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-bold cursor-pointer"
                  >
                    <option value="ALL">Todos os saldos</option>
                    <option value="WITH">Somente com saldo</option>
                    <option value="LOW">Somente críticos (até 4 un)</option>
                    <option value="ZERO">Somente zerados</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Marca</label>
                  <select
                    value={reportBrand}
                    onChange={e => setReportBrand(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-bold cursor-pointer"
                  >
                    <option value="">Todas as marcas</option>
                    {availableBrands.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Ordenar por</label>
                  <select
                    value={reportSort}
                    onChange={e => setReportSort(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-bold cursor-pointer"
                  >
                    <option value="SKU">Código (SKU)</option>
                    <option value="BRAND">Marca</option>
                    <option value="SIZE">Medida</option>
                    <option value="QTY">Quantidade (maior primeiro)</option>
                  </select>
                </div>
              </div>

              {/* Opções do documento */}
              <div className="space-y-2 border-t border-slate-100 pt-4">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider block">Opções do documento</label>

                {searchTerm && (
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={reportUseSearch}
                      onChange={e => setReportUseSearch(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-gold-600 focus:ring-gold-500 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-slate-600">
                      Aplicar a busca da tela (<span className="font-mono text-slate-800">{searchTerm}</span>)
                    </span>
                  </label>
                )}

                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={reportShowPrices}
                    onChange={e => setReportShowPrices(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-gold-600 focus:ring-gold-500 cursor-pointer"
                  />
                  <span className="text-xs font-bold text-slate-600">Incluir coluna de preço</span>
                </label>

                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={reportShowCheckColumn}
                    onChange={e => setReportShowCheckColumn(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-gold-600 focus:ring-gold-500 cursor-pointer"
                  />
                  <span className="text-xs font-bold text-slate-600">
                    Incluir coluna em branco para conferência física
                  </span>
                </label>
              </div>
            </div>

            {/* Rodapé: prévia do que vai sair + ação */}
            <div className="border-t border-slate-100 p-5 shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-black text-slate-900">
                  {reportItems.length} {reportItems.length === 1 ? "produto" : "produtos"} • {reportTotalUnits} un
                </p>
                <p className="text-[10px] font-bold text-slate-400 truncate">
                  {reportCompanies.length === 0
                    ? "Selecione ao menos uma empresa"
                    : reportCompanies.map(c => c.name).join(" • ")}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowReportModal(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={exportReportToCSV}
                  disabled={reportItems.length === 0 || reportCompanies.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-black uppercase tracking-wider hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Building2 size={14} className="text-emerald-600" /> Planilha
                </button>
                <button
                  type="button"
                  onClick={handleExportImage}
                  disabled={reportItems.length === 0 || reportCompanies.length === 0 || isExporting}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-black uppercase tracking-wider hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-40"
                >
                  {isExporting ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} className="text-purple-600" />}
                  Imagem
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  disabled={reportItems.length === 0 || reportCompanies.length === 0}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer hover:scale-[1.01] disabled:opacity-40 disabled:hover:scale-100"
                >
                  <Printer size={14} /> Imprimir
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Relatorio oculto: e ele que o window.print() e o html2canvas capturam.
          Renderiza sempre a configuracao resolvida acima, nunca a tela inteira. */}
      <PrintableReport
        ref={reportRef}
        items={reportItems}
        companies={reportCompanies}
        meta={reportMeta as PrintableReportMeta}
      />
    </div>
  );
}
