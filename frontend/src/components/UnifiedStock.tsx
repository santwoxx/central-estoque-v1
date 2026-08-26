import React, { useState, useMemo } from "react";
import { StockItem, Company, StockFlowType, StockFlowPayload, StockFlowResult } from "../types";
import {
  Search, Plus, Minus, Building2, X, Loader2, Share2, Check, Printer, Image as ImageIcon,
  PackagePlus, PackageMinus, AlertTriangle, CheckCircle2, ArrowRight, ArrowRightLeft, Lock
} from "lucide-react";
import { availableQuantity, formatBRL, matchesTireSize, parsePriceInput, QUICK_QTY, reservedQuantityOf, STOCK_FLOW_REASONS, toMillis } from "../utils";
import PrintableReport, { PrintableReportMeta } from "./PrintableReport";

interface UnifiedStockProps {
  items: StockItem[];
  user: { uid: string; email: string; displayName: string; role: string; companyId?: string; companyName?: string };
  companies: Company[];
  onUpdateItem: (itemId: string, updatedFields: Partial<StockItem>, reason: string, quantityDiff?: number) => Promise<void>;
  onAddItem: (itemData: Omit<StockItem, "id" | "userId" | "userEmail" | "createdAt" | "updatedAt">) => Promise<void>;
  onAddCompany?: (name: string, description?: string) => Promise<void>;
  // Mesma gravacao transacional usada pela aba Entradas e Saidas. Ausente
  // (undefined) para quem nao pode movimentar estoque: sem ela os botoes de
  // entrada/saida nem chegam a ser renderizados.
  onRegisterFlow?: (payload: StockFlowPayload) => Promise<StockFlowResult>;
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
  // De QUAL loja saiu o preco exibido nesta linha, e se as lojas divergem.
  // A linha e unica mas os documentos sao varios: sem saber a origem, editar
  // o preco e apostar em qual filial vai ser gravada.
  priceCompanyId: string;
  priceVaries: boolean;
}

export default function UnifiedStock({ items, user, companies: companiesProp, onUpdateItem, onAddItem, onAddCompany, onRegisterFlow }: UnifiedStockProps) {
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

  // A empresa do usuario aparece sempre como primeira coluna; as demais seguem
  // a ordem alfabetica vinda do App. Admin global (sem companyId) ve a ordem padrao.
  const companies = useMemo(() => {
    if (!user.companyId) return companiesProp;
    const own = companiesProp.find(c => c.id === user.companyId);
    if (!own) return companiesProp;
    return [own, ...companiesProp.filter(c => c.id !== own.id)];
  }, [companiesProp, user.companyId]);

  // ── Filtro por empresa ────────────────────────────────────────────
  // "ALL" mantem o comportamento historico: a tabela e UNIFICADA, e a graca
  // dela e comparar as filiais lado a lado. O filtro existe para o outro
  // momento — quando alguem quer olhar so a propria loja e as colunas das
  // outras viram ruido (uma fileira de tracos ate a coluna que interessa).
  //
  // O DONO abre na propria loja. Nao e preferencia de tela: cada empresa tem o
  // seu estoque e o seu custo, e os SKUs nao se cruzam entre filiais — o pneu da
  // Autocar nunca e o mesmo documento do da Autocenter. Sem o filtro, ele abria
  // 678 produtos para encontrar os 147 dele, com as outras 4 colunas em branco
  // e as linhas alheias recusando qualquer edicao.
  //
  // O ADMIN abre em "Todas": para ele o comparativo entre filiais e o trabalho.
  const [companyFilter, setCompanyFilter] = useState<string>(
    isAdmin || isVendedor ? "ALL" : (user.companyId || "ALL")
  );

  // A empresa selecionada pode sumir (renomeada, apagada por um admin em outra
  // aba). Sem isto a tabela ficaria sem nenhuma coluna, sem explicacao.
  React.useEffect(() => {
    if (companyFilter !== "ALL" && !companies.some(c => c.id === companyFilter)) {
      setCompanyFilter("ALL");
    }
  }, [companies, companyFilter]);

  // As colunas que a tabela realmente desenha. TUDO que renderiza quantidade
  // por empresa le daqui — cabecalho, corpo, cards do celular e a planilha
  // exportada — para nao existir uma tela filtrada que exporta o contrario.
  const visibleCompanies = useMemo(
    () => (companyFilter === "ALL" ? companies : companies.filter(c => c.id === companyFilter)),
    [companies, companyFilter]
  );

  // A loja cujo preco a linha mostra — e a mesma que a edicao vai gravar.
  // Com um filtro ativo e aquela loja; senao, a do proprio usuario (a unica que
  // ele consegue editar); e so em ultimo caso a primeira que tiver o pneu.
  const priceSourceCompanyId = React.useCallback(
    (docs: Record<string, StockItem>): string => {
      if (companyFilter !== "ALL" && docs[companyFilter]) return companyFilter;
      if (user.companyId && docs[user.companyId]) return user.companyId;
      return companies.find(c => docs[c.id])?.id || "";
    },
    [companyFilter, user.companyId, companies]
  );

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
          priceCash: 0,
          priceInstallment: 0,
          priceCompanyId: "",
          priceVaries: false,
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
    });

    // O preco da linha e o de UMA loja — a mesma que a edicao vai gravar.
    //
    // ANTES aqui rodava um "maximo entre as filiais": a linha mostrava o maior
    // preco de todas. Como salvar so escreve nas lojas que a pessoa pode editar,
    // qualquer preco menor que o de outra filial era gravado no banco e sumia da
    // tela no mesmo instante — o dono baixava o preco, via o numero da outra
    // loja voltar, e concluia que "nao salva". A assimetria entre as duas
    // colunas vinha do fallback: o valor inicial caia em `price` (o campo
    // legado) quando faltava, mas a comparacao do maximo olhava o campo cru —
    // entao a coluna A VISTA e a A PRAZO se comportavam diferente conforme
    // qual documento tivesse o campo antigo preenchido.
    return Array.from(map.values())
      .map(cons => {
        const sourceId = priceSourceCompanyId(cons.docs);
        const src = sourceId ? cons.docs[sourceId] : undefined;
        const cashOf = (d?: StockItem) => (d ? d.priceCash || d.price || 0 : 0);
        // Sem preco a prazo proprio, vale o a vista: e o mesmo padrao usado ao
        // cadastrar o produto, e evita mostrar "—" num pneu que tem preco.
        const instOf = (d?: StockItem) => (d ? d.priceInstallment || cashOf(d) : 0);

        const withDocs = companies.map(c => cons.docs[c.id]).filter(Boolean) as StockItem[];
        const priceVaries = withDocs.length > 1 && withDocs.some(
          d => cashOf(d) !== cashOf(src) || instOf(d) !== instOf(src)
        );

        return {
          ...cons,
          priceCash: cashOf(src),
          priceInstallment: instOf(src),
          priceCompanyId: sourceId,
          priceVaries
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [items, companies, priceSourceCompanyId]);

  const filteredItems = useMemo(() => {
    // Com uma empresa escolhida, some tambem a LINHA do pneu que aquela loja
    // nem cadastrou. Sem isso a tabela filtrada viraria uma coluna unica cheia
    // de tracos, listando o estoque das outras filiais sem mostrar nenhum.
    const base = companyFilter === "ALL"
      ? consolidatedItems
      : consolidatedItems.filter(item => !!item.docs[companyFilter]);

    if (!searchTerm) return base;
    const lower = searchTerm.toLowerCase();
    return base.filter(item =>
      item.sku.toLowerCase().includes(lower) ||
      item.description.toLowerCase().includes(lower) ||
      item.brand.toLowerCase().includes(lower) ||
      item.size.toLowerCase().includes(lower) ||
      matchesTireSize(item.size, lower)
    );
  }, [consolidatedItems, searchTerm, companyFilter]);

  // Export Unified Stock to CSV
  const exportUnifiedToCSV = () => {
    if (filteredItems.length === 0) return;

    const compHeaders = visibleCompanies.map(c => c.name.toUpperCase());
    const headers = ["CODIGO", "MEDIDA", "DESCRICAO", ...compHeaders, "P/ A VISTA", "P/ PRAZO"];

    const rows = filteredItems.map(item => {
      const compQty = visibleCompanies.map(comp => {
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

  // De quem e o preco que a linha esta mostrando. A tabela tem UMA coluna de
  // preco para N filiais: sem dizer de qual loja o numero saiu, um preco
  // divergente entre filiais parece erro do sistema.
  const priceHint = (item: ConsolidatedItem) => {
    const name = companies.find(c => c.id === item.priceCompanyId)?.name;
    if (!name) return "Nenhuma loja tem este pneu cadastrado.";
    return item.priceVaries
      ? `Preço de ${name}. As outras filiais têm preço diferente para este pneu — use o filtro de empresa acima para ver o de cada uma.`
      : `Preço de ${name}.`;
  };

  const startEdit = (item: ConsolidatedItem, field: string, currentValue: string) => {
    if (isVendedor) return;
    
    const isCompanyField = companies.some(c => c.id === field);
    if (isCompanyField && !canEditCompany(field)) return;
    // Preco: a coluna representa UMA loja (ver priceSourceCompanyId). Com um
    // filtro apontando para filial que nao e sua, nao ha o que editar — antes o
    // clique abria o campo e a gravacao ia parar na SUA loja, alterando um preco
    // que a tela nem estava mostrando.
    if (field === "priceCash" || field === "priceInstallment") {
      const canEditShownPrice = companyFilter === "ALL"
        ? companies.some(c => canEditCompany(c.id))
        : canEditCompany(companyFilter);
      if (!canEditShownPrice) return;
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
              price: item.priceCash,
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
        // Digitação inválida NÃO vira zero. Zerar um preço por engano é pior que
        // recusar a edição: o pneu passa a aparecer sem valor no catálogo.
        const numValue = parsePriceInput(rawValue);
        if (numValue === null) {
          throw new Error(
            `"${rawValue}" não é um preço válido. Use apenas números — a vírgula ` +
            `dos centavos é aceita (ex: 375,50).`
          );
        }

        // Com filtro ativo, escreve SO naquela loja — que e a que a tela esta
        // mostrando. Sem filtro, mantem o comportamento historico de igualar o
        // preco em todas as lojas que a pessoa pode editar (para o dono, isso e
        // exatamente a loja dele; so o admin atinge varias).
        const targets = companies.filter(comp =>
          canEditCompany(comp.id) &&
          item.docs[comp.id] &&
          (companyFilter === "ALL" || comp.id === companyFilter)
        );

        if (targets.length === 0) {
          throw new Error(
            "Este pneu não está cadastrado em nenhuma loja que você possa editar, " +
            "então não há preço seu para alterar aqui."
          );
        }

        for (const comp of targets) {
          const docToUpdate = item.docs[comp.id];
          // O campo pode nem existir nos documentos antigos: `undefined !== n`
          // e verdadeiro, entao a primeira gravacao passa e cria o campo.
          if (docToUpdate[field as keyof StockItem] !== numValue) {
            // O `price` legado alimenta o fallback de leitura em varias telas
            // (inclusive no catalogo publico). Deixa-lo para tras faz o preco
            // antigo reaparecer onde o campo novo estiver vazio.
            const fields: Partial<StockItem> =
              field === "priceCash" ? { priceCash: numValue, price: numValue } : { priceInstallment: numValue };
            await onUpdateItem(docToUpdate.id, fields, "Atualização de Preço", 0);
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


  // ─────────────────────────────────────────────────────────────────
  // Entrada e Saída direto da planilha unificada
  //
  // Atalho para o caso mais comum do balcão: o operador está olhando esta tela,
  // vê o saldo da filial e precisa dar entrada/baixa de UM pneu naquele momento.
  // A gravação passa pelo mesmo caminho transacional da aba Entradas e Saídas
  // (`onRegisterFlow`), então a operação nasce com operationId, aparece no
  // histórico e pode ser estornada de lá — não é um ajuste de saldo solto.
  // Operação com vários pneus continua sendo trabalho da aba dedicada.
  //
  // Editar a célula direto continua existindo e é outra coisa: aquilo é
  // CORREÇÃO de saldo (vira "Ajuste manual"); isto aqui é a operação real.
  // ─────────────────────────────────────────────────────────────────

  // O backend recusa quem não for admin/alimentador (handleRegisterStockFlow);
  // repetimos a regra aqui para nem oferecer o botão a quem não pode usá-lo.
  const canOperateFlow = !!onRegisterFlow && (isAdmin || user.role === "alimentador");

  const [showFlowModal, setShowFlowModal] = useState(false);
  const [flowSku, setFlowSku] = useState("");
  const [flowType, setFlowType] = useState<StockFlowType>("ENTRADA");
  const [flowCompanyId, setFlowCompanyId] = useState("");
  const [flowQty, setFlowQty] = useState("1");
  const [flowReasonChoice, setFlowReasonChoice] = useState("");
  const [flowCustomReason, setFlowCustomReason] = useState("");
  const [flowDocNumber, setFlowDocNumber] = useState("");
  const [flowPartyName, setFlowPartyName] = useState("");
  const [flowPartyDoc, setFlowPartyDoc] = useState("");
  const [flowPlate, setFlowPlate] = useState("");
  const [flowUnitPrice, setFlowUnitPrice] = useState("");
  const [flowObservation, setFlowObservation] = useState("");
  const [flowSubmitting, setFlowSubmitting] = useState(false);
  const [flowError, setFlowError] = useState("");
  const [flowSuccess, setFlowSuccess] = useState<{
    type: StockFlowType;
    quantity: number;
    balanceBefore: number;
    balanceAfter: number;
    companyName: string;
    operationId: string;
    created: boolean;
  } | null>(null);

  // O produto é relido da lista consolidada a cada render — assim o saldo
  // mostrado dentro do modal acompanha o Firestore em tempo real, inclusive
  // logo depois de gravar a própria operação.
  const flowItem = useMemo(
    () => (flowSku ? consolidatedItems.find(i => i.sku === flowSku) || null : null),
    [consolidatedItems, flowSku]
  );

  const flowCompanies = useMemo(
    () => (canOperateFlow ? companies.filter(c => canEditCompany(c.id)) : []),
    [companies, canOperateFlow, isAdmin, isVendedor, user.companyId]
  );

  const isEntrada = flowType === "ENTRADA";
  const flowDoc = flowItem && flowCompanyId ? flowItem.docs[flowCompanyId] : undefined;
  const flowBalance = flowDoc ? Number(flowDoc.quantity) || 0 : 0;
  const flowReserved = reservedQuantityOf(flowDoc);
  const flowFree = flowDoc ? availableQuantity(flowDoc) : 0;
  const flowQtyNumber = Math.max(0, Math.floor(Number(flowQty) || 0));
  const flowBalanceAfter = isEntrada ? flowBalance + flowQtyNumber : flowBalance - flowQtyNumber;
  const flowEffectiveReason = flowReasonChoice === "Outro" ? flowCustomReason.trim() : flowReasonChoice;

  // Entrada numa filial que ainda não tem este pneu cadastrado: em vez de
  // recusar, a operação CRIA a linha daquela empresa — o mesmo que já acontece
  // ao digitar um número numa célula vazia da planilha.
  const flowWillCreateItem = isEntrada && !!flowItem && !!flowCompanyId && !flowDoc;

  const flowCompanyName = companies.find(c => c.id === flowCompanyId)?.name || "";

  // Motivo pelo qual o botão de confirmar está travado (vazio = pode gravar).
  const flowBlockReason = useMemo(() => {
    if (!flowItem) return "Produto não encontrado.";
    if (!flowCompanyId) return "Selecione a empresa da movimentação.";
    if (flowQtyNumber < 1) return "Informe uma quantidade maior que zero.";
    if (!flowEffectiveReason) return "Descreva o motivo da operação.";
    if (!isEntrada) {
      if (!flowDoc) return "Este pneu não existe nesta empresa — não há saldo para dar baixa.";
      if (flowQtyNumber > flowFree) {
        // Distingue "não tem pneu" de "tem pneu, mas está prometido para uma
        // transferência": a saída para o operador é completamente diferente.
        return flowReserved > 0 && flowQtyNumber <= flowBalance
          ? `${flowReserved} un deste pneu estão RESERVADAS para uma transferência aprovada em ${flowCompanyName}. Livre para saída: ${flowFree} un.`
          : `Saldo insuficiente: disponível ${flowFree} un, solicitado ${flowQtyNumber} un.`;
      }
    }
    return "";
  }, [flowItem, flowCompanyId, flowCompanyName, flowQtyNumber, flowEffectiveReason, isEntrada, flowDoc, flowFree, flowReserved, flowBalance]);

  // Entrada é custo de compra (só quem tem a nota na mão sabe); saída sai pelo
  // preço de venda à vista já cadastrado, que é o palpite certo no balcão.
  const defaultFlowPrice = (item: ConsolidatedItem, type: StockFlowType) =>
    type === "SAIDA" && item.priceCash > 0 ? String(item.priceCash) : "";

  const openFlowModal = (item: ConsolidatedItem, type: StockFlowType, companyId?: string) => {
    if (!canOperateFlow) return;

    // Empresa de partida: a coluna clicada, senão a do próprio usuário, senão a
    // primeira que realmente tem o pneu (na saída, com saldo livre para baixar).
    const preferred =
      (companyId ? flowCompanies.find(c => c.id === companyId) : undefined) ||
      flowCompanies.find(c => c.id === user.companyId) ||
      flowCompanies.find(c => (type === "SAIDA" ? availableQuantity(item.docs[c.id]) > 0 : !!item.docs[c.id])) ||
      flowCompanies[0];

    setFlowSku(item.sku);
    setFlowType(type);
    setFlowCompanyId(preferred ? preferred.id : "");
    setFlowQty("1");
    setFlowReasonChoice(STOCK_FLOW_REASONS[type][0]);
    setFlowCustomReason("");
    setFlowDocNumber("");
    setFlowPartyName("");
    setFlowPartyDoc("");
    setFlowPlate("");
    setFlowUnitPrice(defaultFlowPrice(item, type));
    setFlowObservation("");
    setFlowError("");
    setFlowSuccess(null);
    setShowFlowModal(true);
  };

  const switchFlowType = (type: StockFlowType) => {
    if (type === flowType) return;
    setFlowType(type);
    setFlowReasonChoice(STOCK_FLOW_REASONS[type][0]);
    setFlowCustomReason("");
    setFlowError("");
    if (flowItem) setFlowUnitPrice(defaultFlowPrice(flowItem, type));
  };

  // Volta do comprovante para o formulário mantendo produto e empresa: quem dá
  // baixa de um pneu costuma repetir a operação logo em seguida.
  const resetFlowForm = () => {
    setFlowSuccess(null);
    setFlowError("");
    setFlowQty("1");
    setFlowReasonChoice(STOCK_FLOW_REASONS[flowType][0]);
    setFlowCustomReason("");
    if (flowItem) setFlowUnitPrice(defaultFlowPrice(flowItem, flowType));
  };

  const closeFlowModal = () => {
    if (flowSubmitting) return;
    setShowFlowModal(false);
    setFlowSuccess(null);
    setFlowError("");
    setFlowSku("");
  };

  // Esc fecha o modal (menos no meio da gravacao, para nao dar a impressao de
  // ter cancelado uma operacao que ja esta a caminho do servidor).
  React.useEffect(() => {
    if (!showFlowModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !flowSubmitting) closeFlowModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showFlowModal, flowSubmitting]);

  const handleSubmitFlow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (flowSubmitting || !flowItem) return;
    if (flowBlockReason) {
      setFlowError(flowBlockReason);
      return;
    }

    const company = companies.find(c => c.id === flowCompanyId);
    if (!company) {
      setFlowError("Empresa inválida para esta movimentação.");
      return;
    }

    setFlowSubmitting(true);
    setFlowError("");

    try {
      const unitPrice = parseFloat(flowUnitPrice.replace(",", ".")) || 0;

      if (flowWillCreateItem) {
        await onAddItem({
          sku: flowItem.sku,
          brand: flowItem.brand,
          model: flowItem.model,
          size: flowItem.size,
          quantity: flowQtyNumber,
          price: unitPrice || flowItem.priceCash,
          priceCash: flowItem.priceCash,
          priceInstallment: flowItem.priceInstallment,
          description: `${flowItem.size} ${flowItem.brand} ${flowItem.model}`.trim(),
          imageUrl: "",
          notes: `Entrada pela planilha unificada — ${flowEffectiveReason}`,
          companyId: company.id,
          companyName: company.name
        });

        setFlowSuccess({
          type: "ENTRADA",
          quantity: flowQtyNumber,
          balanceBefore: 0,
          balanceAfter: flowQtyNumber,
          companyName: company.name,
          operationId: "",
          created: true
        });
      } else {
        const result = await onRegisterFlow!({
          type: flowType,
          items: [{ stockItemId: flowDoc!.id, quantity: flowQtyNumber, unitPrice }],
          reason: flowEffectiveReason,
          docNumber: flowDocNumber.trim(),
          partyName: flowPartyName.trim(),
          partyDoc: flowPartyDoc.trim(),
          vehiclePlate: flowPlate.trim().toUpperCase(),
          observation: flowObservation.trim()
        });

        const line = result.items[0];
        setFlowSuccess({
          type: result.type,
          quantity: line ? line.quantity : flowQtyNumber,
          balanceBefore: line ? line.balanceBefore : flowBalance,
          balanceAfter: line ? line.balanceAfter : flowBalanceAfter,
          companyName: company.name,
          operationId: result.operationId,
          created: false
        });
      }
    } catch (err: any) {
      setFlowError(err?.message || "Não foi possível registrar a movimentação.");
    } finally {
      setFlowSubmitting(false);
    }
  };

  const flowAccent = isEntrada
    ? {
        text: "text-emerald-700",
        solid: "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20",
        soft: "bg-emerald-50 text-emerald-700 border-emerald-200",
        ring: "focus:ring-emerald-500/10 focus:border-emerald-500"
      }
    : {
        text: "text-red-700",
        solid: "bg-red-600 hover:bg-red-700 shadow-red-600/20",
        soft: "bg-red-50 text-red-700 border-red-200",
        ring: "focus:ring-red-500/10 focus:border-red-500"
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

      {/* ── Filtro de empresa ──────────────────────────────────────────────
          Fica colado na tabela, e nao junto dos botoes de acao la em cima:
          ele muda o que a tabela MOSTRA, nao dispara nenhuma operacao. */}
      {companies.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-4">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1 flex items-center gap-1">
            <Building2 size={12} className="text-gold-600" /> Empresa
          </span>

          <button
            type="button"
            onClick={() => setCompanyFilter("ALL")}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer ${
              companyFilter === "ALL"
                ? "bg-slate-900 text-gold-400 border-slate-900 shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            Todas ({companies.length})
          </button>

          {companies.map(comp => {
            const isOwn = !!user.companyId && comp.id === user.companyId;
            const active = companyFilter === comp.id;
            return (
              <button
                key={comp.id}
                type="button"
                onClick={() => setCompanyFilter(active ? "ALL" : comp.id)}
                title={active ? "Clique de novo para ver todas as empresas" : `Ver só o estoque de ${comp.name}`}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer flex items-center gap-1 ${
                  active
                    ? "bg-gold-600 text-white border-gold-600 shadow-sm"
                    : isOwn
                    ? "bg-gold-50 text-gold-800 border-gold-200 hover:bg-gold-100"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {comp.name}
                {/* A loja da propria pessoa fica marcada: numa lista de cinco
                    filiais com nomes parecidos, achar a sua leva um segundo. */}
                {isOwn && (
                  <span className={`text-[8px] font-bold normal-case tracking-normal ${active ? "text-white/75" : "text-gold-600"}`}>
                    sua loja
                  </span>
                )}
              </button>
            );
          })}

          {companyFilter !== "ALL" && (
            <span className="text-[10px] font-semibold text-slate-500 ml-1">
              Mostrando {filteredItems.length} {filteredItems.length === 1 ? "pneu" : "pneus"} cadastrados nesta loja.
            </span>
          )}
        </div>
      )}

      {/* Unified Stock Table - Desktop View */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full border-collapse text-left text-sm font-sans text-slate-850">
          <thead className="bg-slate-50 text-slate-450 text-[10px] uppercase tracking-wider font-extrabold border-b border-slate-200">
            <tr>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>CODIGO</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>MEDIDA</th>
              <th className="border-r border-slate-200 px-2 py-3" rowSpan={2}>DESCRIÇÃO</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" colSpan={visibleCompanies.length}>QUANTIDADE</th>
              <th className="border-r border-slate-200 px-2 py-3 text-center" rowSpan={2}>P/ A VISTA</th>
              <th className="px-2 py-3 text-center" rowSpan={2}>P/PRAZO</th>
              {canOperateFlow && (
                <th className="border-l border-slate-200 px-2 py-3 text-center" rowSpan={2}>MOVIMENTAR</th>
              )}
            </tr>
            <tr className="border-t border-slate-200">
              {visibleCompanies.map(comp => (
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
                  {visibleCompanies.map(comp => {
                    const docItem = item.docs[comp.id];
                    const qty = docItem ? docItem.quantity : 0;
                    const isEditing = editingCell?.sku === item.sku && editingCell?.field === comp.id;
                    const editable = canEditCompany(comp.id);

                    return (
                      <td
                        key={comp.id}
                        className={`group relative border-r border-slate-200 px-1 py-3 text-center ${editable ? "cursor-pointer hover:bg-gold-400/10" : "bg-slate-50/30"}`}
                        onClick={() => editable && startEdit(item, comp.id, qty.toString())}
                      >
                        {/* Atalho de movimentação DESTA empresa: aparece ao passar o
                            mouse na célula, para não poluir a planilha inteira. Abre
                            já em saída quando há saldo livre (o caso do balcão) e em
                            entrada quando não há — o tipo continua a um clique de
                            distância dentro do modal. */}
                        {editable && canOperateFlow && !isEditing && (
                          <button
                            type="button"
                            title={`Entrada / saída deste pneu em ${comp.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openFlowModal(item, availableQuantity(docItem) > 0 ? "SAIDA" : "ENTRADA", comp.id);
                            }}
                            className="absolute top-1 right-1 h-4 w-4 rounded bg-white border border-slate-200 text-slate-400 hover:text-gold-700 hover:border-gold-400 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hidden lg:inline-flex"
                          >
                            <ArrowRightLeft size={9} className="stroke-[2.5px]" />
                          </button>
                        )}
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
                    title={priceHint(item)}
                    onClick={() => startEdit(item, "priceCash", item.priceCash.toString())}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "priceCash" ? (
                      <input 
                        autoFocus
                        type="text"
                        inputMode="decimal"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        className="w-20 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                      />
                    ) : (
                      <>
                        {item.priceCash > 0 ? `R$ ${item.priceCash.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>}
                        {item.priceVaries && (
                        <span className="ml-0.5 align-super text-[9px] font-black text-amber-500">≠</span>
                      )}
                      </>
                    )}
                  </td>

                  {/* Price Installment */}
                  <td 
                    className={`px-2 py-3 text-center font-bold text-slate-900 text-xs whitespace-nowrap ${(!isVendedor) ? "cursor-pointer hover:bg-gold-400/10" : ""}`}
                    title={priceHint(item)}
                    onClick={() => startEdit(item, "priceInstallment", item.priceInstallment.toString())}
                  >
                    {editingCell?.sku === item.sku && editingCell?.field === "priceInstallment" ? (
                      <input 
                        autoFocus
                        type="text"
                        inputMode="decimal"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleSaveEdit(item)}
                        onKeyDown={(e) => handleKeyDown(e, item)}
                        className="w-20 px-1 text-center outline-none bg-white border border-gold-400 rounded font-bold"
                      />
                    ) : (
                      <>
                        {item.priceInstallment > 0 ? `R$ ${item.priceInstallment.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>}
                        {item.priceVaries && (
                        <span className="ml-0.5 align-super text-[9px] font-black text-amber-500">≠</span>
                      )}
                      </>
                    )}
                  </td>

                  {/* Entrada / Saída da linha inteira */}
                  {canOperateFlow && (
                    <td className="border-l border-slate-200 px-2 py-3 text-center whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title={`Registrar ENTRADA de ${item.sku}`}
                          onClick={() => openFlowModal(item, "ENTRADA")}
                          className="h-7 w-7 inline-flex items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-600 hover:text-white hover:border-emerald-600 transition-all cursor-pointer"
                        >
                          <PackagePlus size={13} />
                        </button>
                        <button
                          type="button"
                          title={`Registrar SAÍDA de ${item.sku}`}
                          onClick={() => openFlowModal(item, "SAIDA")}
                          className="h-7 w-7 inline-flex items-center justify-center rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-600 hover:text-white hover:border-red-600 transition-all cursor-pointer"
                        >
                          <PackageMinus size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            
            {filteredItems.length === 0 && (
              <tr>
                {/* 3 colunas fixas na frente (codigo, medida, descricao) + as
                    de quantidade que estao visiveis + os 2 precos. Antes somava
                    6 fixas e ignorava o filtro: sobrava coluna dos dois lados. */}
                <td colSpan={5 + visibleCompanies.length + (canOperateFlow ? 1 : 0)} className="p-8 text-center text-slate-400 font-semibold">
                  {companyFilter === "ALL"
                    ? "Nenhum registro encontrado."
                    : `Nenhum pneu cadastrado em ${companies.find(c => c.id === companyFilter)?.name || "esta loja"}${searchTerm ? " para esta busca" : ""}.`}
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
                  {visibleCompanies.map(comp => {
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
                      type="text"
                      inputMode="decimal"
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
                      type="text"
                      inputMode="decimal"
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

              {/* Entrada / Saída direto do card */}
              {canOperateFlow && (
                <div className="border-t border-slate-150/60 pt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => openFlowModal(item, "ENTRADA")}
                    className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-black uppercase tracking-wider active:scale-[0.98] transition-all cursor-pointer"
                  >
                    <PackagePlus size={13} /> Entrada
                  </button>
                  <button
                    type="button"
                    onClick={() => openFlowModal(item, "SAIDA")}
                    className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-50 text-red-700 border border-red-200 text-[11px] font-black uppercase tracking-wider active:scale-[0.98] transition-all cursor-pointer"
                  >
                    <PackageMinus size={13} /> Saída
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {filteredItems.length === 0 && (
          <div className="p-8 text-center text-slate-400 font-semibold bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
            Nenhum registro encontrado.
          </div>
        )}
      </div>
      
      <div className="text-[10px] text-slate-400 font-semibold leading-relaxed space-y-1">
        <p>
          💡 Dica: Clique em qualquer célula de quantidade ou preço para <strong className="text-slate-500">corrigir</strong> o valor diretamente na planilha e pressione <kbd className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Enter</kbd> para salvar (Alimentadores e Administradores).
        </p>
        {canOperateFlow && (
          <p>
            📦 Para a <strong className="text-slate-500">operação de verdade</strong> (compra, venda, garantia, perda), use os botões
            <span className="mx-1 inline-flex items-center gap-1 align-middle">
              <PackagePlus size={11} className="text-emerald-600" /> / <PackageMinus size={11} className="text-red-600" />
            </span>
            no fim de cada linha: o registro vai para o histórico da aba <strong className="text-slate-500">Entradas e Saídas</strong> com motivo, nota e responsável, e pode ser estornado de lá.
          </p>
        )}
      </div>

      {/* ═══════════ MOVIMENTAÇÃO RÁPIDA: ENTRADA / SAÍDA ═══════════ */}
      {showFlowModal && flowItem && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-fadeIn print:hidden">
          <div className="bg-white rounded-3xl max-w-lg w-full border border-slate-200 shadow-2xl my-8 flex flex-col max-h-[92vh]">

            {/* Cabeçalho: o que está sendo movimentado */}
            <div className="flex items-start justify-between border-b border-slate-100 p-5 shrink-0 gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                  {isEntrada
                    ? <PackagePlus size={16} className="text-emerald-600 shrink-0" />
                    : <PackageMinus size={16} className="text-red-600 shrink-0" />}
                  {isEntrada ? "Entrada de pneu" : "Saída de pneu"}
                </h3>
                <p className="text-[11px] font-bold text-slate-500 mt-1 truncate">
                  <span className="font-mono text-gold-700">{flowItem.sku}</span>
                  <span className="mx-1.5 text-slate-300">•</span>
                  <span className="font-mono">{flowItem.size}</span> {flowItem.brand} {flowItem.model}
                </p>
              </div>
              <button
                type="button"
                onClick={closeFlowModal}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0"
              >
                <X size={16} />
              </button>
            </div>

            {flowSuccess ? (
              /* ─── Comprovante da operação gravada ─── */
              <div className="p-6 space-y-4 overflow-y-auto">
                <div className={`rounded-2xl border p-5 text-center ${flowSuccess.type === "ENTRADA" ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
                  <CheckCircle2 size={34} className={`mx-auto mb-2 ${flowSuccess.type === "ENTRADA" ? "text-emerald-600" : "text-red-600"}`} />
                  <p className="text-sm font-black text-slate-900 uppercase tracking-wider">
                    {flowSuccess.type === "ENTRADA" ? "Entrada registrada" : "Saída registrada"}
                  </p>
                  <p className="text-[11px] font-bold text-slate-500 mt-1">
                    {flowSuccess.quantity} un • {flowItem.sku} • {flowSuccess.companyName}
                  </p>
                  <div className="mt-3 flex items-center justify-center gap-2 text-base font-black font-mono">
                    <span className="text-slate-400">{flowSuccess.balanceBefore} un</span>
                    <ArrowRight size={15} className="text-slate-300" />
                    <span className={flowSuccess.type === "ENTRADA" ? "text-emerald-600" : "text-red-600"}>
                      {flowSuccess.balanceAfter} un
                    </span>
                  </div>
                  {flowSuccess.operationId && (
                    <p className="mt-2 text-[10px] font-mono font-bold text-slate-400">{flowSuccess.operationId}</p>
                  )}
                </div>

                <p className="text-[10px] text-slate-400 font-semibold text-center leading-relaxed">
                  {flowSuccess.created
                    ? "O pneu não existia nesta empresa e foi cadastrado com o saldo desta entrada."
                    : "A operação está no histórico da aba Entradas e Saídas — é lá que ela pode ser conferida, impressa ou estornada."}
                </p>

                <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={closeFlowModal}
                    className="px-4 py-2.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    onClick={resetFlowForm}
                    className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer hover:scale-[1.01]"
                  >
                    Nova movimentação
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmitFlow} className="flex flex-col min-h-0">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">

                  {/* Tipo da operação */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => switchFlowType("ENTRADA")}
                      className={`flex items-center justify-center gap-2 py-3 rounded-2xl border text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                        isEntrada
                          ? "bg-emerald-600 border-emerald-600 text-white shadow-md shadow-emerald-600/20"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      <PackagePlus size={15} /> Entrada
                    </button>
                    <button
                      type="button"
                      onClick={() => switchFlowType("SAIDA")}
                      className={`flex items-center justify-center gap-2 py-3 rounded-2xl border text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                        !isEntrada
                          ? "bg-red-600 border-red-600 text-white shadow-md shadow-red-600/20"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      <PackageMinus size={15} /> Saída
                    </button>
                  </div>

                  {/* Empresa: cada opção já mostra o saldo de lá, para não errar de filial */}
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">
                      Empresa / Filial *
                    </label>
                    {flowCompanies.length === 0 ? (
                      <p className="text-xs font-bold text-slate-400 py-2">Nenhuma empresa disponível para o seu perfil.</p>
                    ) : flowCompanies.length === 1 ? (
                      <div className="px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50/60 flex items-center justify-between gap-2">
                        <span className="text-xs font-black text-slate-800 truncate">{flowCompanies[0].name}</span>
                        <span className="text-[11px] font-black font-mono text-slate-500 shrink-0">
                          {flowItem.docs[flowCompanies[0].id] ? `${flowBalance} un` : "sem cadastro"}
                        </span>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto p-0.5">
                        {flowCompanies.map(comp => {
                          const compDoc = flowItem.docs[comp.id];
                          const compQty = compDoc ? Number(compDoc.quantity) || 0 : 0;
                          const compReserved = reservedQuantityOf(compDoc);
                          const selected = comp.id === flowCompanyId;
                          return (
                            <button
                              type="button"
                              key={comp.id}
                              onClick={() => { setFlowCompanyId(comp.id); setFlowError(""); }}
                              className={`px-3 py-2 rounded-xl border text-left transition-all cursor-pointer ${
                                selected ? "border-gold-500 bg-gold-50/60 shadow-xs" : "border-slate-200 bg-white hover:bg-slate-50"
                              }`}
                            >
                              <span className="block text-[11px] font-black text-slate-800 truncate">{comp.name}</span>
                              <span className="block text-[10px] font-bold text-slate-500 font-mono">
                                {compDoc ? `${compQty} un` : "sem cadastro"}
                                {compReserved > 0 && <span className="text-amber-700"> • {compReserved} reserv.</span>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Quantidade + prévia do saldo */}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2">
                          Quantidade *
                        </label>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setFlowQty(String(Math.max(1, flowQtyNumber - 1)))}
                            className="h-9 w-9 inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                          >
                            <Minus size={14} className="stroke-[3px]" />
                          </button>
                          <input
                            type="number"
                            min={1}
                            value={flowQty}
                            onChange={e => { setFlowQty(e.target.value); setFlowError(""); }}
                            className={`w-20 h-9 px-2 text-center text-sm font-black font-mono text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all ${flowAccent.ring}`}
                          />
                          <button
                            type="button"
                            onClick={() => setFlowQty(String(flowQtyNumber + 1))}
                            className="h-9 w-9 inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                          >
                            <Plus size={14} className="stroke-[3px]" />
                          </button>
                          <div className="flex items-center gap-1 ml-1">
                            {QUICK_QTY.map(q => (
                              <button
                                key={q}
                                type="button"
                                onClick={() => { setFlowQty(String(q)); setFlowError(""); }}
                                className={`h-9 w-9 rounded-xl border text-[11px] font-black transition-all cursor-pointer ${
                                  flowQtyNumber === q ? `${flowAccent.soft}` : "bg-white border-slate-200 text-slate-500 hover:bg-slate-100"
                                }`}
                                title={`${q} un`}
                              >
                                {q}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="text-right">
                        <span className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">
                          Saldo em {flowCompanyName || "—"}
                        </span>
                        <div className="flex items-center justify-end gap-2 text-base font-black font-mono">
                          <span className="text-slate-400">{flowBalance} un</span>
                          <ArrowRight size={15} className="text-slate-300" />
                          <span className={isEntrada ? "text-emerald-600" : "text-red-600"}>
                            {Math.max(0, flowBalanceAfter)} un
                          </span>
                        </div>
                        {flowReserved > 0 && (
                          <span
                            className="mt-1.5 inline-flex items-center gap-1 text-[9px] font-black text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 uppercase tracking-wider"
                            title="Presas por uma transferência aprovada — não entram na saída."
                          >
                            <Lock size={9} /> {flowReserved} un reservadas • {flowFree} livres
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {flowWillCreateItem && (
                    <div className="bg-blue-50 text-blue-800 p-3 rounded-xl text-[11px] font-bold border-l-4 border-blue-500 leading-relaxed">
                      Este pneu ainda não existe em <strong>{flowCompanyName}</strong>. A entrada vai
                      cadastrá-lo nesta empresa com {flowQtyNumber} un e o registro sai no histórico
                      como cadastro inicial.
                    </div>
                  )}

                  {/* Dados da operação */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                        Motivo *
                      </label>
                      <select
                        value={flowReasonChoice}
                        onChange={e => { setFlowReasonChoice(e.target.value); setFlowError(""); }}
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-bold cursor-pointer ${flowAccent.ring}`}
                      >
                        {STOCK_FLOW_REASONS[flowType].map(r => (
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
                        value={flowDocNumber}
                        onChange={e => setFlowDocNumber(e.target.value)}
                        placeholder="Opcional"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${flowAccent.ring}`}
                      />
                    </div>
                  </div>

                  {flowReasonChoice === "Outro" && (
                    <input
                      type="text"
                      value={flowCustomReason}
                      onChange={e => { setFlowCustomReason(e.target.value); setFlowError(""); }}
                      placeholder="Descreva o motivo da operação *"
                      className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${flowAccent.ring}`}
                    />
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                        {isEntrada ? "Fornecedor" : "Cliente"}
                      </label>
                      <input
                        type="text"
                        value={flowPartyName}
                        onChange={e => setFlowPartyName(e.target.value)}
                        placeholder="Opcional"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${flowAccent.ring}`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                        {isEntrada ? "CNPJ / CPF" : "Placa"}
                      </label>
                      <input
                        type="text"
                        value={isEntrada ? flowPartyDoc : flowPlate}
                        onChange={e => (isEntrada ? setFlowPartyDoc(e.target.value) : setFlowPlate(e.target.value.toUpperCase()))}
                        placeholder="Opcional"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold font-mono ${flowAccent.ring}`}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                        {isEntrada ? "Custo unitário (R$)" : "Preço unitário (R$)"}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={flowUnitPrice}
                        onChange={e => setFlowUnitPrice(e.target.value)}
                        placeholder="Opcional"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold font-mono ${flowAccent.ring}`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                        Observação
                      </label>
                      <input
                        type="text"
                        value={flowObservation}
                        onChange={e => setFlowObservation(e.target.value)}
                        placeholder="Opcional"
                        className={`w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 transition-all font-semibold ${flowAccent.ring}`}
                      />
                    </div>
                  </div>

                  {flowError && (
                    <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-bold border-l-4 border-red-500 flex items-start gap-2">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      {flowError}
                    </div>
                  )}
                </div>

                {/* Rodapé: total + confirmar */}
                <div className="border-t border-slate-100 p-5 shrink-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-xl font-black font-mono leading-none ${isEntrada ? "text-emerald-600" : "text-red-600"}`}>
                        {isEntrada ? "+" : "-"}{flowQtyNumber}
                      </span>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">un</span>
                    </div>
                    {flowQtyNumber > 0 && (parseFloat(flowUnitPrice.replace(",", ".")) || 0) > 0 && (
                      <span className="text-[10px] font-bold text-slate-500 font-mono">
                        {formatBRL(flowQtyNumber * (parseFloat(flowUnitPrice.replace(",", ".")) || 0))}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={closeFlowModal}
                      disabled={flowSubmitting}
                      className="px-4 py-2.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer disabled:opacity-40"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={flowSubmitting || !!flowBlockReason}
                      title={flowBlockReason || ""}
                      className={`px-5 py-2.5 rounded-xl text-white text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:hover:scale-100 flex items-center gap-2 ${flowAccent.solid}`}
                    >
                      {flowSubmitting
                        ? <Loader2 size={14} className="animate-spin" />
                        : isEntrada ? <PackagePlus size={14} /> : <PackageMinus size={14} />}
                      {flowSubmitting ? "Gravando..." : isEntrada ? "Confirmar entrada" : "Confirmar saída"}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

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
