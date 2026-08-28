import React, { useMemo, useState } from "react";
import { StockItem, MovementLog, Company } from "../types";
import { availableQuantity, formatBRL } from "../utils";
import { TrendingUp, TrendingDown, Package, AlertTriangle, RefreshCw, BarChart2, X } from "lucide-react";

interface DashboardAnalyticsProps {
  items: StockItem[];
  movements: MovementLog[];
  companies: Company[];
  user: { role: string; companyId?: string };
}

export default function DashboardAnalytics({ items, movements, companies, user }: DashboardAnalyticsProps) {
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<7 | 15 | 30>(7);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const [suggestionCompanyFilter, setSuggestionCompanyFilter] = useState<string>("ALL");

  // Filter items by company if the user is an operator/alimentador
  const filteredItems = useMemo(() => {
    if (user.role === "admin" || !user.companyId) return items;
    return items.filter(item => item.companyId === user.companyId);
  }, [items, user]);

  const filteredMovements = useMemo(() => {
    if (user.role === "admin" || !user.companyId) return movements;
    return movements.filter(m => m.companyId === user.companyId);
  }, [movements, user]);

  // ==========================================
  // 1. SMART REORDER (Demand Forecasting)
  // ==========================================
  const reorderSuggestions = useMemo(() => {
    // Group movements of type SAIDA by SKU in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const salesVolumeMap = new Map<string, number>();

    filteredMovements.forEach(m => {
      if (m.type !== "SAIDA") return;
      
      let date = new Date();
      if (m.timestamp?.seconds) {
        date = new Date(m.timestamp.seconds * 1000);
      } else if (m.timestamp) {
        date = new Date(m.timestamp);
      }

      if (date >= thirtyDaysAgo) {
        // Quantities are logged as negative on SAIDA, convert to positive for sales volume
        const qty = Math.abs(m.quantity);
        salesVolumeMap.set(m.sku, (salesVolumeMap.get(m.sku) || 0) + qty);
      }
    });

    // Group current quantities by SKU.
    //
    // Aqui o saldo que conta é o LIVRE, não o físico: a pergunta desta tela é
    // "vou ficar sem pneu para vender?", e pneu reservado para um cliente ou
    // para outra filial não vai atender venda nenhuma. Com o total físico, um
    // pneu inteiramente reservado aparecia como estoque saudável e a sugestão
    // de compra nunca vinha — até o dia em que faltava no balcão.
    const skuStockMap = new Map<string, { brand: string; model: string; size: string; qty: number; id: string; companyId: string; companyName: string }>();
    filteredItems.forEach(item => {
      const free = availableQuantity(item);
      const existing = skuStockMap.get(item.sku);
      if (existing) {
        existing.qty += free;
      } else {
        skuStockMap.set(item.sku, {
          brand: item.brand,
          model: item.model,
          size: item.size,
          qty: free,
          id: item.id,
          companyId: item.companyId || "",
          companyName: item.companyName || ""
        });
      }
    });

    const suggestions: {
      sku: string;
      brand: string;
      model: string;
      size: string;
      currentQty: number;
      monthlySales: number;
      daysRemaining: number;
      suggestedBuy: number;
      companyId: string;
      companyName: string;
    }[] = [];

    skuStockMap.forEach((stock, sku) => {
      const monthlySales = salesVolumeMap.get(sku) || 0;
      const dailySalesRate = monthlySales / 30;
      
      let daysRemaining = Infinity;
      if (dailySalesRate > 0) {
        daysRemaining = Math.round(stock.qty / dailySalesRate);
      }

      // Recommend restocking if stock runs out in 15 days or less, or quantity is critical (<= 4)
      const needsRestock = daysRemaining <= 15 || stock.qty <= 4;
      
      if (needsRestock) {
        // Target is 45 days of safety stock
        const targetStock = Math.ceil(dailySalesRate * 45) || 8;
        const suggestedBuy = Math.max(0, targetStock - stock.qty);

        if (suggestedBuy > 0) {
          suggestions.push({
            sku,
            brand: stock.brand,
            model: stock.model,
            size: stock.size,
            currentQty: stock.qty,
            monthlySales,
            daysRemaining,
            suggestedBuy,
            companyId: stock.companyId,
            companyName: stock.companyName
          });
        }
      }
    });

    return suggestions.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }, [filteredItems, filteredMovements]);

  const filteredSuggestions = useMemo(() => {
    if (suggestionCompanyFilter === "ALL") return reorderSuggestions;
    return reorderSuggestions.filter(s => s.companyId === suggestionCompanyFilter);
  }, [reorderSuggestions, suggestionCompanyFilter]);

  // ==========================================
  // 2. LINE CHART (Movements Flow)
  // ==========================================
  const lineChartData = useMemo(() => {
    const days = timeRange;
    const data: { label: string; entradas: number; saidas: number }[] = [];
    const dateMap = new Map<string, { in: number; out: number }>();

    // Initialize list of dates
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      dateMap.set(key, { in: 0, out: 0 });
    }

    filteredMovements.forEach(m => {
      let mDate = new Date();
      if (m.timestamp?.seconds) {
        mDate = new Date(m.timestamp.seconds * 1000);
      } else if (m.timestamp) {
        mDate = new Date(m.timestamp);
      }

      const key = mDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      if (dateMap.has(key)) {
        const val = dateMap.get(key)!;
        if (m.type === "ENTRADA" || m.type === "IMPORTACAO") {
          val.in += Math.abs(m.quantity);
        } else if (m.type === "SAIDA") {
          val.out += Math.abs(m.quantity);
        }
      }
    });

    dateMap.forEach((val, label) => {
      data.push({ label, entradas: val.in, saidas: val.out });
    });

    return data;
  }, [filteredMovements, timeRange]);

  const maxLineVal = useMemo(() => {
    let max = 10;
    lineChartData.forEach(d => {
      if (d.entradas > max) max = d.entradas;
      if (d.saidas > max) max = d.saidas;
    });
    return Math.ceil(max * 1.15); // Add 15% margin
  }, [lineChartData]);

  // ==========================================
  // 3. DOUGHNUT CHART (Brand Distribution)
  // ==========================================
  const brandChartData = useMemo(() => {
    const map = new Map<string, number>();
    let totalStock = 0;

    filteredItems.forEach(item => {
      const bName = item.brand.toUpperCase().trim() || "DESCONHECIDA";
      map.set(bName, (map.get(bName) || 0) + item.quantity);
      totalStock += item.quantity;
    });

    const sorted = Array.from(map.entries())
      .sort((a, b) => b[1] - a[1]);

    const topFive = sorted.slice(0, 4);
    const othersQty = sorted.slice(4).reduce((acc, curr) => acc + curr[1], 0);

    const segments: { label: string; qty: number; percent: number; color: string }[] = [];
    const colors = ["#d49321", "#3b82f6", "#10b981", "#ef4444", "#a855f7", "#64748b"];

    topFive.forEach(([label, qty], i) => {
      segments.push({
        label,
        qty,
        percent: totalStock > 0 ? (qty / totalStock) * 100 : 0,
        color: colors[i]
      });
    });

    if (othersQty > 0) {
      segments.push({
        label: "OUTROS",
        qty: othersQty,
        percent: totalStock > 0 ? (othersQty / totalStock) * 100 : 0,
        color: colors[5]
      });
    }

    return { segments, totalStock };
  }, [filteredItems]);

  // ==========================================
  // 4. BAR CHART (Branch Comparison - Admin Only)
  // ==========================================
  const barChartData = useMemo(() => {
    const map = new Map<string, { name: string; qty: number }>();
    
    // Initialize all companies with 0 quantity
    companies.forEach(c => {
      map.set(c.id, { name: c.name, qty: 0 });
    });

    filteredItems.forEach(item => {
      if (item.companyId && map.has(item.companyId)) {
        map.get(item.companyId)!.qty += item.quantity;
      }
    });

    return Array.from(map.values()).sort((a, b) => b.qty - a.qty);
  }, [filteredItems, companies]);

  const maxBarVal = useMemo(() => {
    let max = 10;
    barChartData.forEach(d => {
      if (d.qty > max) max = d.qty;
    });
    return Math.ceil(max * 1.1);
  }, [barChartData]);

  // Doughnut math helper
  let accumulatedAngle = 0;

  return (
    <div className="space-y-6 animate-fadeIn font-sans">
      
      {/* Time range selection bar */}
      <div className="flex items-center justify-between bg-white px-5 py-3 rounded-2xl border border-slate-200 shadow-sm">
        <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-2">
          <BarChart2 size={16} className="text-gold-600" /> Relatório Analítico de Estoque
        </h3>
        <div className="flex gap-1.5 p-1 bg-slate-100 rounded-xl border border-slate-200">
          {([7, 15, 30] as const).map(days => (
            <button
              key={days}
              type="button"
              onClick={() => setTimeRange(days)}
              className={`px-3 py-1 text-[10px] font-black rounded-lg transition-all cursor-pointer ${
                timeRange === days 
                  ? "bg-white text-gold-700 shadow-xs border border-slate-200" 
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {days} DIAS
            </button>
          ))}
        </div>
      </div>

      {/* Main Graphics Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* SVG Line Chart: Flows */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Fluxo de Inventário</span>
              <span className="text-base font-black text-slate-900 mt-0.5 block">Entradas vs Saídas</span>
            </div>
            <div className="flex gap-3 text-[10px] font-black uppercase">
              <span className="flex items-center gap-1.5 text-emerald-600">
                <span className="h-3 w-3 rounded-full bg-emerald-500"></span> Entradas
              </span>
              <span className="flex items-center gap-1.5 text-red-500">
                <span className="h-3 w-3 rounded-full bg-red-500"></span> Saídas
              </span>
            </div>
          </div>

          {/* SVG Line Canvas */}
          <div className="h-60 relative w-full pt-4">
            <svg viewBox="0 0 500 220" className="w-full h-full overflow-visible">
              {/* Horizontal grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
                const y = 20 + r * 160;
                const gridVal = Math.round(maxLineVal * (1 - r));
                return (
                  <g key={i}>
                    <line x1="35" y1={y} x2="480" y2={y} stroke="#f1f5f9" strokeWidth="1" strokeDasharray="4 4" />
                    <text x="25" y={y + 3} textAnchor="end" fill="#94a3b8" className="text-[9px] font-bold font-mono">{gridVal}</text>
                  </g>
                );
              })}

              {/* Draw Line paths */}
              {(() => {
                const len = lineChartData.length;
                const stepX = 430 / (len - 1 || 1);
                
                const pointsIn = lineChartData.map((d, i) => {
                  const x = 40 + i * stepX;
                  const y = 180 - (d.entradas / maxLineVal) * 160;
                  return { x, y };
                });

                const pointsOut = lineChartData.map((d, i) => {
                  const x = 40 + i * stepX;
                  const y = 180 - (d.saidas / maxLineVal) * 160;
                  return { x, y };
                });

                const dIn = pointsIn.length > 0 ? `M ${pointsIn[0].x} ${pointsIn[0].y} ` + pointsIn.slice(1).map(p => `L ${p.x} ${p.y}`).join(" ") : "";
                const dOut = pointsOut.length > 0 ? `M ${pointsOut[0].x} ${pointsOut[0].y} ` + pointsOut.slice(1).map(p => `L ${p.x} ${p.y}`).join(" ") : "";

                return (
                  <>
                    {/* Paths */}
                    {dIn && <path d={dIn} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
                    {dOut && <path d={dOut} fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}

                    {/* Nodes (Dots) */}
                    {pointsIn.map((p, i) => (
                      <circle key={`in-${i}`} cx={p.x} cy={p.y} r="3.5" fill="#10b981" stroke="#fff" strokeWidth="1.5" className="hover:scale-[1.5] transition-all cursor-pointer" />
                    ))}
                    {pointsOut.map((p, i) => (
                      <circle key={`out-${i}`} cx={p.x} cy={p.y} r="3.5" fill="#ef4444" stroke="#fff" strokeWidth="1.5" className="hover:scale-[1.5] transition-all cursor-pointer" />
                    ))}

                    {/* X axis labels */}
                    {lineChartData.map((d, i) => {
                      const x = 40 + i * stepX;
                      // Display labels on alternating nodes if range is wide
                      if (len > 10 && i % 2 !== 0) return null;
                      return (
                        <text key={i} x={x} y="205" textAnchor="middle" fill="#64748b" className="text-[9px] font-bold font-mono">
                          {d.label}
                        </text>
                      );
                    })}
                  </>
                );
              })()}
            </svg>
          </div>
        </div>

        {/* Brand Distribution Doughnut Chart */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex flex-col md:flex-row gap-6 items-center">
          <div className="flex-1 space-y-3 w-full">
            <div>
              <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Estoque por Marca</span>
              <span className="text-base font-black text-slate-900 mt-0.5 block">Mix de Produtos</span>
            </div>
            
            {/* Color labels list */}
            <div className="space-y-2 mt-4">
              {brandChartData.segments.map((s, idx) => (
                <div 
                  key={s.label}
                  onMouseEnter={() => setHoveredSegment(idx)}
                  onMouseLeave={() => setHoveredSegment(null)}
                  className={`flex items-center justify-between p-2 rounded-xl border border-transparent transition-all cursor-pointer ${
                    hoveredSegment === idx ? "bg-slate-50 border-slate-200" : ""
                  }`}
                >
                  <span className="flex items-center gap-2 text-xs font-bold text-slate-800 uppercase">
                    <span className="h-3 w-3 rounded-md" style={{ backgroundColor: s.color }}></span>
                    {s.label}
                  </span>
                  <span className="text-xs font-black text-slate-950 font-mono">
                    {s.qty} un <span className="text-[10px] text-slate-400 font-medium">({s.percent.toFixed(1)}%)</span>
                  </span>
                </div>
              ))}
              {brandChartData.segments.length === 0 && (
                <p className="text-xs text-slate-400 italic">Nenhum dado cadastrado.</p>
              )}
            </div>
          </div>

          {/* Interactive SVG Doughnut rendering */}
          <div className="relative h-44 w-44 shrink-0 flex items-center justify-center">
            <svg viewBox="0 0 200 200" className="w-full h-full transform -rotate-90">
              {brandChartData.segments.map((s, idx) => {
                const angle = (s.percent / 100) * 360;
                const r = 65;
                const circ = 2 * Math.PI * r;
                const dashoffset = circ - (s.percent / 100) * circ;
                const strokeDasharray = `${circ} ${circ}`;
                const strokeDashoffset = circ - accumulatedAngle;
                
                accumulatedAngle += (s.percent / 100) * circ;

                const isHovered = hoveredSegment === idx;

                return (
                  <circle
                    key={s.label}
                    cx="100"
                    cy="100"
                    r={r}
                    fill="transparent"
                    stroke={s.color}
                    strokeWidth={isHovered ? 25 : 18}
                    strokeDasharray={strokeDasharray}
                    strokeDashoffset={strokeDashoffset}
                    className="transition-all duration-300 cursor-pointer"
                    onMouseEnter={() => setHoveredSegment(idx)}
                    onMouseLeave={() => setHoveredSegment(null)}
                  />
                );
              })}
            </svg>
            <div className="absolute flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-slate-455 font-black tracking-widest uppercase">Estoque</span>
              <span className="text-xl font-black text-slate-900">{brandChartData.totalStock}</span>
              <span className="text-[9px] text-slate-400 font-bold uppercase">unidades</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Analytics Row: Branch comparisons and Restocking AI warnings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Branch Inventory Comparison Chart */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Comparativo de Filiais</span>
            <span className="text-base font-black text-slate-900 mt-0.5 block">Total de Peças por Branch</span>
          </div>

          <div className="h-60 relative w-full pt-4">
            {barChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-xs italic">Nenhuma filial cadastrada.</div>
            ) : (
              <svg viewBox="0 0 500 220" className="w-full h-full overflow-visible">
                {/* Horizontal grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
                  const y = 20 + r * 160;
                  const gridVal = Math.round(maxBarVal * (1 - r));
                  return (
                    <g key={i}>
                      <line x1="45" y1={y} x2="480" y2={y} stroke="#f1f5f9" strokeWidth="1" strokeDasharray="4 4" />
                      <text x="35" y={y + 3} textAnchor="end" fill="#94a3b8" className="text-[9px] font-bold font-mono">{gridVal}</text>
                    </g>
                  );
                })}

                {/* Bars rendering */}
                {(() => {
                  const len = barChartData.length;
                  const barWidth = Math.min(60, 320 / len);
                  const spacing = (400 - (barWidth * len)) / (len + 1);

                  return barChartData.map((d, i) => {
                    const x = 50 + spacing + i * (barWidth + spacing);
                    const h = (d.qty / maxBarVal) * 160;
                    const y = 180 - h;

                    return (
                      <g key={d.name}>
                        {/* Bar */}
                        <rect
                          x={x}
                          y={y}
                          width={barWidth}
                          height={h}
                          fill="url(#goldGradient)"
                          rx="4"
                          className="hover:opacity-85 transition-opacity cursor-pointer"
                        />
                        {/* Quantity label on top of bar */}
                        <text
                          x={x + barWidth / 2}
                          y={y - 6}
                          textAnchor="middle"
                          fill="#1e293b"
                          className="text-[10px] font-black font-mono"
                        >
                          {d.qty}
                        </text>
                        {/* X-axis Label */}
                        <text
                          x={x + barWidth / 2}
                          y="198"
                          textAnchor="middle"
                          fill="#64748b"
                          className="text-[9px] font-black uppercase max-w-[80px] truncate"
                        >
                          {d.name.split(" ")[0]}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* SVG Gradients definitions */}
                <defs>
                  <linearGradient id="goldGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#eab308" />
                    <stop offset="100%" stopColor="#d49321" />
                  </linearGradient>
                </defs>
              </svg>
            )}
          </div>
        </div>

        {/* Smart Reorder predictions panel (AI suggestions) */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block">Sugestões de Compra</span>
              <span className="text-base font-black text-slate-900 mt-0.5 block">Reposição Inteligente (Predictive)</span>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setShowAllSuggestions(true)}
                className="px-3 py-1.5 rounded-lg bg-sky-50 text-sky-700 border border-sky-200 text-xs font-bold hover:bg-sky-100 transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <Package size={14} /> Ver Todos
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {reorderSuggestions.slice(0, 5).map(s => (
              <div 
                key={s.sku}
                className="p-3 border border-slate-150 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/20 hover:border-gold-300 transition-colors"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 font-mono text-[9px] font-black text-gold-700 bg-gold-50 border border-gold-200/40 rounded uppercase">
                      {s.sku}
                    </span>
                    <span className="text-[10px] text-red-600 font-extrabold bg-red-50 px-1.5 py-0.5 rounded flex items-center gap-1 border border-red-100">
                      <AlertTriangle size={10} /> {s.currentQty} restante{s.currentQty !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <h4 className="text-xs font-black text-slate-900 uppercase">
                    {s.brand} <span className="font-semibold text-slate-600">{s.model}</span>
                  </h4>
                  <p className="text-[10px] text-slate-455 font-bold font-mono">
                    Medida: {s.size} • Vendas 30d: {s.monthlySales} un
                  </p>
                </div>

                <div className="text-left sm:text-right shrink-0 border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-150">
                  <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">Sugestão de Compra</span>
                  <span className="text-sm font-black text-emerald-700 block mt-0.5">Comprar +{s.suggestedBuy} un</span>
                  <span className="text-[9px] text-slate-455 font-bold block">
                    {s.daysRemaining === Infinity 
                      ? "Giro sem histórico de saída" 
                      : `Estoque estimado para ${s.daysRemaining} dia${s.daysRemaining !== 1 ? "s" : ""}`}
                  </span>
                </div>
              </div>
            ))}

            {reorderSuggestions.length === 0 && (
              <div className="border border-dashed border-slate-200 rounded-2xl p-8 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
                <RefreshCw size={24} className="text-slate-300 animate-spin-slow" />
                <p className="font-bold text-slate-800">Tudo sob controle!</p>
                <p className="max-w-xs text-[10px] text-slate-500">
                  O algoritmo de demanda não identificou nenhum produto precisando de reposição urgente nas próximas 2 semanas.
                </p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Modal Ver Tudo - Sugestões de Compra */}
      {showAllSuggestions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-black text-lg text-slate-900">Todas as Sugestões de Compra</h3>
                <p className="text-xs text-slate-500 font-semibold mt-0.5">Itens com estoque baixo ou projeção de falta nos próximos 15 dias</p>
              </div>
              <button 
                onClick={() => setShowAllSuggestions(false)}
                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-center gap-3">
              <span className="text-sm font-bold text-slate-700">Filtrar por Empresa:</span>
              <select 
                value={suggestionCompanyFilter}
                onChange={(e) => setSuggestionCompanyFilter(e.target.value)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-semibold bg-white outline-none focus:border-gold-400"
              >
                <option value="ALL">Todas as Empresas</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="p-5 overflow-y-auto space-y-3 flex-1">
              {filteredSuggestions.map(s => (
                <div 
                  key={s.sku}
                  className="p-3 border border-slate-150 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/20 hover:border-gold-300 transition-colors"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 font-mono text-[9px] font-black text-gold-700 bg-gold-50 border border-gold-200/40 rounded uppercase">
                        {s.sku}
                      </span>
                      <span className="text-[10px] text-red-600 font-extrabold bg-red-50 px-1.5 py-0.5 rounded flex items-center gap-1 border border-red-100">
                        <AlertTriangle size={10} /> {s.currentQty} restante{s.currentQty !== 1 ? "s" : ""}
                      </span>
                      {s.companyName && (
                         <span className="text-[9px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded uppercase">
                           {s.companyName}
                         </span>
                      )}
                    </div>
                    <h4 className="text-xs font-black text-slate-900 uppercase">
                      {s.brand} <span className="font-semibold text-slate-600">{s.model}</span>
                    </h4>
                    <p className="text-[10px] text-slate-455 font-bold font-mono">
                      Medida: {s.size} • Vendas 30d: {s.monthlySales} un
                    </p>
                  </div>

                  <div className="text-left sm:text-right shrink-0 border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-150">
                    <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">Sugestão de Compra</span>
                    <span className="text-sm font-black text-emerald-700 block mt-0.5">Comprar +{s.suggestedBuy} un</span>
                    <span className="text-[9px] text-slate-455 font-bold block">
                      {s.daysRemaining === Infinity 
                        ? "Giro sem histórico de saída" 
                        : `Estoque estimado para ${s.daysRemaining} dia${s.daysRemaining !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                </div>
              ))}

              {filteredSuggestions.length === 0 && (
                <div className="text-center py-12 text-slate-400">
                  <Package size={48} className="mx-auto text-slate-200 mb-3" />
                  <p className="font-bold text-slate-700">Nenhuma sugestão para esta empresa.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
