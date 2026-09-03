import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  setDoc,
  Timestamp
} from 'firebase/firestore';

// ─────────────────────────────────────────────────────────────────
// FECHAMENTO CENTRAL ESTOQUE
//
// Programa de uma tarefa so: entrar com a credencial da loja, ler o estoque e
// o movimento do dia, e gravar tudo numa pasta do computador. Nao edita nada
// no banco (a unica escrita e o proprio perfil da sessao, exigido pelas regras
// do Firestore para poder LER movimentacoes e transferencias).
// ─────────────────────────────────────────────────────────────────

// Mesmo projeto do sistema — e a mesma base de dados, lida com a mesma
// credencial. Chave de API de cliente Firebase e publica por natureza: quem
// protege os dados sao as regras do Firestore, nao o segredo desta linha.
const firebaseConfig = {
  apiKey: 'AIzaSyDXen38LRqBt2qkCkS2nlAPhWVhyZfwDs4',
  authDomain: 'central-autocar.firebaseapp.com',
  projectId: 'central-autocar',
  storageBucket: 'central-autocar.firebasestorage.app',
  messagingSenderId: '560659713877',
  appId: '1:560659713877:web:6cb4be62d099494a5c29dc'
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const SAVED_KEY = 'fechamento_credencial';

let session = null;    // { uid, credential }
let dayData = null;    // { stock, movements, transfers }

// ── Utilidades ───────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dayKey = (date) => {
  // Data LOCAL. toISOString devolve UTC e, depois das 21h no Brasil, ja e o dia
  // seguinte — justamente o horario em que este programa e usado.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const slugify = (value) =>
  (value || 'geral')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'geral';

// Timestamp do Firestore, Date, numero ou nada -> milissegundos.
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDateTime(value) {
  const millis = toMillis(value);
  if (!millis) return '';
  return new Date(millis).toLocaleString('pt-BR');
}

// CSV com ponto e virgula e BOM: e o que faz o Excel em portugues abrir o
// arquivo com as colunas certas e os acentos corretos.
function buildCSV(rows, columns) {
  const head = columns.map((c) => `"${String(c.label).replace(/"/g, '""')}"`).join(';');
  const body = rows.map((row) =>
    columns
      .map((c) => {
        const value = row[c.key];
        const text = value === undefined || value === null ? '' : String(value);
        return `"${text.replace(/"/g, '""')}"`;
      })
      .join(';')
  );
  return '﻿' + [head, ...body].join('\n');
}

function showMessage(container, kind, text) {
  container.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : '';
}

function showView(name) {
  ['login', 'main', 'done'].forEach((view) => {
    $(`view-${view}`).classList.toggle('hidden', view !== name);
  });
}

// ── Login ────────────────────────────────────────────────────────
//
// Exatamente o mesmo caminho do sistema: sessao anonima, credencial conferida
// na colecao `custom_credentials` e o perfil gravado em `users/{uid}` — e esse
// perfil que as regras do Firestore consultam para liberar a leitura das
// movimentacoes e transferencias da loja.

async function authenticate(username, password) {
  const result = await signInAnonymously(auth);
  const uid = result.user.uid;

  // limit(5) nao e enfeite: a regra de seguranca so aceita listar credenciais
  // com limite pequeno — consulta sem limite e negada para quem nao e admin.
  const snap = await getDocs(
    query(
      collection(db, 'custom_credentials'),
      where('username', '==', String(username).trim().toLowerCase()),
      limit(5)
    )
  );

  if (snap.empty) throw new Error('Usuário não encontrado.');

  let matched = null;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.password === password) matched = { id: docSnap.id, ...data };
  });

  if (!matched) throw new Error('Senha incorreta.');
  if (matched.associatedEmail && matched.associatedEmail.trim() !== '') {
    throw new Error(`Esta conta entra pelo Google (${matched.associatedEmail}) e não por aqui.`);
  }

  await setDoc(doc(db, 'users', uid), {
    role: matched.role || 'user',
    displayName: matched.displayName || username,
    email: 'anonimo@sistema.local',
    companyId: matched.companyId || '',
    companyName: matched.companyName || '',
    credentialId: matched.id || '',
    updatedAt: new Date()
  });

  return { uid, credential: matched };
}

// ── Leitura do dia ───────────────────────────────────────────────

async function loadDay(companyId, companyName) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startTs = Timestamp.fromDate(start);
  const startMillis = start.getTime();

  // ESTOQUE — a colecao inteira e depois o filtro da loja aqui. Documentos
  // antigos nao tem companyId, so companyName; e o mesmo cuidado que o sistema
  // toma, senao o estoque velho da loja fica de fora do arquivo.
  const stockSnap = await getDocs(collection(db, 'stock'));
  const stock = [];
  stockSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const belongs =
      !companyId ||
      data.companyId === companyId ||
      (!data.companyId &&
        String(data.companyName || '').toLowerCase() === String(companyName || '').toLowerCase());
    if (belongs) stock.push({ id: docSnap.id, ...data });
  });

  // MOVIMENTACOES DO DIA — filtro por loja + recorte do dia exige o indice
  // composto (companyId + timestamp). Se ele nao existir no projeto, o
  // Firestore recusa a consulta inteira; nesse caso vale mais buscar a loja
  // toda e cortar o dia aqui do que devolver arquivo vazio.
  let movements = [];
  try {
    const filters = companyId
      ? [where('companyId', '==', companyId), where('timestamp', '>=', startTs), orderBy('timestamp', 'desc')]
      : [where('timestamp', '>=', startTs), orderBy('timestamp', 'desc')];
    const movSnap = await getDocs(query(collection(db, 'movements'), ...filters));
    movSnap.forEach((docSnap) => movements.push({ id: docSnap.id, ...docSnap.data() }));
  } catch (err) {
    if (err && err.code === 'failed-precondition' && companyId) {
      const movSnap = await getDocs(
        query(collection(db, 'movements'), where('companyId', '==', companyId))
      );
      movSnap.forEach((docSnap) => {
        const data = { id: docSnap.id, ...docSnap.data() };
        if (toMillis(data.timestamp) >= startMillis) movements.push(data);
      });
    } else {
      throw err;
    }
  }
  movements.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  // TRANSFERENCIAS — duas consultas (o que saiu e o que entrou) porque o
  // Firestore nao faz "OU" entre campos diferentes. As regras so liberam os
  // pedidos em que a loja e parte, entao consulta sem filtro seria recusada.
  const transferMap = new Map();
  const transferQueries = companyId
    ? [
        query(collection(db, 'transfers'), where('sourceCompanyId', '==', companyId)),
        query(collection(db, 'transfers'), where('destinationCompanyId', '==', companyId))
      ]
    : [query(collection(db, 'transfers'))];

  for (const q of transferQueries) {
    const snap = await getDocs(q);
    snap.forEach((docSnap) => transferMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
  }

  const transfers = Array.from(transferMap.values())
    .filter((t) => {
      const millis = toMillis(t.updatedAt) || toMillis(t.requestedAt);
      return millis >= startMillis;
    })
    .sort((a, b) => {
      const ma = toMillis(a.updatedAt) || toMillis(a.requestedAt);
      const mb = toMillis(b.updatedAt) || toMillis(b.requestedAt);
      return ma - mb;
    });

  return { stock, movements, transfers };
}

// ── Arquivos ─────────────────────────────────────────────────────

function buildFiles(companyName, data) {
  const today = new Date();
  const todayStr = dayKey(today);
  const suffix = `${slugify(companyName)}-${todayStr}`;

  const reservedOf = (item) => Math.max(0, Number(item.reservedQuantity) || 0);

  const estoque = buildCSV(
    data.stock.map((item) => ({
      sku: item.sku || '',
      size: item.size || '',
      brand: item.brand || '',
      model: item.model || '',
      quantity: Number(item.quantity) || 0,
      reserved: reservedOf(item),
      available: Math.max(0, (Number(item.quantity) || 0) - reservedOf(item)),
      priceCash: item.priceCash || item.price || 0,
      priceInstallment: item.priceInstallment || item.priceCash || item.price || 0,
      company: item.companyName || companyName
    })),
    [
      { key: 'sku', label: 'CODIGO' },
      { key: 'size', label: 'MEDIDA' },
      { key: 'brand', label: 'MARCA' },
      { key: 'model', label: 'MODELO' },
      { key: 'quantity', label: 'QTD FISICA' },
      { key: 'reserved', label: 'RESERVADO' },
      { key: 'available', label: 'DISPONIVEL' },
      { key: 'priceCash', label: 'P/ A VISTA' },
      { key: 'priceInstallment', label: 'P/ PRAZO' },
      { key: 'company', label: 'EMPRESA' }
    ]
  );

  const movimentacoes = buildCSV(
    data.movements.map((log) => ({
      when: formatDateTime(log.timestamp),
      type: log.type || '',
      reason: log.operationReason || log.reason || '',
      sku: log.sku || '',
      size: log.size || '',
      brand: log.brand || '',
      model: log.model || '',
      quantity: log.quantity ?? 0,
      balanceAfter: log.balanceAfter ?? '',
      party: log.partyName || '',
      partyDoc: log.partyDoc || '',
      docNumber: log.docNumber || '',
      plate: log.vehiclePlate || '',
      unitPrice: log.unitPrice ?? '',
      totalAmount: log.totalAmount ?? '',
      user: log.userEmail || '',
      company: log.companyName || ''
    })),
    [
      { key: 'when', label: 'DATA/HORA' },
      { key: 'type', label: 'TIPO' },
      { key: 'reason', label: 'MOTIVO' },
      { key: 'sku', label: 'CODIGO' },
      { key: 'size', label: 'MEDIDA' },
      { key: 'brand', label: 'MARCA' },
      { key: 'model', label: 'MODELO' },
      { key: 'quantity', label: 'QTD' },
      { key: 'balanceAfter', label: 'SALDO APOS' },
      { key: 'party', label: 'CLIENTE/FORNECEDOR' },
      { key: 'partyDoc', label: 'CPF/CNPJ' },
      { key: 'docNumber', label: 'DOCUMENTO' },
      { key: 'plate', label: 'PLACA' },
      { key: 'unitPrice', label: 'VALOR UNIT' },
      { key: 'totalAmount', label: 'VALOR TOTAL' },
      { key: 'user', label: 'OPERADOR' },
      { key: 'company', label: 'EMPRESA' }
    ]
  );

  const transferencias = buildCSV(
    data.transfers.map((t) => ({
      id: t.id,
      status: t.status || '',
      source: t.sourceCompanyName || '',
      destination: t.destinationCompanyName || '',
      customer: t.customerName || '',
      items: (t.items || [])
        .map((i) => `${i.quantity}x ${i.sku} ${i.size} ${i.brand} ${i.model}`.trim())
        .join(' | '),
      totalQty: (t.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
      reason: t.reason || '',
      requestedBy: t.requestedByName || t.requestedByEmail || '',
      requestedAt: formatDateTime(t.requestedAt),
      updatedAt: formatDateTime(t.updatedAt || t.requestedAt)
    })),
    [
      { key: 'id', label: 'PEDIDO' },
      { key: 'status', label: 'SITUACAO' },
      { key: 'source', label: 'ORIGEM' },
      { key: 'destination', label: 'DESTINO' },
      { key: 'customer', label: 'CLIENTE' },
      { key: 'items', label: 'ITENS' },
      { key: 'totalQty', label: 'QTD TOTAL' },
      { key: 'reason', label: 'MOTIVO' },
      { key: 'requestedBy', label: 'SOLICITADO POR' },
      { key: 'requestedAt', label: 'ABERTO EM' },
      { key: 'updatedAt', label: 'ULTIMA ATUALIZACAO' }
    ]
  );

  // O JSON e a copia que RESTAURA: `items` no topo, com o estoque, e
  // exatamente o formato que a tela "Restaurar Backup" do sistema le.
  const json = JSON.stringify(
    {
      date: today.toISOString(),
      dayClosed: todayStr,
      companyName,
      totalItems: data.stock.length,
      items: data.stock,
      movements: data.movements,
      transfers: data.transfers
    },
    null,
    2
  );

  return [
    { name: `estoque-${suffix}.csv`, content: estoque },
    { name: `movimentacoes-${suffix}.csv`, content: movimentacoes },
    { name: `transferencias-${suffix}.csv`, content: transferencias },
    { name: `fechamento-${suffix}.json`, content: json }
  ];
}

// ── Tela ─────────────────────────────────────────────────────────

async function enterMainView() {
  const cred = session.credential;
  const companyName = cred.companyName || 'Todas as empresas';

  $('who-company').textContent = companyName;
  $('who-user').textContent = `${cred.displayName || cred.username} · ${new Date().toLocaleDateString('pt-BR')}`;
  showView('main');
  showMessage($('main-msg'), '', '');

  $('folder').textContent = await window.fechamento.getFolder();
  $('autostart').checked = await window.fechamento.getAutoStart();

  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Carregando dados do dia…';

  try {
    dayData = await loadDay(cred.companyId || '', companyName);
    $('c-stock').textContent = dayData.stock.length;
    $('c-mov').textContent = dayData.movements.length;
    $('c-transf').textContent = dayData.transfers.length;

    if (dayData.stock.length === 0) {
      showMessage(
        $('main-msg'),
        'warn',
        'Nenhum produto encontrado para esta loja. Confirme o usuário antes de salvar — um arquivo vazio não serve de cópia.'
      );
    }

    btn.disabled = false;
    btn.textContent = 'Salvar fechamento do dia';
  } catch (err) {
    console.error(err);
    $('c-stock').textContent = '—';
    $('c-mov').textContent = '—';
    $('c-transf').textContent = '—';
    btn.textContent = 'Tentar de novo';
    btn.disabled = false;
    const isQuota = err && err.code === 'resource-exhausted';
    showMessage(
      $('main-msg'),
      'error',
      isQuota
        ? 'O banco atingiu o limite diário do plano gratuito do Firebase e recusou a leitura. Nada foi perdido — tente de novo depois da meia-noite do Pacífico (por volta das 4h daqui).'
        : `Não consegui ler os dados: ${(err && err.message) || err}`
    );
  }
}

async function handleSave() {
  const btn = $('btn-save');

  if (!dayData) {
    await enterMainView();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Salvando…';

  try {
    const companyName = session.credential.companyName || 'Todas as empresas';
    const files = buildFiles(companyName, dayData);
    const result = await window.fechamento.save({ subfolder: dayKey(new Date()), files });
    if (!result || !result.ok) throw new Error((result && result.error) || 'Falha ao gravar.');

    $('done-folder').textContent = result.folder;
    $('done-files').innerHTML = result.files.map((name) => `<li>${name}</li>`).join('');
    showView('done');
  } catch (err) {
    console.error(err);
    showMessage($('main-msg'), 'error', `Não consegui gravar: ${(err && err.message) || err}`);
    btn.disabled = false;
    btn.textContent = 'Salvar fechamento do dia';
  }
}

async function handleLogin() {
  const username = $('username').value;
  const password = $('password').value;
  const btn = $('btn-login');

  if (!username || !password) {
    showMessage($('login-msg'), 'error', 'Preencha usuário e senha.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Entrando…';
  showMessage($('login-msg'), '', '');

  try {
    session = await authenticate(username, password);

    if ($('remember').checked) {
      // Mesma escolha que o sistema ja faz no navegador: a credencial fica
      // guardada na maquina para o programa nao pedir senha todo fim de dia.
      localStorage.setItem(SAVED_KEY, JSON.stringify({ username, password }));
    } else {
      localStorage.removeItem(SAVED_KEY);
    }

    await enterMainView();
  } catch (err) {
    console.error(err);
    showMessage($('login-msg'), 'error', (err && err.message) || 'Não consegui entrar.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function tryAutoLogin() {
  const saved = localStorage.getItem(SAVED_KEY);
  if (!saved) return false;

  try {
    const { username, password } = JSON.parse(saved);
    $('username').value = username || '';
    $('password').value = password || '';
    session = await authenticate(username, password);
    await enterMainView();
    return true;
  } catch (err) {
    console.warn('Login automático falhou:', err);
    showMessage(
      $('login-msg'),
      'warn',
      'A credencial salva não funcionou mais (senha alterada?). Entre de novo.'
    );
    return false;
  }
}

// ── Ligacoes ─────────────────────────────────────────────────────

$('btn-login').addEventListener('click', handleLogin);
$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});
$('btn-save').addEventListener('click', handleSave);

$('btn-folder').addEventListener('click', async () => {
  const chosen = await window.fechamento.chooseFolder();
  if (chosen) $('folder').textContent = chosen;
});

$('autostart').addEventListener('change', async (e) => {
  const enabled = await window.fechamento.setAutoStart(e.target.checked);
  e.target.checked = enabled;
});

$('btn-logout').addEventListener('click', () => {
  localStorage.removeItem(SAVED_KEY);
  session = null;
  dayData = null;
  $('password').value = '';
  showView('login');
});

$('btn-open').addEventListener('click', () => window.fechamento.openFolder());
$('btn-close').addEventListener('click', () => window.fechamento.quit());

// Aviso das 18h: o programa aparece sozinho e recarrega os numeros do dia,
// que a essa altura ja mudaram desde que a janela abriu.
window.fechamento.onReminder(() => {
  if (session) enterMainView();
});

tryAutoLogin();
