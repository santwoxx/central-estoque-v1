const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────
// Gravação do fechamento do dia.
//
// Separado do main.js porque aqui não há nada do Electron, só Node puro — e
// esta é a parte que mexe no disco do usuário e monta a planilha, então ela
// pode (e deve) ser testada com `node` antes de virar instalador.
//
// O QUE SAI, por dia:
//   <pasta>/<AAAA-MM>/Fechamento <escopo> <AAAA-MM-DD>.xlsx  — para ler
//   <pasta>/<AAAA-MM>/backup/fechamento-<escopo>-<AAAA-MM-DD>.json — para restaurar
//
// ANTES eram quatro CSVs soltos numa pasta por dia. Uma planilha com abas é o
// que o dono abre no fim do dia; o JSON continua existindo porque é o formato
// que a tela "Restaurar Backup" do sistema lê.
// ─────────────────────────────────────────────────────────────────

// O nome do arquivo nasce de texto que vem da TELA (nome da loja), e a tela é
// a parte que roda código de fora. Nada do que vem de lá pode virar caminho:
// basename() derruba qualquer pasta embutida e a troca deixa só caracteres
// seguros.
function safeName(value) {
  const base = path
    .basename(String(value || ''))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ._-]/g, '_')
    .trim();
  // "." e ".." atravessam o filtro (ponto é válido) e voltariam a ser caminho.
  if (/^\.+$/.test(base)) return 'arquivo';
  return base.slice(0, 120) || 'arquivo';
}

// Data do dia no formato AAAA-MM-DD, validada: é ela que vira nome de pasta.
function safeDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : null;
}

// ── Tempo ────────────────────────────────────────────────────────
// O exceljs grava Date como UTC. Sem este ajuste, uma venda das 17:42 em
// Brasília apareceria na planilha como 20:42. Desloca pelo fuso da máquina —
// que é a da loja — para a hora da planilha ser a hora do relógio da parede.
function excelLocal(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Motivo que conta como venda: o que o módulo de saída, a venda de reserva e a
// baixa aprovada gravam em `operationReason`. O `reason` longo só entra quando o
// curto não existe (registros antigos).
function isSale(m) {
  if (m.type !== 'SAIDA') return false;
  return /venda/i.test(m.operationReason || m.reason || '');
}

function moneyOf(m) {
  const total = num(m.totalAmount);
  if (total) return Math.abs(total);
  return Math.abs(num(m.unitPrice) * num(m.quantity));
}

// ── Conferência: o detector de pneu sumido ──────────────────────
//
// O saldo do cadastro tem que ser igual ao `balanceAfter` do ÚLTIMO movimento
// daquele pneu no dia. Se não é, o saldo mudou depois do último registro sem
// deixar rastro — que é exatamente a assinatura de uma baixa gravada por cima
// de outra, ou de uma alteração feita fora do sistema.
//
// Só vale para o dia de HOJE: num dia recuperado depois (computador desligado
// às 18h), o estoque lido é o de agora, não o do fim daquele dia, e a conta
// daria divergência em todo pneu que se mexeu desde então.
function computeDivergences(stock, movements) {
  const lastByKey = new Map();
  for (const m of movements) {
    if (typeof m.balanceAfter !== 'number') continue;
    const keys = [];
    if (m.stockItemId) keys.push(`id:${m.stockItemId}`);
    keys.push(`sku:${m.companyId || ''}|${String(m.sku || '').toUpperCase()}`);
    for (const k of keys) {
      const prev = lastByKey.get(k);
      if (!prev || num(m.when) >= num(prev.when)) lastByKey.set(k, m);
    }
  }

  // Um sku repetido na mesma loja deixa o casamento por código ambíguo — nesse
  // caso só vale o casamento por id do documento.
  const skuCount = new Map();
  for (const s of stock) {
    const k = `${s.companyId || ''}|${String(s.sku || '').toUpperCase()}`;
    skuCount.set(k, (skuCount.get(k) || 0) + 1);
  }

  const out = [];
  for (const s of stock) {
    const skuKey = `${s.companyId || ''}|${String(s.sku || '').toUpperCase()}`;
    let last = lastByKey.get(`id:${s.id}`);
    if (!last && skuCount.get(skuKey) === 1) last = lastByKey.get(`sku:${skuKey}`);
    if (!last) continue;

    const current = num(s.quantity);
    const expected = num(last.balanceAfter);
    if (current !== expected) {
      out.push({
        companyName: s.companyName || '',
        sku: s.sku || '',
        size: s.size || '',
        description: `${s.brand || ''} ${s.model || ''}`.trim(),
        current,
        expected,
        diff: current - expected,
        lastWhen: last.when,
        lastType: last.type || ''
      });
    }
  }
  return out;
}

// ── Estilo ───────────────────────────────────────────────────────
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
const WARN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
const MONEY = '"R$" #,##0.00';
const HOUR = 'hh:mm';
const DATETIME = 'dd/mm/yyyy hh:mm';

// Cria uma aba em forma de tabela: cabeçalho escuro congelado, filtro, largura
// de coluna e formato de número definidos uma vez só.
function addTable(wb, name, columns, rows, opts = {}) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 }
  });
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 14,
    style: c.fmt ? { numFmt: c.fmt } : {}
  }));

  const head = ws.getRow(1);
  head.font = HEADER_FONT;
  head.fill = HEADER_FILL;
  head.height = 22;
  head.alignment = { vertical: 'middle' };

  if (rows.length === 0) {
    const r = ws.addRow({ [columns[0].key]: opts.emptyText || 'Nada registrado neste dia.' });
    r.font = { italic: true, color: { argb: 'FF64748B' } };
    return ws;
  }

  rows.forEach((row) => ws.addRow(row));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  if (opts.totals) {
    const t = ws.addRow(opts.totals);
    t.font = { bold: true };
    t.fill = TOTAL_FILL;
  }
  return ws;
}

// ── A planilha ───────────────────────────────────────────────────
async function buildWorkbook(data) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fechamento Central Estoque';
  wb.created = new Date();

  const stock = Array.isArray(data.stock) ? data.stock : [];
  const movements = (Array.isArray(data.movements) ? data.movements : [])
    .slice()
    .sort((a, b) => num(a.when) - num(b.when));
  const transfers = Array.isArray(data.transfers) ? data.transfers : [];
  const pending = Array.isArray(data.pendingExits) ? data.pendingExits : [];
  const sales = movements.filter(isSale);
  const divergences = data.catchUp ? [] : computeDivergences(stock, movements);

  // ── Resumo, por loja ──
  const companyNames = new Set();
  stock.forEach((s) => companyNames.add(s.companyName || '—'));
  movements.forEach((m) => companyNames.add(m.companyName || '—'));
  pending.forEach((p) => companyNames.add(p.companyName || '—'));

  const summaryRows = Array.from(companyNames)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
    .map((name) => {
      const mv = movements.filter((m) => (m.companyName || '—') === name);
      const st = stock.filter((s) => (s.companyName || '—') === name);
      const sl = mv.filter(isSale);
      const units = st.reduce((a, s) => a + num(s.quantity), 0);
      const reserved = st.reduce((a, s) => a + num(s.reserved), 0);
      return {
        company: name,
        salesUnits: sl.reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
        salesValue: sl.reduce((a, m) => a + moneyOf(m), 0),
        otherOut: mv
          .filter((m) => m.type === 'SAIDA' && !isSale(m))
          .reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
        entries: mv
          .filter((m) => m.type === 'ENTRADA' || m.type === 'IMPORTACAO')
          .reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
        transfOut: mv
          .filter((m) => m.type === 'TRANSFERENCIA_SAIDA')
          .reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
        transfIn: mv
          .filter((m) => m.type === 'TRANSFERENCIA_ENTRADA')
          .reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
        stockUnits: units,
        reserved,
        free: Math.max(0, units - reserved),
        pendingExits: pending.filter((p) => (p.companyName || '—') === name).length,
        divergences: divergences.filter((d) => (d.companyName || '—') === name).length
      };
    });

  const sum = (k) => summaryRows.reduce((a, r) => a + num(r[k]), 0);

  const resumo = wb.addWorksheet('Resumo', { views: [{ showGridLines: false }] });
  resumo.getColumn(1).width = 28;
  for (let c = 2; c <= 12; c++) resumo.getColumn(c).width = 14;

  const title = resumo.addRow([`Fechamento do dia ${data.dayLabel || data.day}`]);
  title.font = { bold: true, size: 16 };
  resumo.addRow([`${data.scopeLabel || ''} · gerado em ${data.generatedLabel || ''} por ${data.generatedBy || ''}`])
    .font = { color: { argb: 'FF475569' } };

  if (data.catchUp) {
    const w = resumo.addRow([
      'Dia recuperado depois: o computador estava desligado às 18h. As vendas e movimentos são daquele dia; ' +
        'o ESTOQUE é o do momento da recuperação, não o do fim daquele dia.'
    ]);
    w.font = { bold: true, color: { argb: 'FF92400E' } };
    w.fill = WARN_FILL;
  }
  resumo.addRow([]);

  const header = resumo.addRow([
    'Empresa', 'Vendas (un)', 'Vendas (R$)', 'Outras saídas', 'Entradas', 'Transf. enviadas',
    'Transf. recebidas', 'Estoque (un)', 'Reservado', 'Livre', 'Baixas pendentes', 'Divergências'
  ]);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.height = 22;

  summaryRows.forEach((r) => {
    const row = resumo.addRow([
      r.company, r.salesUnits, r.salesValue, r.otherOut, r.entries, r.transfOut,
      r.transfIn, r.stockUnits, r.reserved, r.free, r.pendingExits, r.divergences
    ]);
    row.getCell(3).numFmt = MONEY;
    if (r.divergences > 0) row.getCell(12).fill = WARN_FILL;
  });

  if (summaryRows.length > 1) {
    const t = resumo.addRow([
      'TOTAL', sum('salesUnits'), sum('salesValue'), sum('otherOut'), sum('entries'), sum('transfOut'),
      sum('transfIn'), sum('stockUnits'), sum('reserved'), sum('free'), sum('pendingExits'), sum('divergences')
    ]);
    t.font = { bold: true };
    t.fill = TOTAL_FILL;
    t.getCell(3).numFmt = MONEY;
  }

  resumo.addRow([]);
  const note = data.catchUp
    ? 'Conferência de saldo não se aplica a dia recuperado (o estoque lido é o de hoje).'
    : divergences.length === 0
    ? 'Conferência: saldo do cadastro e histórico batem em todos os pneus que se mexeram hoje.'
    : `Conferência: ${divergences.length} pneu(s) com saldo diferente do último movimento — veja a aba Conferência.`;
  const n = resumo.addRow([note]);
  n.font = { bold: true, color: { argb: divergences.length ? 'FF92400E' : 'FF166534' } };

  // ── Vendas ──
  addTable(
    wb,
    'Vendas',
    [
      { header: 'HORA', key: 'when', width: 8, fmt: HOUR },
      { header: 'EMPRESA', key: 'company', width: 22 },
      { header: 'CLIENTE', key: 'party', width: 24 },
      { header: 'CPF/CNPJ', key: 'partyDoc', width: 16 },
      { header: 'PLACA', key: 'plate', width: 10 },
      { header: 'DOCUMENTO', key: 'doc', width: 12 },
      { header: 'CÓDIGO', key: 'sku', width: 18 },
      { header: 'MEDIDA', key: 'size', width: 12 },
      { header: 'MARCA / MODELO', key: 'desc', width: 26 },
      { header: 'QTD', key: 'qty', width: 6 },
      { header: 'VALOR UNIT', key: 'unit', width: 12, fmt: MONEY },
      { header: 'TOTAL', key: 'total', width: 13, fmt: MONEY },
      { header: 'PEDIDO POR', key: 'requestedBy', width: 16 },
      { header: 'APROVADO POR', key: 'approvedBy', width: 16 }
    ],
    sales.map((m) => ({
      when: excelLocal(m.when),
      company: m.companyName || '',
      party: m.partyName || '',
      partyDoc: m.partyDoc || '',
      plate: m.vehiclePlate || '',
      doc: m.docNumber || '',
      sku: m.sku || '',
      size: m.size || '',
      desc: `${m.brand || ''} ${m.model || ''}`.trim(),
      qty: Math.abs(num(m.quantity)),
      unit: num(m.unitPrice),
      total: moneyOf(m),
      requestedBy: m.requestedByName || '',
      approvedBy: m.approvedByName || m.userEmail || ''
    })),
    {
      emptyText: 'Nenhuma venda registrada neste dia.',
      totals: sales.length
        ? {
            when: null,
            company: 'TOTAL',
            qty: sales.reduce((a, m) => a + Math.abs(num(m.quantity)), 0),
            total: sales.reduce((a, m) => a + moneyOf(m), 0)
          }
        : null
    }
  );

  // ── Estoque ──
  addTable(
    wb,
    'Estoque',
    [
      { header: 'EMPRESA', key: 'company', width: 22 },
      { header: 'CÓDIGO', key: 'sku', width: 18 },
      { header: 'MEDIDA', key: 'size', width: 12 },
      { header: 'MARCA', key: 'brand', width: 14 },
      { header: 'MODELO', key: 'model', width: 22 },
      { header: 'FÍSICO', key: 'qty', width: 8 },
      { header: 'RESERVADO', key: 'reserved', width: 10 },
      { header: 'LIVRE', key: 'free', width: 8 },
      { header: 'À VISTA', key: 'cash', width: 12, fmt: MONEY },
      { header: 'A PRAZO', key: 'inst', width: 12, fmt: MONEY }
    ],
    stock
      .slice()
      .sort(
        (a, b) =>
          String(a.companyName || '').localeCompare(String(b.companyName || ''), 'pt-BR') ||
          String(a.sku || '').localeCompare(String(b.sku || ''), 'pt-BR')
      )
      .map((s) => ({
        company: s.companyName || '',
        sku: s.sku || '',
        size: s.size || '',
        brand: s.brand || '',
        model: s.model || '',
        qty: num(s.quantity),
        reserved: num(s.reserved),
        free: Math.max(0, num(s.quantity) - num(s.reserved)),
        cash: num(s.priceCash),
        inst: num(s.priceInstallment)
      })),
    {
      emptyText: 'Nenhum produto no estoque desta loja.',
      totals: stock.length
        ? {
            company: 'TOTAL',
            qty: stock.reduce((a, s) => a + num(s.quantity), 0),
            reserved: stock.reduce((a, s) => a + num(s.reserved), 0),
            free: stock.reduce((a, s) => a + Math.max(0, num(s.quantity) - num(s.reserved)), 0)
          }
        : null
    }
  );

  // ── Movimentações ──
  addTable(
    wb,
    'Movimentações',
    [
      { header: 'HORA', key: 'when', width: 8, fmt: HOUR },
      { header: 'EMPRESA', key: 'company', width: 22 },
      { header: 'TIPO', key: 'type', width: 22 },
      { header: 'MOTIVO', key: 'reason', width: 30 },
      { header: 'CÓDIGO', key: 'sku', width: 18 },
      { header: 'MEDIDA', key: 'size', width: 12 },
      { header: 'MARCA / MODELO', key: 'desc', width: 26 },
      { header: 'QTD', key: 'qty', width: 7 },
      { header: 'SALDO APÓS', key: 'after', width: 10 },
      { header: 'CLIENTE/FORNECEDOR', key: 'party', width: 22 },
      { header: 'DOCUMENTO', key: 'doc', width: 12 },
      { header: 'TOTAL', key: 'total', width: 12, fmt: MONEY },
      { header: 'OPERADOR', key: 'user', width: 24 }
    ],
    movements.map((m) => ({
      when: excelLocal(m.when),
      company: m.companyName || '',
      type: m.type || '',
      reason: m.operationReason || m.reason || '',
      sku: m.sku || '',
      size: m.size || '',
      desc: `${m.brand || ''} ${m.model || ''}`.trim(),
      qty: num(m.quantity),
      after: typeof m.balanceAfter === 'number' ? m.balanceAfter : null,
      party: m.partyName || '',
      doc: m.docNumber || '',
      total: num(m.totalAmount) || null,
      user: m.approvedByName || m.userEmail || ''
    })),
    { emptyText: 'Nenhuma movimentação neste dia.' }
  );

  // ── Transferências ──
  addTable(
    wb,
    'Transferências',
    [
      { header: 'PEDIDO', key: 'id', width: 22 },
      { header: 'SITUAÇÃO', key: 'status', width: 14 },
      { header: 'ORIGEM', key: 'source', width: 22 },
      { header: 'DESTINO', key: 'destination', width: 22 },
      { header: 'CLIENTE', key: 'customer', width: 20 },
      { header: 'ITENS', key: 'items', width: 50 },
      { header: 'QTD', key: 'qty', width: 7 },
      { header: 'SOLICITADO POR', key: 'requestedBy', width: 18 },
      { header: 'ABERTO EM', key: 'requestedAt', width: 16, fmt: DATETIME },
      { header: 'ÚLTIMA ATUALIZAÇÃO', key: 'updatedAt', width: 18, fmt: DATETIME }
    ],
    transfers.map((t) => ({
      id: t.id || '',
      status: t.status || '',
      source: t.sourceCompanyName || '',
      destination: t.destinationCompanyName || '',
      customer: t.customerName || '',
      items: (t.items || [])
        .map((i) => `${i.quantity}x ${i.sku} ${i.size} ${i.brand} ${i.model}`.replace(/\s+/g, ' ').trim())
        .join(' | '),
      qty: (t.items || []).reduce((a, i) => a + num(i.quantity), 0),
      requestedBy: t.requestedByName || '',
      requestedAt: excelLocal(t.requestedAt),
      updatedAt: excelLocal(t.updatedAt || t.requestedAt)
    })),
    { emptyText: 'Nenhuma transferência andou neste dia.' }
  );

  // ── Baixas pendentes ──
  addTable(
    wb,
    'Baixas pendentes',
    [
      { header: 'ABERTO EM', key: 'when', width: 16, fmt: DATETIME },
      { header: 'EMPRESA', key: 'company', width: 22 },
      { header: 'PEDIDO POR', key: 'by', width: 18 },
      { header: 'MOTIVO', key: 'reason', width: 20 },
      { header: 'CLIENTE', key: 'party', width: 20 },
      { header: 'ITENS', key: 'items', width: 50 },
      { header: 'QTD', key: 'qty', width: 7 },
      { header: 'VALOR', key: 'value', width: 12, fmt: MONEY }
    ],
    pending.map((p) => ({
      when: excelLocal(p.requestedAt),
      company: p.companyName || '',
      by: p.requestedByName || '',
      reason: p.reason || '',
      party: p.partyName || '',
      items: (p.items || [])
        .map((i) => `${i.quantity}x ${i.sku} ${i.size} ${i.brand} ${i.model}`.replace(/\s+/g, ' ').trim())
        .join(' | '),
      qty: num(p.totalUnits),
      value: num(p.totalAmount)
    })),
    { emptyText: 'Nenhuma baixa esperando aprovação — nenhum pneu preso por pedido.' }
  );

  // ── Conferência ──
  addTable(
    wb,
    'Conferência',
    [
      { header: 'EMPRESA', key: 'company', width: 22 },
      { header: 'CÓDIGO', key: 'sku', width: 18 },
      { header: 'MEDIDA', key: 'size', width: 12 },
      { header: 'DESCRIÇÃO', key: 'desc', width: 26 },
      { header: 'SALDO NO CADASTRO', key: 'current', width: 18 },
      { header: 'SALDO PELO HISTÓRICO', key: 'expected', width: 20 },
      { header: 'DIFERENÇA', key: 'diff', width: 11 },
      { header: 'ÚLTIMO MOVIMENTO', key: 'lastWhen', width: 16, fmt: HOUR },
      { header: 'TIPO', key: 'lastType', width: 22 }
    ],
    divergences.map((d) => ({
      company: d.companyName,
      sku: d.sku,
      size: d.size,
      desc: d.description,
      current: d.current,
      expected: d.expected,
      diff: d.diff,
      lastWhen: excelLocal(d.lastWhen),
      lastType: d.lastType
    })),
    {
      emptyText: data.catchUp
        ? 'Não se aplica a dia recuperado: o estoque lido é o de hoje, não o do fim daquele dia.'
        : 'Tudo certo: o saldo de cada pneu que se mexeu hoje bate com o último movimento registrado.'
    }
  );

  return { wb, stats: { sales: sales.length, salesUnits: sum('salesUnits'), salesValue: sum('salesValue'), divergences: divergences.length, pending: pending.length, stock: stock.length, movements: movements.length } };
}

// Grava a planilha e o JSON do dia. Devolve onde gravou e o resumo para a
// notificação do Windows.
async function writeClosing({ baseFolder, data }) {
  if (!baseFolder) throw new Error('Pasta de destino não definida.');
  const day = safeDay(data && data.day);
  if (!day) throw new Error('Data do fechamento inválida.');

  const scope = safeName(data.scopeLabel || 'loja');
  const monthFolder = path.join(baseFolder, day.slice(0, 7));
  const backupFolder = path.join(monthFolder, 'backup');
  fs.mkdirSync(backupFolder, { recursive: true });

  const { wb, stats } = await buildWorkbook(data);
  const xlsxName = safeName(`Fechamento ${scope} ${day}.xlsx`);
  const xlsxPath = path.join(monthFolder, xlsxName);
  await wb.xlsx.writeFile(xlsxPath);

  // O JSON e a copia que RESTAURA: `items` no topo e exatamente o formato que a
  // tela "Restaurar Backup" do sistema le.
  const jsonName = safeName(`fechamento-${scope.replace(/\s+/g, '-').toLowerCase()}-${day}.json`);
  fs.writeFileSync(
    path.join(backupFolder, jsonName),
    JSON.stringify(
      {
        date: data.generatedAt || new Date().toISOString(),
        dayClosed: day,
        companyName: data.scopeLabel || '',
        catchUp: !!data.catchUp,
        totalItems: (data.rawStock || []).length,
        items: data.rawStock || [],
        movements: data.movements || [],
        transfers: data.transfers || [],
        pendingExits: data.pendingExits || []
      },
      null,
      2
    ),
    'utf8'
  );

  return { folder: monthFolder, file: xlsxPath, stats };
}

module.exports = { safeName, safeDay, computeDivergences, buildWorkbook, writeClosing, isSale };
