import React, { useState, useRef } from "react";
import {
  FileUp, Loader2, Check, AlertTriangle, Plus, Trash2, Edit2,
  Play, CircleAlert, FileText, Image, X, Building2, FileSpreadsheet, FileCode2
} from "lucide-react";
import { formatBRL } from "../utils";
import { Company } from "../types";
import { parseStockText, extractTextFromPdf } from "../utils/parsers";

interface ExtractedItem {
  virtualId: string;
  brand: string;
  model: string;
  size: string;
  quantity: number;
  price: number;
  notes: string;
  description?: string;
  imageUrl?: string;
}

interface PDFImporterProps {
  onSaveImportedItems: (items: (Omit<ExtractedItem, "virtualId"> & { companyId?: string; companyName?: string })[]) => Promise<void>;
  userEmail: string;
  companies: Company[];
  user: { uid: string; email: string; displayName: string; role: string; companyId?: string; companyName?: string };
}

// Accepted MIME types and their labels
const ACCEPTED_TYPES = [
  { mime: "application/pdf",   ext: ".pdf",        label: "PDF",     icon: FileText,        color: "text-red-500" },
  { mime: "image/*",           ext: "image/*",     label: "Imagem",  icon: Image,           color: "text-blue-500" },
  { mime: "text/xml",          ext: ".xml",        label: "XML",     icon: FileCode2,       color: "text-emerald-500" },
  { mime: "application/xml",   ext: ".xml",        label: "XML",     icon: FileCode2,       color: "text-emerald-500" },
  { mime: "text/csv",          ext: ".csv",        label: "CSV",     icon: FileSpreadsheet, color: "text-gold-600" },
];

function getFileTypeLabel(file: File): string {
  if (file.type === "application/pdf") return "PDF";
  if (file.type.startsWith("image/")) return "Imagem";
  if (file.type === "text/xml" || file.type === "application/xml" || file.name.endsWith(".xml")) return "XML NF-e";
  if (file.type === "text/csv" || file.name.endsWith(".csv")) return "CSV";
  return "Arquivo";
}

function getFileColor(file: File): string {
  if (file.type === "application/pdf") return "text-red-500";
  if (file.type.startsWith("image/")) return "text-blue-500";
  if (file.type === "text/xml" || file.type === "application/xml" || file.name.endsWith(".xml")) return "text-emerald-600";
  if (file.type === "text/csv" || file.name.endsWith(".csv")) return "text-gold-600";
  return "text-slate-500";
}

export default function PDFImporter({ onSaveImportedItems, companies, user }: PDFImporterProps) {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [success, setSuccess] = useState(false);
  const [importMode, setImportMode] = useState<"file" | "text">("file");
  const [pastedText, setPastedText] = useState("");

  // Company selector state
  const isAdmin = user.role === "admin";
  const defaultCompanyId = user.companyId || "";
  const defaultCompanyName = user.companyName || "";
  const [selectedCompanyId, setSelectedCompanyId] = useState(defaultCompanyId);
  const [selectedCompanyName, setSelectedCompanyName] = useState(defaultCompanyName);

  // Editing state for table rows
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBrand, setEditBrand] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editSize, setEditSize] = useState("");
  const [editQuantity, setEditQuantity] = useState(0);
  const [editPrice, setEditPrice] = useState(0);
  const [editNotes, setEditNotes] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Company dropdown handler ──────────────────────────────────
  const handleCompanyChange = (companyId: string) => {
    setSelectedCompanyId(companyId);
    const found = companies.find(c => c.id === companyId);
    setSelectedCompanyName(found?.name || companyId);
  };

  // ── Drag & Drop ───────────────────────────────────────────────
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) validateAndSetFile(e.dataTransfer.files[0]);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) validateAndSetFile(e.target.files[0]);
  };

  const validateAndSetFile = (selectedFile: File) => {
    setError("");
    setSuccess(false);

    const name = selectedFile.name.toLowerCase();
    const isPDF   = selectedFile.type === "application/pdf";
    const isImage = selectedFile.type.startsWith("image/");
    const isXML   = selectedFile.type === "text/xml" || selectedFile.type === "application/xml" || name.endsWith(".xml");
    const isCSV   = selectedFile.type === "text/csv" || selectedFile.type === "text/plain" || name.endsWith(".csv");

    if (!isPDF && !isImage && !isXML && !isCSV) {
      setError("Tipo de arquivo inválido. Formatos aceitos: PDF, imagens (PNG, JPG, WEBP), XML de NF-e ou CSV.");
      return;
    }
    if (selectedFile.size > 15 * 1024 * 1024) {
      setError("Arquivo muito grande. Limite máximo: 15 MB.");
      return;
    }

    setFile(selectedFile);
    setExtractedItems([]);
  };

  // ── Read file as base64 ───────────────────────────────────────
  const toBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.readAsDataURL(f);
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
    });

  // ── Read file as plain text (XML / CSV) ──────────────────────
  const toText = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.readAsText(f, "UTF-8");
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
    });

  // ── Process file or text (local parsing when possible, fallback to backend for PDF/Images) ──
  const handleProcessFile = async () => {
    if (importMode === "file" && !file) { setError("Selecione um arquivo primeiro."); return; }
    if (importMode === "text" && !pastedText.trim()) { setError("Cole o texto do estoque primeiro."); return; }

    setLoading(true);
    setError("");

    try {
      let parsedItems: any[] = [];
      let isLocalParseable = false;
      let fileTextContent = "";

      if (importMode === "text") {
        fileTextContent = pastedText;
        isLocalParseable = true;
      } else {
        const name = file!.name.toLowerCase();
        const isXML = file!.type === "text/xml" || file!.type === "application/xml" || name.endsWith(".xml");
        const isCSV = file!.type === "text/csv" || file!.type === "text/plain" || name.endsWith(".csv");
        const isPDF = file!.type === "application/pdf" || name.endsWith(".pdf");

        if (isXML || isCSV) {
          fileTextContent = await toText(file!);
          isLocalParseable = true;
        } else if (isPDF) {
          try {
            fileTextContent = await extractTextFromPdf(file!);
            isLocalParseable = true;
          } catch (pdfErr: any) {
            console.error("Local PDF text extraction failed:", pdfErr);
            throw new Error("Não foi possível ler o arquivo PDF. Verifique se ele não está corrompido ou protegido por senha.");
          }
        }
      }

      if (isLocalParseable) {
        parsedItems = parseStockText(fileTextContent, file?.type, companies);
        if (parsedItems.length === 0) {
          if (file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
            throw new Error("Não foi possível identificar produtos no PDF. Se for um PDF escaneado (imagem sem texto selecionável), tente usar a aba 'Colar Texto' digitando as informações.");
          }
          throw new Error("Não foi possível interpretar o texto ou arquivo. Verifique o formato ou certifique-se de que os dados estão corretos.");
        }
      } else {
        // PDF or image: require backend
        const apiUrl = import.meta.env.VITE_API_URL || "https://central-estoque-v1.onrender.com";
        const fileBase64 = await toBase64(file!);
        const body = {
          fileBase64,
          mimeType: file!.type,
        };

        const response = await fetch(`${apiUrl}/api/parse-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Erro de rede" }));
          throw new Error(err.error || "Não foi possível extrair os dados do arquivo.");
        }

        const data = await response.json();
        if (data.success && Array.isArray(data.items)) {
          parsedItems = data.items;
        } else {
          throw new Error("Resposta inválida do servidor.");
        }
      }

      // Map and validate extracted items
      const validated: ExtractedItem[] = parsedItems.map((item: any, idx: number) => ({
        virtualId: item.virtualId || `PROD-${Date.now()}-${idx}`,
        brand:     item.brand    || "Desconhecida",
        model:     item.model    || "Desconhecido",
        size:      item.size     || "—",
        quantity:  typeof item.quantity === "number" ? item.quantity : parseInt(item.quantity) || 0,
        price:     typeof item.price    === "number" ? item.price    : parseFloat(item.price)  || 0,
        notes:     item.notes    || "",
        description: item.description || `Importado via ${importMode === "text" ? "Texto" : getFileTypeLabel(file!)}`,
        imageUrl:  item.imageUrl || ""
      }));

      setExtractedItems(validated);
      if (validated.length === 0) setError("Nenhum item identificado no arquivo. Tente outro formato.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Erro de conexão ao processar o arquivo.");
    } finally {
      setLoading(false);
    }
  };

  // ── Row editing ───────────────────────────────────────────────
  const startEdit = (item: ExtractedItem) => {
    setEditingId(item.virtualId);
    setEditBrand(item.brand);
    setEditModel(item.model);
    setEditSize(item.size);
    setEditQuantity(item.quantity);
    setEditPrice(item.price);
    setEditNotes(item.notes);
  };

  const saveRowEdit = (virtualId: string) => {
    setExtractedItems(prev => prev.map(item =>
      item.virtualId === virtualId
        ? { ...item, brand: editBrand, model: editModel, size: editSize, quantity: editQuantity, price: editPrice, notes: editNotes }
        : item
    ));
    setEditingId(null);
  };

  const deleteRow = (virtualId: string) =>
    setExtractedItems(prev => prev.filter(i => i.virtualId !== virtualId));

  const addNewRow = () => {
    const newId = `PROD-NEW-${Date.now()}`;
    const newItem: ExtractedItem = { virtualId: newId, brand: "Nova Marca", model: "Modelo Pneu", size: "205/55R16", quantity: 1, price: 0, notes: "" };
    setExtractedItems([newItem, ...extractedItems]);
    startEdit(newItem);
  };

  // ── Confirm import ────────────────────────────────────────────
  const handleConfirmImport = async () => {
    if (extractedItems.length === 0) return;
    if (!selectedCompanyId && !selectedCompanyName) {
      setError("Selecione a empresa de destino antes de importar.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const itemsToSave = extractedItems.map(({ brand, model, size, quantity, price, notes, description, imageUrl, ...rest }) => ({
        brand, model, size, quantity, price, notes,
        description: description || `Importado via ${file ? getFileTypeLabel(file) : "arquivo"}`,
        imageUrl: imageUrl || "",
        companyId:   (rest as any).companyId || selectedCompanyId,
        companyName: (rest as any).companyName || selectedCompanyName,
        sku:         (rest as any).sku || "",
        priceCash:   (rest as any).priceCash || price || 0,
        priceInstallment: (rest as any).priceInstallment || price || 0,
      }));

      await onSaveImportedItems(itemsToSave);
      setSuccess(true);
      setExtractedItems([]);
      setFile(null);
    } catch (err: any) {
      setError(err.message || "Erro ao salvar o estoque importado.");
    } finally {
      setLoading(false);
    }
  };

  // ── Reset ─────────────────────────────────────────────────────
  const handleReset = () => {
    setExtractedItems([]);
    setFile(null);
    setPastedText("");
    setError("");
    setSuccess(false);
  };

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div id="pdf-importer-section" className="bg-white p-6 rounded-2xl border-t-4 border-t-gold-500 border-x border-b border-slate-200/85 shadow-[0_10px_25px_rgba(0,0,0,0.015)] space-y-6">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Importação de Estoque</h2>
          <p className="text-sm text-slate-500 font-semibold mt-1">
            Envie PDFs, imagens de tabelas, arquivos XML de NF-e, CSV ou cole texto. O sistema extrai marcas, modelos, medidas, quantidades e preços automaticamente.
          </p>
        </div>
        {extractedItems.length > 0 && (
          <button
            onClick={addNewRow}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-gold-700 bg-gold-50 hover:bg-gold-100 rounded-lg border border-gold-200/50 transition-all self-start cursor-pointer"
          >
            <Plus size={14} /> Adicionar Item Manual
          </button>
        )}
      </div>

      {/* ── Alerts ─────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-xl text-sm flex gap-2.5 items-start">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div><span className="font-bold block">Atenção!</span>{error}</div>
        </div>
      )}

      {success && (
        <div className="bg-emerald-50 border-l-4 border-emerald-500 text-emerald-800 p-4 rounded-xl text-sm flex gap-2.5 items-start animate-fadeIn">
          <Check className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold block">Importação Concluída!</span>
            O estoque foi integrado ao banco de dados e as movimentações foram registradas com sucesso.
          </div>
        </div>
      )}

      {/* ── Company selector ──────────────────────────────────── */}
      <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <Building2 size={16} className="text-gold-600" />
          <span className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">Empresa Destino:</span>
        </div>

        {isAdmin ? (
          <select
            value={selectedCompanyId}
            onChange={(e) => handleCompanyChange(e.target.value)}
            className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 outline-none cursor-pointer"
          >
            <option value="">Selecione a empresa...</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl">
            <span className="text-xs font-black text-slate-900">{selectedCompanyName || "Minha empresa"}</span>
            <span className="text-[9px] font-black text-gold-600 bg-gold-50 px-1.5 py-0.5 rounded border border-gold-200/40 uppercase tracking-wider">Fixo</span>
          </div>
        )}

        {selectedCompanyName && (
          <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-100 shrink-0">
            ✓ {selectedCompanyName}
          </span>
        )}
      </div>

      {/* ── Mode selector ──────────────────────────────────────── */}
      {extractedItems.length === 0 && (
        <div className="flex border-b border-slate-200">
          <button
            type="button"
            onClick={() => { setImportMode("file"); setError(""); }}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer ${
              importMode === "file"
                ? "border-gold-500 text-gold-600 font-extrabold"
                : "border-transparent text-slate-400 hover:text-slate-655"
            }`}
          >
            📁 Importar Arquivo
          </button>
          <button
            type="button"
            onClick={() => { setImportMode("text"); setError(""); }}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer ${
              importMode === "text"
                ? "border-gold-500 text-gold-600 font-extrabold"
                : "border-transparent text-slate-400 hover:text-slate-655"
            }`}
          >
            📝 Colar Texto Copiado
          </button>
        </div>
      )}

      {/* ── Drop Zone or Text Area ────────────────────────────── */}
      {extractedItems.length === 0 && (
        <div className="flex flex-col items-center w-full">
          {importMode === "file" ? (
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`w-full max-w-2xl border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
                dragActive
                  ? "border-gold-500 bg-gold-50/20 scale-[1.01]"
                  : file
                    ? "border-gold-400 bg-gold-50/5 hover:bg-gold-50/15"
                    : "border-slate-200 bg-white hover:border-gold-400 hover:bg-gold-50/10"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/*,.xml,.csv,.txt"
                onChange={handleFileInput}
                className="hidden"
              />

              <div className={`h-14 w-14 rounded-2xl bg-gold-50 flex items-center justify-center mb-4 border border-gold-100 ${file ? getFileColor(file) : "text-gold-600"}`}>
                <FileUp size={28} className={loading ? "animate-pulse" : ""} />
              </div>

              {file ? (
                <div className="space-y-1">
                  <span className={`inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border mb-1 ${getFileColor(file)} bg-slate-50 border-slate-200`}>
                    {getFileTypeLabel(file)}
                  </span>
                  <p className="font-bold text-slate-850 text-base">{file.name}</p>
                  <p className="text-xs text-slate-500 font-mono">{(file.size / (1024 * 1024)).toFixed(2)} MB • Pronto para processar</p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFile(null); setError(""); }}
                    className="mt-2 text-[10px] font-bold text-red-500 hover:text-red-700 flex items-center gap-1 mx-auto"
                  >
                    <X size={10} /> Remover arquivo
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="font-bold text-slate-900 text-base">Arraste o arquivo ou clique para explorar</p>
                  <p className="text-xs text-slate-500 font-semibold">Formatos aceitos até 15 MB:</p>

                  {/* Format badges */}
                  <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
                    {[
                      { label: "PDF", icon: FileText, color: "text-red-500 bg-red-50 border-red-100" },
                      { label: "PNG / JPG / WEBP", icon: Image, color: "text-blue-600 bg-blue-50 border-blue-100" },
                      { label: "XML NF-e", icon: FileCode2, color: "text-emerald-700 bg-emerald-50 border-emerald-100" },
                      { label: "CSV / Planilha", icon: FileSpreadsheet, color: "text-gold-700 bg-gold-50 border-gold-100" },
                    ].map(({ label, icon: Icon, color }) => (
                      <span key={label} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded border ${color}`}>
                        <Icon size={10} />{label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="w-full max-w-2xl flex flex-col gap-3">
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">
                Cole o texto com a lista de estoque abaixo *
              </label>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Exemplos de texto que você pode colar:

10 Pirelli Cinturato P7 205/55R16 - R$ 450 cada
- 5x 205/55R16 Pirelli Cinturato P7 R$ 489,90
4 Michelin Primacy 4 195/60R15 por 390
205/55R16 8 Pirelli Cinturato P7 450,00
3 Goodyear Eagle Sport 185/60R15 91V"
                rows={10}
                className="w-full px-4 py-3 text-xs text-slate-800 bg-white border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold leading-relaxed resize-none shadow-sm"
              />
              <span className="text-[10px] text-slate-400 font-semibold leading-relaxed">
                💡 Dica: Copie e cole qualquer lista de WhatsApp, e-mail, relatório de estoque ou anotações. O sistema identifica automaticamente marcas, medidas e quantidades.
              </span>
            </div>
          )}

          {/* Process button */}
          {((importMode === "file" && file) || (importMode === "text" && pastedText.trim())) && !loading && (
            <button
              onClick={handleProcessFile}
              className="mt-5 flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-gold-600 via-gold-500 to-amber-550 text-white font-extrabold rounded-xl text-sm shadow-md shadow-gold-500/10 hover:shadow-gold-500/20 border border-gold-400/20 transition-all cursor-pointer hover:scale-[1.01]"
            >
              <Play size={16} fill="white" className="stroke-none" /> Processar e Extrair Itens
            </button>
          )}

          {loading && (
            <div className="mt-5 flex flex-col items-center gap-2.5">
              <Loader2 className="animate-spin text-gold-600 h-8 w-8" />
              <p className="text-sm font-bold text-slate-800">
                {importMode === "text" ? "Interpretando o texto colado..." : "Analisando seu arquivo..."}
              </p>
              <span className="text-xs text-slate-400 max-w-sm text-center">Extraindo itens. Aguarde alguns segundos.</span>
            </div>
          )}
        </div>
      )}

      {/* ── Extracted items table ──────────────────────────────── */}
      {extractedItems.length > 0 && (
        <div className="space-y-4 animate-fadeIn">

          {/* Review alert + company badge */}
          <div className="bg-gold-50/30 rounded-xl p-3 border border-gold-200/40 flex flex-col sm:flex-row sm:items-center gap-2">
            <CircleAlert className="text-gold-600 shrink-0 h-5 w-5" />
            <p className="text-xs text-slate-700 font-semibold flex-1">
              <strong>Módulo de Verificação:</strong> Revise os itens extraídos. Você pode editar marcas, medidas e quantidades antes de confirmar a importação.
            </p>
            {selectedCompanyName && (
              <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-100 shrink-0">
                <Building2 size={10} /> {selectedCompanyName}
              </span>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
              <thead className="bg-slate-50 text-slate-450 text-[10px] uppercase tracking-wider font-extrabold border-b border-slate-100">
                <tr>
                  <th className="py-3 px-4 font-black">Marca</th>
                  <th className="py-3 px-4 font-black">Modelo</th>
                  <th className="py-3 px-4 font-black">Medida</th>
                  <th className="py-3 px-4 font-black">Empresa</th>
                  <th className="py-3 px-4 text-center font-black">Qtd.</th>
                  <th className="py-3 px-4 text-right font-black">Preço</th>
                  <th className="py-3 px-4 font-black">Obs.</th>
                  <th className="py-3 px-4 text-center font-black">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {extractedItems.map((item) => (
                  <tr key={item.virtualId} className="hover:bg-gold-50/10 text-slate-800 transition-colors">

                    {/* Brand */}
                    <td className="py-2.5 px-4">
                      {editingId === item.virtualId
                        ? <input type="text" value={editBrand} onChange={e => setEditBrand(e.target.value)} className="w-full px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 outline-none" />
                        : <span className="font-bold text-slate-900 uppercase">{item.brand}</span>
                      }
                    </td>

                    {/* Model */}
                    <td className="py-2.5 px-4 font-semibold text-slate-650">
                      {editingId === item.virtualId
                        ? <input type="text" value={editModel} onChange={e => setEditModel(e.target.value)} className="w-full px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 outline-none" />
                        : item.model
                      }
                    </td>

                    {/* Size */}
                    <td className="py-2.5 px-4 font-bold text-slate-800 font-mono">
                      {editingId === item.virtualId
                        ? <input type="text" value={editSize} onChange={e => setEditSize(e.target.value)} className="w-full px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 outline-none" placeholder="Ex: 205/55R16" />
                        : item.size
                      }
                    </td>

                    {/* Company (Empresa) */}
                    <td className="py-2.5 px-4 text-xs font-semibold text-slate-500">
                      {(item as any).companyName || selectedCompanyName || <span className="text-slate-300">—</span>}
                    </td>

                    {/* Quantity */}
                    <td className="py-2.5 px-4 text-center">
                      {editingId === item.virtualId
                        ? <input type="number" value={editQuantity} min={0} onChange={e => setEditQuantity(parseInt(e.target.value) || 0)} className="w-20 px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-center outline-none" />
                        : (
                          <span className={`inline-block px-2.5 py-0.5 rounded-lg border font-black text-xs ${item.quantity > 5 ? "bg-gold-500/10 text-gold-700 border-gold-400/20" : "bg-amber-100/60 text-amber-800 border-amber-300/30"}`}>
                            {item.quantity} un
                          </span>
                        )
                      }
                    </td>

                    {/* Price */}
                    <td className="py-2.5 px-4 text-right font-bold text-slate-900">
                      {editingId === item.virtualId
                        ? <input type="number" step="0.01" value={editPrice} onChange={e => setEditPrice(parseFloat(e.target.value) || 0)} className="w-24 px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-right outline-none" />
                        : item.price > 0 ? formatBRL(item.price) : "—"
                      }
                    </td>

                    {/* Notes */}
                    <td className="py-2.5 px-4 text-xs text-slate-500 truncate max-w-[130px]">
                      {editingId === item.virtualId
                        ? <input type="text" value={editNotes} onChange={e => setEditNotes(e.target.value)} className="w-full px-2 py-1 text-xs border border-gold-300 rounded focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 outline-none" placeholder="Ex: 91V" />
                        : item.notes || <span className="text-slate-300">—</span>
                      }
                    </td>

                    {/* Actions */}
                    <td className="py-2.5 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {editingId === item.virtualId ? (
                          <>
                            <button onClick={() => saveRowEdit(item.virtualId)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="Salvar">
                              <Check size={14} className="stroke-[3px]" />
                            </button>
                            <button onClick={() => setEditingId(null)} className="p-1 px-1.5 text-[10px] font-bold text-slate-500 hover:bg-slate-100 rounded">
                              Voltar
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(item)} className="p-1 px-1.5 text-xs font-bold text-gold-700 bg-gold-400/10 hover:bg-gold-400/20 rounded border border-gold-300/30" title="Editar">
                              <Edit2 size={11} fill="currentColor" className="stroke-none" />
                            </button>
                            <button onClick={() => deleteRow(item.virtualId)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remover">
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row items-center gap-3 justify-end pt-2">
            <button
              onClick={handleReset}
              className="px-4 py-2 text-xs font-bold text-slate-600 bg-white hover:bg-slate-50 rounded-xl border border-slate-200 transition-all w-full sm:w-auto text-center cursor-pointer"
            >
              Descartar e Voltar
            </button>
            <button
              onClick={handleConfirmImport}
              disabled={loading || extractedItems.length === 0}
              className="flex items-center justify-center gap-2 px-6 py-2 rounded-xl text-white font-extrabold bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-700 hover:to-emerald-600 shadow-md shadow-emerald-550/10 hover:shadow-emerald-550/20 transition-all w-full sm:w-auto cursor-pointer disabled:opacity-50"
            >
              {loading ? (
                <><Loader2 className="animate-spin h-4 w-4" /> Integrando...</>
              ) : (
                <><Check size={16} className="stroke-[3px]" /> Confirmar e Integrar {extractedItems.length} {extractedItems.length === 1 ? "Item" : "Itens"} → {selectedCompanyName || "Estoque"}</>
              )}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
