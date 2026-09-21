import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  signInAnonymously,
  signInWithCredential,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDocFromServer,
  doc,
  setDoc,
  Timestamp
} from 'firebase/firestore';

// ─────────────────────────────────────────────────────────────────
// FECHAMENTO CENTRAL ESTOQUE — tela
//
// Esta parte entra no sistema e LÊ o banco. Quem monta a planilha e grava no
// disco é o processo principal (electron/main.js), que pede os dados do dia
// por `onCollect` — às 18h, na recuperação de um dia perdido, ou no botão.
//
// A única escrita no banco é o próprio perfil da sessão (users/{uid}), no
// login — exigido pelas regras do Firestore para liberar a leitura.
//
// SESSÃO: nenhuma senha fica guardada no computador. A versão anterior salvava
// usuário e senha em texto puro para entrar sozinha todo dia. Agora o login do
// Firebase fica guardado pelo próprio Firebase (como no navegador), e o papel e
// a loja são relidos do servidor em users/{uid} a cada abertura — o mesmo que o
// sistema faz no navegador desde que parou de confiar no localStorage.
// ─────────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: 'AIzaSyDXen38LRqBt2qkCkS2nlAPhWVhyZfwDs4',
  authDomain: 'central-autocar.firebaseapp.com',
  projectId: 'central-autocar',
  storageBucket: 'central-autocar.firebasestorage.app',
  messagingSenderId: '560659713877',
  appId: '1:560659713877:web:6cb4be62d099494a5c29dc'
};

const fbApp = initializeApp(firebaseConfig);
// Sem resolvedor de popup: o login Google acontece no navegador (google.html),
// e aqui só entra o comprovante. Isso também evita carregar scripts do Google
// dentro do programa.
const auth = initializeAuth(fbApp, { persistence: indexedDBLocalPersistence });
const db = getFirestore(fbApp);

// Mesma lista das regras do Firestore (isAdminEmail) e do sistema.
const ADMIN_EMAILS = [
  'brisasofc@gmail.com',
  'natandsantosmarinho10@gmail.com',
  'isaacbomfim.te@gmail.com',
  'isaacbomfim.00@gmail.com'
];

let session = null; // { uid, email, role, displayName, companyId, companyName }

// ── Utilidades ───────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function showView(name) {
  ['boot', 'login', 'step2', 'main'].forEach((v) => {
    $(`view-${v}`).classList.toggle('hidden', v !== name);
  });
}

function showMessage(container, kind, text) {
  container.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : '';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Timestamp do Firestore, Date, número ou nada → milissegundos.
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dayLabel(key) {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function friendlyError(err) {
  const code = (err && err.code) || '';
  if (code === 'resource-exhausted') {
    return 'O banco atingiu o limite diário do plano gratuito do Firebase e recusou a leitura. Nada foi perdido — o programa tenta de novo sozinho.';
  }
  if (code === 'permission-denied') {
    return 'O banco recusou a leitura por permissão. Saia da conta e entre de novo — se o seu papel mudou no sistema, é isso que atualiza.';
  }
  if (code === 'unavailable' || code === 'auth/network-request-failed') {
    return 'Sem conexão com a internet no momento.';
  }
  return (err && err.message) || String(err);
}

// ── Perfil da sessão ─────────────────────────────────────────────
// Relido do SERVIDOR: é o documento que as regras do Firestore usam para
// decidir o que esta sessão pode ler. Se não existe, a sessão não serve.
async function readProfile(user) {
  const email = (user.email || '').toLowerCase().trim();
  const isAdminEmail = ADMIN_EMAILS.includes(email);

  // Falha de REDE sobe como erro (quem chama tenta de novo); só documento que
  // de fato não existe vira `null`. Confundir os dois deslogava a pessoa toda
  // vez que o computador ligava antes da internet — e aí o fechamento das 18h
  // encontrava o programa sem sessão.
  const snap = await getDocFromServer(doc(db, 'users', user.uid));
  const data = snap.exists() ? snap.data() : null;

  if (!data && !isAdminEmail) return null;

  let role = data && data.role === 'user' ? 'alimentador' : (data && data.role) || 'alimentador';
  if (isAdminEmail) role = 'admin';

  return {
    uid: user.uid,
    email: user.email || '',
    role,
    displayName: (data && data.displayName) || user.displayName || 'Usuário',
    companyId: (data && data.companyId) || '',
    companyName: (data && data.companyName) || ''
  };
}

// O fechamento é de quem opera estoque. Vendedor não tem loja para fechar.
function canClose(profile) {
  return profile && (profile.role === 'admin' || profile.role === 'alimentador');
}

// ── Credencial do sistema (usuário e senha) ──────────────────────
// Mesmo caminho do sistema no navegador. `limit(5)` não é enfeite: a regra de
// segurança só aceita listar credenciais com limite pequeno.
async function matchCredential(username, password) {
  const snap = await getDocs(
    query(
      collection(db, 'custom_credentials'),
      where('username', '==', String(username).trim().toLowerCase()),
      limit(5)
    )
  );
  if (snap.empty) throw new Error('Usuário não encontrado.');

  let matched = null;
  snap.forEach((d) => {
    const data = d.data();
    if (data.password === password) matched = { id: d.id, ...data };
  });
  if (!matched) throw new Error('Senha incorreta.');
  return matched;
}

async function writeProfile(uid, email, cred) {
  try {
    await setDoc(doc(db, 'users', uid), {
      role: cred.role || 'user',
      displayName: cred.displayName || cred.username || 'Usuário',
      email,
      companyId: cred.companyId || '',
      companyName: cred.companyName || '',
      // A regra do Firestore confere que papel e loja gravados aqui são mesmo os
      // desta credencial. Sem este id, ninguém consegue gravar o próprio perfil.
      credentialId: cred.id || '',
      updatedAt: new Date()
    });
  } catch (err) {
    console.error(err);
    throw new Error('Não consegui registrar seu perfil de acesso no servidor. Verifique a conexão e tente de novo.');
  }
}

async function finishLogin(user) {
  const profile = await readProfile(user);
  if (!profile) throw new Error('Não consegui confirmar seu perfil no servidor.');
  if (!canClose(profile)) {
    await signOut(auth);
    throw new Error('Este programa é para o dono da loja ou o administrador. Vendedor não faz fechamento de caixa.');
  }
  session = profile;
  await enterMain();
  window.fechamento.ready(true);
}

// ── Login sem Google (usuário e senha) ───────────────────────────
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
    const result = await signInAnonymously(auth);
    const cred = await matchCredential(username, password);
    if (cred.associatedEmail && cred.associatedEmail.trim() !== '') {
      await signOut(auth);
      throw new Error(
        `Esta conta está ligada ao Google (${escapeHtml(cred.associatedEmail)}). Use o botão <b>Entrar com Google</b>.`
      );
    }
    await writeProfile(result.user.uid, 'anonimo@sistema.local', cred);
    $('password').value = '';
    await finishLogin(result.user);
  } catch (err) {
    console.error(err);
    showMessage($('login-msg'), 'error', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

// ── Login com Google (navegador + segunda etapa) ─────────────────
async function handleGoogle() {
  const btn = $('btn-google');
  btn.disabled = true;
  btn.textContent = 'Continue no navegador que abriu…';
  showMessage($('login-msg'), '', '');

  try {
    const answer = await window.fechamento.googleStart();
    if (!answer || !answer.ok) throw new Error((answer && answer.error) || 'Login no navegador não concluído.');

    const result = await signInWithCredential(auth, GoogleAuthProvider.credential(answer.idToken));
    const email = (result.user.email || '').toLowerCase().trim();

    // Conta mestra: entra sem a segunda etapa, como no sistema. O e-mail vem
    // assinado pelo Google e é a mesma prova que as regras do Firestore usam.
    if (ADMIN_EMAILS.includes(email)) {
      await setDoc(doc(db, 'users', result.user.uid), {
        role: 'admin',
        displayName: result.user.displayName || 'Administrador',
        email,
        companyId: '',
        companyName: '',
        updatedAt: new Date()
      }).catch(() => {});
      await finishLogin(result.user);
      return;
    }

    $('google-email').textContent = result.user.email || '';
    showMessage($('step2-msg'), '', '');
    showView('step2');
    $('username2').focus();
  } catch (err) {
    console.error(err);
    showMessage($('login-msg'), 'error', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar com Google';
  }
}

async function handleStep2() {
  const user = auth.currentUser;
  const btn = $('btn-step2');
  const username = $('username2').value;
  const password = $('password2').value;

  if (!user || user.isAnonymous) {
    showView('login');
    return;
  }
  if (!username || !password) {
    showMessage($('step2-msg'), 'error', 'Preencha usuário e senha.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Conferindo…';
  showMessage($('step2-msg'), '', '');

  try {
    const cred = await matchCredential(username, password);
    const googleEmail = (user.email || '').toLowerCase().trim();
    const bound = (cred.associatedEmail || '').toLowerCase().trim();
    if (bound && bound !== googleEmail) {
      throw new Error(
        `Esta credencial pertence à conta Google ${escapeHtml(cred.associatedEmail)}, e você entrou como ${escapeHtml(user.email)}.`
      );
    }
    await writeProfile(user.uid, user.email || '', cred);
    $('password2').value = '';
    await finishLogin(user);
  } catch (err) {
    console.error(err);
    showMessage($('step2-msg'), 'error', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar';
  }
}

// ── Leitura do dia ───────────────────────────────────────────────
//
// ESCOPO: o administrador recebe TODAS as lojas numa planilha só (com a coluna
// Empresa e o resumo por loja). O dono da loja recebe a dele.
function isGlobal() {
  return session.role === 'admin' || !session.companyId;
}

function belongs(data) {
  if (isGlobal()) return true;
  if (data.companyId) return data.companyId === session.companyId;
  // Estoque antigo sem companyId, só com o nome da loja.
  return String(data.companyName || '').toLowerCase() === String(session.companyName || '').toLowerCase();
}

async function loadDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  const startTs = Timestamp.fromDate(start);
  const endTs = Timestamp.fromDate(end);
  const inDay = (ms) => ms >= start.getTime() && ms < end.getTime();

  // ESTOQUE — a coleção inteira, filtrada pelo escopo aqui.
  const stockSnap = await getDocs(collection(db, 'stock'));
  const stockDocs = [];
  stockSnap.forEach((s) => {
    const data = s.data();
    if (belongs(data)) stockDocs.push({ id: s.id, ...data });
  });

  // MOVIMENTAÇÕES DO DIA — recorte por data no servidor. Para uma loja, o filtro
  // por empresa + data usa o índice composto (companyId + timestamp); se ele
  // faltar, busca a loja toda e corta o dia aqui, em vez de devolver vazio.
  const movementDocs = [];
  const movRef = collection(db, 'movements');
  try {
    const q = isGlobal()
      ? query(movRef, where('timestamp', '>=', startTs), where('timestamp', '<', endTs), orderBy('timestamp', 'desc'))
      : query(
          movRef,
          where('companyId', '==', session.companyId),
          where('timestamp', '>=', startTs),
          where('timestamp', '<', endTs),
          orderBy('timestamp', 'desc')
        );
    const snap = await getDocs(q);
    snap.forEach((s) => movementDocs.push({ id: s.id, ...s.data() }));
  } catch (err) {
    if (err && err.code === 'failed-precondition' && !isGlobal()) {
      const snap = await getDocs(query(movRef, where('companyId', '==', session.companyId)));
      snap.forEach((s) => {
        const data = s.data();
        if (inDay(toMillis(data.timestamp))) movementDocs.push({ id: s.id, ...data });
      });
    } else {
      throw err;
    }
  }

  // TRANSFERÊNCIAS que andaram no dia. Para o administrador, recorte por data
  // no servidor (antes lia a coleção inteira). Para a loja, as três consultas
  // que as regras liberam: o que sai, o que chega e o que os vendedores dela
  // pediram em outra filial.
  const transferMap = new Map();
  const trRef = collection(db, 'transfers');
  const trQueries = isGlobal()
    ? [query(trRef, where('updatedAt', '>=', startTs))]
    : [
        query(trRef, where('sourceCompanyId', '==', session.companyId)),
        query(trRef, where('destinationCompanyId', '==', session.companyId)),
        query(trRef, where('requestedByCompanyId', '==', session.companyId))
      ];
  for (const q of trQueries) {
    try {
      const snap = await getDocs(q);
      snap.forEach((s) => transferMap.set(s.id, { id: s.id, ...s.data() }));
    } catch (err) {
      console.warn('Consulta de transferências recusada:', err && err.code);
    }
  }
  const transferDocs = Array.from(transferMap.values()).filter(
    (t) => inDay(toMillis(t.updatedAt)) || inDay(toMillis(t.requestedAt))
  );

  // BAIXAS PENDENTES — pneus presos esperando aprovação, agora.
  const pendingDocs = [];
  const exRef = collection(db, 'stock_exits');
  try {
    const q = isGlobal()
      ? query(exRef, where('status', '==', 'PENDENTE'))
      : query(exRef, where('companyId', '==', session.companyId), where('status', '==', 'PENDENTE'));
    const snap = await getDocs(q);
    snap.forEach((s) => pendingDocs.push({ id: s.id, ...s.data() }));
  } catch (err) {
    if (err && err.code === 'failed-precondition' && !isGlobal()) {
      const snap = await getDocs(query(exRef, where('companyId', '==', session.companyId)));
      snap.forEach((s) => {
        const data = s.data();
        if (data.status === 'PENDENTE') pendingDocs.push({ id: s.id, ...data });
      });
    } else {
      console.warn('Consulta de baixas pendentes recusada:', err && err.code);
    }
  }

  return { stockDocs, movementDocs, transferDocs, pendingDocs };
}

// Converte o que veio do banco em dados simples para o processo principal:
// sem Timestamp do Firestore, só número (ms) e texto.
function serialize(dayKey, catchUp, raw) {
  const now = new Date();
  const items = (list) =>
    (list || []).map((i) => ({
      sku: i.sku || '',
      size: i.size || '',
      brand: i.brand || '',
      model: i.model || '',
      quantity: Number(i.quantity) || 0
    }));

  return {
    day: dayKey,
    dayLabel: dayLabel(dayKey),
    generatedAt: now.toISOString(),
    generatedLabel: now.toLocaleString('pt-BR'),
    generatedBy: session.displayName,
    scopeLabel: isGlobal() ? 'Todas as empresas' : session.companyName || 'Loja',
    catchUp,

    stock: raw.stockDocs.map((s) => ({
      id: s.id,
      companyId: s.companyId || '',
      companyName: s.companyName || '',
      sku: s.sku || '',
      size: s.size || '',
      brand: s.brand || '',
      model: s.model || '',
      quantity: Number(s.quantity) || 0,
      reserved: Math.max(0, Number(s.reservedQuantity) || 0),
      priceCash: Number(s.priceCash || s.price) || 0,
      priceInstallment: Number(s.priceInstallment || s.priceCash || s.price) || 0
    })),

    // Formato que a tela "Restaurar Backup" do sistema lê.
    rawStock: raw.stockDocs.map((s) => ({
      sku: s.sku || '',
      brand: s.brand || '',
      model: s.model || '',
      size: s.size || '',
      quantity: Number(s.quantity) || 0,
      price: Number(s.price) || 0,
      priceCash: Number(s.priceCash) || 0,
      priceInstallment: Number(s.priceInstallment) || 0,
      costPrice: Number(s.costPrice) || 0,
      notes: s.notes || '',
      description: s.description || '',
      imageUrl: s.imageUrl || '',
      companyId: s.companyId || '',
      companyName: s.companyName || ''
    })),

    movements: raw.movementDocs.map((m) => ({
      when: toMillis(m.timestamp),
      companyId: m.companyId || '',
      companyName: m.companyName || '',
      type: m.type || '',
      operationReason: m.operationReason || '',
      reason: m.reason || '',
      sku: m.sku || '',
      size: m.size || '',
      brand: m.brand || '',
      model: m.model || '',
      quantity: Number(m.quantity) || 0,
      balanceAfter: typeof m.balanceAfter === 'number' ? m.balanceAfter : undefined,
      partyName: m.partyName || m.clientName || '',
      partyDoc: m.partyDoc || m.clientDoc || '',
      docNumber: m.docNumber || '',
      vehiclePlate: m.vehiclePlate || m.clientVehicle || '',
      unitPrice: Number(m.unitPrice ?? m.priceUnit) || 0,
      totalAmount: Number(m.totalAmount) || 0,
      userEmail: m.userEmail || '',
      requestedByName: m.requestedByName || '',
      approvedByName: m.approvedByName || '',
      stockItemId: m.stockItemId || ''
    })),

    transfers: raw.transferDocs.map((t) => ({
      id: t.id,
      status: t.status || '',
      sourceCompanyName: t.sourceCompanyName || '',
      destinationCompanyName: t.destinationCompanyName || '',
      customerName: t.customerName || '',
      items: items(t.items),
      requestedByName: t.requestedByName || '',
      requestedAt: toMillis(t.requestedAt),
      updatedAt: toMillis(t.updatedAt)
    })),

    pendingExits: raw.pendingDocs.map((p) => ({
      requestedAt: toMillis(p.requestedAt),
      companyName: p.companyName || '',
      requestedByName: p.requestedByName || '',
      reason: p.reason || '',
      partyName: p.partyName || '',
      items: items(p.items),
      totalUnits: Number(p.totalUnits) || 0,
      totalAmount: Number(p.totalAmount) || 0
    }))
  };
}

// O processo principal pede os dados — às 18h, na recuperação ou no botão.
window.fechamento.onCollect(async (req) => {
  if (!session || !auth.currentUser) return { ok: false, reason: 'login' };
  try {
    const raw = await loadDay(req.day);
    // Dia recuperado sem movimento nenhum (domingo, feriado): não vale arquivo.
    if (req.catchUp && raw.movementDocs.length === 0 && raw.transferDocs.length === 0) {
      return { ok: true, skipped: true };
    }
    return { ok: true, data: serialize(req.day, !!req.catchUp, raw) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: friendlyError(err) };
  }
});

// ── Tela principal ───────────────────────────────────────────────
async function refreshState() {
  const state = await window.fechamento.getState();
  $('folder').textContent = state.folder;
  $('autostart').checked = !!state.autostart;
  $('version').textContent = `Versão ${state.version}`;
  renderLastClosed(state.lastClosedDay);
  renderAutoCard(!!state.autostart, state.closeHour);
}

function renderLastClosed(day) {
  $('last-closed').textContent = day ? dayLabel(day) : 'ainda nenhum';
}

function renderAutoCard(autostart, hour) {
  $('auto-pill').textContent = autostart ? 'Automático ligado' : 'Atenção';
  $('auto-pill').classList.toggle('off', !autostart);
  $('auto-title').textContent = autostart
    ? `Todo dia às ${hour}h a planilha é salva sozinha`
    : `Às ${hour}h só salva se o programa estiver aberto`;
  $('auto-text').textContent = autostart
    ? 'Mesmo com esta janela fechada — o programa fica na bandeja, perto do relógio. Se o computador estiver desligado às 18h, o dia é recuperado na próxima vez que ligar.'
    : 'Marque "Abrir junto com o Windows" abaixo. Sem isso, se o computador reiniciar, o programa não estará rodando na hora do fechamento.';
}

async function enterMain() {
  $('who-scope').textContent = isGlobal()
    ? 'Todas as empresas'
    : session.companyName || 'Loja';
  $('who-user').textContent =
    `${session.displayName}${session.role === 'admin' ? ' · Administrador' : ' · Dono da loja'}`;
  showMessage($('main-msg'), '', '');
  showView('main');
  await refreshState();
}

async function handleSaveNow() {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Lendo o banco e montando a planilha…';
  showMessage($('main-msg'), '', '');

  try {
    const r = await window.fechamento.runNow();
    if (!r || !r.ok) throw new Error((r && r.error) || 'Não consegui salvar.');
    const s = r.stats;
    showMessage(
      $('main-msg'),
      s.divergences ? 'warn' : 'ok',
      `Fechamento salvo: ${s.sales} venda(s), ${brl(s.salesValue)}` +
        (s.pending ? ` · ${s.pending} baixa(s) esperando aprovação` : '') +
        (s.divergences
          ? `<br><b>Atenção:</b> ${s.divergences} pneu(s) com saldo diferente do histórico — veja a aba Conferência.`
          : '')
    );
    renderLastClosed(r.day);
  } catch (err) {
    showMessage($('main-msg'), 'error', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar o fechamento de hoje agora';
  }
}

// ── Ligações ─────────────────────────────────────────────────────
$('btn-login').addEventListener('click', handleLogin);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
$('btn-google').addEventListener('click', handleGoogle);
$('btn-step2').addEventListener('click', handleStep2);
$('password2').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleStep2(); });
$('btn-other-google').addEventListener('click', async () => {
  await signOut(auth).catch(() => {});
  showView('login');
  handleGoogle();
});
$('btn-save').addEventListener('click', handleSaveNow);

$('btn-folder').addEventListener('click', async () => {
  const chosen = await window.fechamento.chooseFolder();
  if (chosen) $('folder').textContent = chosen;
});
$('btn-open').addEventListener('click', () => window.fechamento.openFolder());

$('autostart').addEventListener('change', async (e) => {
  const enabled = await window.fechamento.setAutoStart(e.target.checked);
  e.target.checked = enabled;
  const state = await window.fechamento.getState();
  renderAutoCard(enabled, state.closeHour);
});

$('btn-logout').addEventListener('click', async () => {
  await signOut(auth).catch(() => {});
  session = null;
  showMessage($('login-msg'), '', '');
  showView('login');
  window.fechamento.ready(false);
});

$('btn-quit').addEventListener('click', () => window.fechamento.quit());

window.fechamento.onState((state) => renderLastClosed(state.lastClosedDay));

// ── Abertura ─────────────────────────────────────────────────────
// Espera o Firebase devolver a sessão guardada. Se existir e o perfil no
// servidor confirmar, o programa já está pronto para o fechamento das 18h sem
// ninguém digitar nada.
(async function boot() {
  const user = await new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });

  if (user) {
    // Tenta até conseguir falar com o servidor. No boot do Windows a rede
    // costuma chegar alguns segundos depois do programa.
    for (let attempt = 1; ; attempt++) {
      try {
        const profile = await readProfile(user);
        if (profile && canClose(profile)) {
          session = profile;
          await enterMain();
          window.fechamento.ready(true);
          return;
        }
        break; // perfil de fato inexistente ou sem permissão de fechamento
      } catch (err) {
        const offline = err && (err.code === 'unavailable' || err.code === 'deadline-exceeded' || !navigator.onLine);
        if (!offline) {
          console.warn('Sessão salva não confirmada:', err);
          break;
        }
        const wait = Math.min(30, attempt * 5);
        $('view-boot').querySelector('.sub').textContent =
          `Sem conexão com a internet — tentando de novo em ${wait} segundos. O login continua salvo.`;
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    await signOut(auth).catch(() => {});
  }

  showView('login');
  window.fechamento.ready(false);
})();
