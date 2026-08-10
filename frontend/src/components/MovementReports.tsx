import { useState, useMemo } from "react";
import { MovementLog } from "../types";
import { exportToCSV, formatDate, matchesTireSize } from "../utils";
import {
  Download,
  FileSpreadsheet,
  Search,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  FileUp,
  Wrench,
  Activity,
  User,
  Calendar,
  Layers,
  Trash2
} from "lucide-react";

interface MovementReportsProps {
  logs: MovementLog[];
  isAdmin: boolean;
  onDeleteLog?: (logId: string) => Promise<void>;
  onClearLogs?: () => Promise<void>;
}

export default function MovementReports({ logs, isAdmin, onDeleteLog, onClearLogs }: MovementReportsProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");

  // Filtering logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const matchesSearch = searchTerm === "" || 
        log.brand.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
        matchesTireSize(log.size, searchTerm) ||
        log.reason.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.userEmail.toLowerCase().includes(searchTerm.toLowerCase());
        
      const matchesType = typeFilter === "ALL" ||
        (typeFilter === "TRANSFERENCIA" ? log.type.startsWith("TRANSFERENCIA") : log.type === typeFilter);

      return matchesSearch && matchesType;
    });
  }, [logs, searchTerm, typeFilter]);

  // Movement Statistics Calculations
  const stats = useMemo(() => {
    let entriesCount = 0;
    let exitsCount = 0;
    let importsCount = 0;
    let adjustmentsCount = 0;
    let transfersCount = 0;

    filteredLogs.forEach(log => {
      const absoluteQty = Math.abs(log.quantity);
      if (log.type === "ENTRADA") {
        entriesCount += absoluteQty;
      } else if (log.type === "SAIDA") {
        exitsCount += absoluteQty;
      } else if (log.type === "IMPORTACAO") {
        importsCount += absoluteQty;
      } else if (log.type === "AJUSTE") {
        adjustmentsCount += absoluteQty;
      } else if (log.type === "TRANSFERENCIA_SAIDA" || log.type === "TRANSFERENCIA_ENTRADA") {
        transfersCount += absoluteQty;
      }
    });

    return { entriesCount, exitsCount, importsCount, adjustmentsCount, transfersCount };
  }, [filteredLogs]);

  // Export CSV handler
  const handleDownloadCSV = () => {
    // Columns to Map in Excel
    const columns = [
      { key: "timestamp", label: "Data/Hora" },
      { key: "sku", label: "Código SKU / ID" },
      { key: "brand", label: "Marca do Pneu" },
      { key: "model", label: "Modelo" },
      { key: "size", label: "Medida" },
      { key: "type", label: "Operação" },
      { key: "quantity", label: "Qtde Alterada" },
      { key: "balanceAfter", label: "Saldo de Estoque" },
      { key: "userEmail", label: "Usuário/Operador" },
      { key: "reason", label: "Histórico/Motivo" }
    ];

    // Map logs to format before saving
    const dataToExport = filteredLogs.map(log => ({
      ...log,
      timestamp: formatDate(log.timestamp),
      type: log.type === "ENTRADA"
        ? "Entrada de Pneus"
        : log.type === "SAIDA"
          ? "Saída de Pneus"
          : log.type === "IMPORTACAO"
            ? "Importação de PDF de Compra"
            : log.type === "TRANSFERENCIA_SAIDA"
              ? "Saída por Transferência entre Empresas"
              : log.type === "TRANSFERENCIA_ENTRADA"
                ? "Entrada por Transferência entre Empresas"
                : "Ajuste Manual de Cadastro"
    }));

    exportToCSV(dataToExport, columns, `Central_Stoque_Relatorio_Movimentacao_${Date.now()}`);
  };

  return (
    <div className="space-y-6">
      
      {/* Search and Quick Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        
        {/* Entries metric */}
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-emerald-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5 font-sans">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100/60 shadow-sm">
            <ArrowDownLeft size={20} className="stroke-[2.5px]" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Total Entradas</span>
            <p className="text-lg font-black text-slate-900 font-mono leading-none mt-1">+{stats.entriesCount}</p>
          </div>
        </div>

        {/* Exits metric */}
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-red-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5 font-sans">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100/60 shadow-sm">
            <ArrowUpRight size={20} className="stroke-[2.5px]" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Total Saídas</span>
            <p className="text-lg font-black text-slate-900 font-mono leading-none mt-1">-{stats.exitsCount}</p>
          </div>
        </div>

        {/* Imports metric */}
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-gold-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5 font-sans">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-gold-50 text-gold-600 flex items-center justify-center border border-gold-100/60 shadow-sm">
            <FileUp size={20} className="stroke-[2.5px] text-gold-605" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Via PDF AI</span>
            <p className="text-lg font-black text-gold-600 font-mono leading-none mt-1">+{stats.importsCount}</p>
          </div>
        </div>

        {/* Adjustments metric */}
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-slate-400 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5 font-sans">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center border border-slate-200/50 shadow-sm">
            <Wrench size={18} className="stroke-[2.5px]" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Ajustados</span>
            <p className="text-lg font-black text-slate-800 font-mono leading-none mt-1">{stats.adjustmentsCount} un</p>
          </div>
        </div>

        {/* Transfers metric */}
        <div className="bg-white p-4 rounded-2xl border-l-4 border-l-blue-500 border-y border-r border-slate-200/80 shadow-xs flex items-center gap-3.5 font-sans">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100/60 shadow-sm">
            <ArrowLeftRight size={18} className="stroke-[2.5px]" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Transferências</span>
            <p className="text-lg font-black text-blue-700 font-mono leading-none mt-1">{stats.transfersCount} un</p>
          </div>
        </div>

      </div>

      {/* Control bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 font-sans">
        
        {/* Search */}
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
            <Search size={16} className="text-gold-600" />
          </div>
          <input
            type="text"
            placeholder="Pesquise por histórico, SKU, marca, medida ou colaborador..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 pr-3 py-2 w-full border border-slate-200 rounded-xl bg-slate-50/50 text-slate-900 font-semibold text-xs focus:bg-white focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 outline-none transition-all"
          />
        </div>

        {/* Filter & download */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 font-bold uppercase tracking-wider">
            <span>Operação:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-slate-900 font-bold text-xs cursor-pointer"
            >
              <option value="ALL">Todas as Operações</option>
              <option value="ENTRADA">Apenas Entradas</option>
              <option value="SAIDA">Apenas Saídas</option>
              <option value="IMPORTACAO">Apenas Importação PDF</option>
              <option value="AJUSTE">Apenas Editados/Ajustes</option>
              <option value="TRANSFERENCIA">Apenas Transferências</option>
            </select>
          </div>

          {isAdmin && (
            <button
              onClick={() => {
                if (window.confirm("Tem certeza que deseja limpar todo o histórico de auditoria? Esta ação não pode ser desfeita.")) {
                  onClearLogs?.();
                }
              }}
              disabled={logs.length === 0}
              className="flex items-center justify-center gap-1.5 px-4 py-2 font-black text-xs rounded-xl text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 transition-all shadow-md cursor-pointer hover:scale-[1.01]"
              title="Limpar todo o histórico de auditoria"
            >
              <Trash2 size={14} className="stroke-[2px]" /> Limpar Histórico
            </button>
          )}

          <button
            onClick={handleDownloadCSV}
            disabled={filteredLogs.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2 font-black text-xs rounded-xl text-white bg-gradient-to-r from-gold-600 to-amber-500 hover:from-gold-700 hover:to-amber-600 disabled:opacity-40 border border-gold-400/20 transition-all shadow-md shadow-gold-500/10 cursor-pointer hover:scale-[1.01]"
          >
            <Download size={14} className="stroke-[2.5px]" /> Baixar Relatório (CSV)
          </button>
        </div>

      </div>

      {/* Main Reports Log list */}
      <div className="bg-white rounded-2xl border-t-2 border-t-gold-500/80 border-x border-b border-slate-200 shadow-[0_4px_25px_rgba(0,0,0,0.015)] overflow-hidden font-sans">
        {filteredLogs.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center text-slate-400">
            <Activity size={44} className="stroke-[1.5px] text-slate-200 mb-2" />
            <p className="font-bold text-slate-800 text-base">Nenhum registro de movimentação</p>
            <p className="text-xs text-slate-500 mt-1 px-4">
              Todos os registros e alterações físicas do seu estoque de pneus serão reportados aqui de forma protegida.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-left text-xs">
              <thead className="bg-slate-50 text-slate-400 text-[10px] uppercase font-extrabold tracking-widest border-b border-slate-100">
                <tr>
                  <th className="py-3 px-5 font-black">Data e Hora</th>
                  <th className="py-3 px-5 font-black">SKU / ID</th>
                  <th className="py-3 px-5 font-black">Estoque</th>
                  <th className="py-3 px-5 font-black">Operação</th>
                  <th className="py-3 px-5 text-center font-black">Quantidade</th>
                  <th className="py-3 px-5 text-center font-black">Saldo Restante</th>
                  <th className="py-3 px-5 font-black">Colaborador</th>
                  <th className="py-3 px-5 font-black">Motivação / Descrição</th>
                  {isAdmin && <th className="py-3 px-5 text-center font-black">Ações</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-800">
                {filteredLogs.map(log => {
                  
                  // Styles for each operation type
                  let typeBadge = "";
                  if (log.type === "ENTRADA") {
                    typeBadge = "bg-emerald-50 text-emerald-800 border-emerald-100/80";
                  } else if (log.type === "SAIDA") {
                    typeBadge = "bg-red-50 text-red-800 border-red-100/85";
                  } else if (log.type === "IMPORTACAO") {
                    typeBadge = "bg-gold-50 text-gold-800 border-gold-200/50";
                  } else if (log.type === "TRANSFERENCIA_SAIDA" || log.type === "TRANSFERENCIA_ENTRADA") {
                    typeBadge = "bg-blue-50 text-blue-800 border-blue-100/85";
                  } else {
                    typeBadge = "bg-amber-50 text-amber-800 border-amber-100/80";
                  }

                  return (
                    <tr key={log.id} className="hover:bg-gold-50/10 text-slate-800 transition-colors border-b border-slate-100/65">
                      
                      {/* Date/Time column */}
                      <td className="py-2.5 px-5 font-mono text-slate-500 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold">
                          <Calendar size={11} className="text-gold-600" />
                          {formatDate(log.timestamp)}
                        </div>
                      </td>

                      {/* Code SKU / ID column */}
                      <td className="py-2.5 px-5 font-bold font-mono text-[10px] text-slate-900">
                        <span className="inline-block px-2.5 py-0.5 text-gold-700 bg-gold-400/10 rounded-lg border border-gold-300/20 font-mono tracking-wider font-extrabold uppercase">
                          {log.sku}
                        </span>
                      </td>

                      {/* Stock Item Name Details column */}
                      <td className="py-2.5 px-5 font-sans">
                        <div className="font-bold text-slate-900 uppercase text-xs">{log.brand}</div>
                        <div className="text-[10px] text-slate-500 font-bold">{log.model} • <span className="font-mono text-slate-400">{log.size}</span></div>
                      </td>

                      {/* Operational type column */}
                      <td className="py-2.5 px-5 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-lg text-[9px] font-black border uppercase tracking-wider ${typeBadge}`}>
                          {log.type}
                        </span>
                      </td>

                      {/* Quantity affected column */}
                      <td className="py-2.5 px-5 text-center font-extrabold font-mono text-xs">
                        {log.quantity > 0 ? (
                          <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">+ {log.quantity}</span>
                        ) : log.quantity < 0 ? (
                          <span className="text-red-500 bg-red-50 px-1.5 py-0.5 rounded">{log.quantity}</span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>

                      {/* Resulting balance unit stock column */}
                      <td className="py-2.5 px-5 text-center font-bold">
                        <span className="inline-block px-2 py-0.5 bg-slate-50 text-slate-700 rounded-lg text-[10px] font-mono border border-slate-200">
                          {log.balanceAfter} un
                        </span>
                      </td>

                      {/* Colaborador column */}
                      <td className="py-2.5 px-5 text-slate-600 font-medium">
                        <div className="flex items-center gap-1.5 max-w-[150px] truncate" title={log.userEmail}>
                          <User size={11} className="text-gold-600 shrink-0" />
                          <span className="truncate max-w-full text-[10px] font-bold">
                            {log.userEmail.split('@')[0]}
                          </span>
                        </div>
                      </td>

                      {/* Detailed reason column */}
                      <td className="py-2.5 px-5 text-xs text-slate-600 font-semibold max-w-[200px] truncate" title={log.reason}>
                        {log.reason || <span className="text-slate-350 italic">Nenhuma descrição</span>}
                      </td>

                      {/* Conditional admin action column */}
                      {isAdmin && (
                        <td className="py-2.5 px-5 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm("Deseja realmente excluir este registro de movimentação de forma permanente?")) {
                                onDeleteLog?.(log.id);
                              }
                            }}
                            className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-all cursor-pointer inline-flex items-center justify-center"
                            title="Excluir registro permanentemente"
                          >
                            <Trash2 size={13} className="stroke-[2.5px]" />
                          </button>
                        </td>
                      )}

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
