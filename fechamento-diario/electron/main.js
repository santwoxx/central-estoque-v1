const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { writeClosing } = require('./dailyBackup');

// ─────────────────────────────────────────────────────────────────
// FECHAMENTO CENTRAL ESTOQUE — processo principal
//
// Programa de uma tarefa só: todo dia às 18h, SEM NINGUÉM CLICAR, ele lê as
// vendas, o estoque e o movimento do dia e grava uma planilha numa pasta do
// computador. Fica escondido na bandeja do Windows o dia inteiro.
//
// O que mudou na versão 2:
//   • salva sozinho às 18h (antes só abria a janela e esperava um clique);
//   • recupera o dia perdido se o computador estava desligado às 18h;
//   • entra com conta Google (antes recusava — e é o caso do dono);
//   • administrador recebe TODAS as lojas numa planilha só;
//   • não guarda senha nenhuma no disco (antes guardava em texto puro).
// ─────────────────────────────────────────────────────────────────

const CLOSE_HOUR = 18;
const RETRY_MINUTES = 15;
const MAX_CATCHUP_DAYS = 7;

// Porta FIXA de propósito. O login fica salvo no armazenamento do navegador
// interno, que é separado por origem — e a porta faz parte da origem. Com porta
// sorteada a cada abertura, o programa esqueceria o login todo dia e o
// fechamento das 18h encontraria a sessão vazia. A primeira porta livre desta
// lista é gravada na configuração e reusada dali em diante.
const PORTS = [47815, 47816, 47817, 47818, 47819];

// O Google recusa login em janelas que se identificam como Electron. O login
// Google acontece no navegador de verdade (ver auth:google-start), mas o
// identificador limpo evita que qualquer página do Google aberta aqui dentro
// seja bloqueada.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/\S+/i, '')
  .replace(/\s*fechamento-central-estoque\/\S+/i, '');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  start();
}

function start() {
  let mainWindow = null;
  let tray = null;
  let serverPort = null;
  let quitting = false;
  let rendererReady = false;
  let lastSavedFolder = null;
  let runInFlight = null;
  let nextRetryAt = 0;
  let pendingGoogle = null;
  const pendingRuns = new Map();

  const startedHidden = process.argv.includes('--hidden');
  const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
  const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

  // ── Configuração ──────────────────────────────────────────────
  const configPath = () => path.join(app.getPath('userData'), 'config.json');

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
      return {};
    }
  }

  function writeConfig(patch) {
    const cfg = { ...readConfig(), ...patch };
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
      console.error('[Fechamento] Não consegui salvar a configuração:', err.message);
    }
    return cfg;
  }

  function currentFolder() {
    const cfg = readConfig();
    return typeof cfg.backupFolder === 'string' && cfg.backupFolder.trim()
      ? cfg.backupFolder
      : path.join(app.getPath('documents'), 'Central Estoque', 'Fechamentos');
  }

  // Data LOCAL. A versão anterior usava toISOString(), que devolve UTC: às 21h
  // de Brasília já é o dia seguinte em UTC, e o lembrete das 18h disparava de
  // novo às 21h achando que era outro dia.
  function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ── Servidor local ────────────────────────────────────────────
  // Serve a tela e recebe o retorno do login Google. Escuta só em localhost e
  // só entrega os arquivos da lista — não é um servidor de pasta.
  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/bundle.js': ['bundle.js', 'text/javascript; charset=utf-8'],
    '/google.html': ['google.html', 'text/html; charset=utf-8'],
    '/google-bundle.js': ['google-bundle.js', 'text/javascript; charset=utf-8']
  };

  function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://localhost:${serverPort}`);

    // Retorno do login Google feito no navegador.
    if (req.method === 'POST' && url.pathname === '/auth/google') {
      // Só aceita da própria página do programa, e só com o código de uso
      // único gerado nesta tentativa de login.
      if (req.headers.origin !== `http://localhost:${serverPort}`) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      req.on('end', () => {
        try {
          const { state, idToken } = JSON.parse(body || '{}');
          if (!pendingGoogle || !state || state !== pendingGoogle.state || !idToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Tentativa de login expirada. Volte ao programa e clique em Entrar com Google de novo.' }));
            return;
          }
          const waiting = pendingGoogle;
          pendingGoogle = null;
          clearTimeout(waiting.timer);
          waiting.resolve(idToken);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    const entry = STATIC[url.pathname];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(path.join(RENDERER_DIR, entry[0]), (err, data) => {
      if (err) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': entry[1],
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handleRequest);
      server.once('error', reject);
      server.listen(port, 'localhost', () => resolve(server));
    });
  }

  async function startServer() {
    const saved = readConfig().port;
    const order = saved ? [saved, ...PORTS.filter((p) => p !== saved)] : PORTS;
    for (const port of order) {
      try {
        serverPort = port;
        await listenOn(port);
        if (saved !== port) writeConfig({ port });
        return port;
      } catch {
        // porta ocupada — tenta a próxima
      }
    }
    throw new Error('Nenhuma porta local livre para abrir o programa.');
  }

  // ── Janela e bandeja ──────────────────────────────────────────
  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 580,
      height: 760,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Fechamento do Dia',
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.loadURL(`http://localhost:${serverPort}/`);

    mainWindow.once('ready-to-show', () => {
      if (!startedHidden) mainWindow.show();
    });

    // Nada abre dentro do programa; link externo vai para o navegador.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(`http://localhost:${serverPort}/`)) e.preventDefault();
    });

    // Fechar a janela NÃO encerra o programa: ele precisa estar vivo às 18h.
    // Encerrar de verdade é pela bandeja ou pelo botão "Sair do programa".
    mainWindow.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      mainWindow.hide();
      const cfg = readConfig();
      if (!cfg.hideNoticeShown) {
        writeConfig({ hideNoticeShown: true });
        notify(
          'O fechamento continua ligado',
          `O programa fica na bandeja, perto do relógio, e salva a planilha sozinho às ${CLOSE_HOUR}h.`
        );
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
      rendererReady = false;
    });
  }

  function showWindow() {
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createTray() {
    if (!fs.existsSync(ICON_PATH)) return;
    const image = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip(`Fechamento Central Estoque — salva sozinho às ${CLOSE_HOUR}h`);
    tray.on('click', showWindow);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir', click: showWindow },
        { label: 'Salvar o fechamento agora', click: () => runClosing(dayKey(new Date()), { manual: true }) },
        { label: 'Abrir pasta dos fechamentos', click: openFolder },
        { type: 'separator' },
        { label: 'Sair do programa', click: () => { quitting = true; app.quit(); } }
      ])
    );
  }

  function notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title,
      body,
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined
    });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  async function openFolder() {
    const target = lastSavedFolder || currentFolder();
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
  }

  // ── O fechamento ──────────────────────────────────────────────
  // A tela lê o banco (é lá que está a sessão do Firebase); este processo
  // monta a planilha e grava no disco. Um caminho só para o automático das 18h,
  // para a recuperação de dia perdido e para o botão "Salvar agora".
  function askRenderer(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!mainWindow || !rendererReady) {
        resolve({ ok: false, reason: 'not-ready', error: 'O programa ainda está abrindo.' });
        return;
      }
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        pendingRuns.delete(id);
        resolve({ ok: false, error: 'O banco demorou demais para responder. Verifique a internet.' });
      }, timeoutMs);
      pendingRuns.set(id, { resolve, timer });
      mainWindow.webContents.send('closing:collect', { id, ...payload });
    });
  }

  function formatDayLabel(key) {
    const [y, m, d] = key.split('-');
    return `${d}/${m}/${y}`;
  }

  function brl(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  async function runClosing(day, opts = {}) {
    if (runInFlight) return { ok: false, error: 'Já existe um fechamento sendo salvo.' };
    runInFlight = day;
    try {
      if (!mainWindow) createWindow();
      const collected = await askRenderer({ day, catchUp: !!opts.catchUp }, 5 * 60 * 1000);

      if (!collected.ok) {
        if (collected.reason === 'login') {
          if (!opts.catchUp) {
            notify(
              'Entre no programa para salvar o fechamento',
              'O fechamento de hoje não foi salvo porque o programa está sem login. Toque aqui para entrar.',
              showWindow
            );
            showWindow();
          }
        } else if (!opts.manual) {
          notify(
            `Fechamento de ${formatDayLabel(day)} não foi salvo`,
            `${collected.error || 'Erro ao ler o banco.'} Vou tentar de novo em ${RETRY_MINUTES} minutos.`
          );
        }
        nextRetryAt = Date.now() + RETRY_MINUTES * 60000;
        return collected;
      }

      // Dia recuperado sem movimento nenhum (domingo, feriado): marca como
      // fechado e não cria uma planilha vazia.
      if (collected.skipped) {
        markClosed(day);
        return { ok: true, skipped: true, day };
      }

      const result = await writeClosing({ baseFolder: currentFolder(), data: collected.data });
      lastSavedFolder = result.folder;
      markClosed(day);
      nextRetryAt = 0;

      const s = result.stats;
      notify(
        `Fechamento de ${formatDayLabel(day)} salvo`,
        `${s.sales} venda(s) · ${brl(s.salesValue)}` +
          (s.pending ? ` · ${s.pending} baixa(s) esperando aprovação` : '') +
          (s.divergences ? ` · ATENÇÃO: ${s.divergences} divergência(s) de saldo` : '') +
          '. Toque para abrir a pasta.',
        () => shell.openPath(result.folder)
      );
      sendState();
      return { ok: true, day, folder: result.folder, file: result.file, stats: s };
    } catch (err) {
      console.error('[Fechamento] Falha ao salvar:', err);
      // Quase sempre é pasta de rede fora do ar, pen drive removido ou
      // permissão negada — o texto do sistema é o que ajuda.
      const error = (err && err.message) || 'Erro desconhecido ao gravar a planilha.';
      if (!opts.manual) {
        notify(`Fechamento de ${formatDayLabel(day)} não foi salvo`, error);
      }
      nextRetryAt = Date.now() + RETRY_MINUTES * 60000;
      return { ok: false, error };
    } finally {
      runInFlight = null;
    }
  }

  function markClosed(day) {
    const cfg = readConfig();
    if (!cfg.lastClosedDay || day > cfg.lastClosedDay) writeConfig({ lastClosedDay: day });
  }

  function sendState() {
    if (!mainWindow) return;
    const cfg = readConfig();
    mainWindow.webContents.send('state:changed', { lastClosedDay: cfg.lastClosedDay || null });
  }

  // Dias que passaram sem fechamento (computador desligado às 18h). Só olha
  // para trás a partir do último fechamento feito — na primeira instalação não
  // há passado para recuperar.
  function missedDays() {
    const cfg = readConfig();
    if (!cfg.lastClosedDay) return [];
    const today = dayKey(new Date());
    const out = [];
    const d = parseDay(cfg.lastClosedDay);
    d.setDate(d.getDate() + 1);
    while (dayKey(d) < today) {
      out.push(dayKey(d));
      d.setDate(d.getDate() + 1);
    }
    return out.slice(-MAX_CATCHUP_DAYS);
  }

  async function catchUp() {
    for (const day of missedDays()) {
      const r = await runClosing(day, { catchUp: true });
      if (!r.ok) break; // sem sessão ou sem rede: tenta de novo na próxima abertura
    }
  }

  // Confere de minuto em minuto em vez de marcar um horário único: um
  // setTimeout para as 18h não sobrevive ao computador dormir no meio do dia.
  function tick() {
    if (!rendererReady || runInFlight) return;
    const now = new Date();
    if (now.getHours() < CLOSE_HOUR) return;
    if (readConfig().lastClosedDay === dayKey(now)) return;
    if (Date.now() < nextRetryAt) return;
    runClosing(dayKey(now), {});
  }

  // ── Login Google pelo navegador ───────────────────────────────
  // O Google não deixa entrar numa janela de programa, só num navegador de
  // verdade. Então o programa abre o navegador numa página servida por ele
  // mesmo, a pessoa entra lá, e a página devolve para cá só o comprovante do
  // Google (idToken), amarrado a um código de uso único.
  ipcMain.handle('auth:google-start', async () => {
    if (pendingGoogle) {
      clearTimeout(pendingGoogle.timer);
      pendingGoogle.resolve(null);
      pendingGoogle = null;
    }
    const state = crypto.randomBytes(24).toString('hex');
    const tokenPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingGoogle = null;
        resolve(null);
      }, 5 * 60 * 1000);
      pendingGoogle = { state, resolve, timer };
    });
    await shell.openExternal(`http://localhost:${serverPort}/google.html?state=${state}`);
    const idToken = await tokenPromise;
    showWindow();
    return idToken
      ? { ok: true, idToken }
      : { ok: false, error: 'O login no navegador não foi concluído (tempo esgotado ou cancelado).' };
  });

  // ── IPC ───────────────────────────────────────────────────────
  ipcMain.handle('app:get-state', () => {
    const cfg = readConfig();
    return {
      folder: currentFolder(),
      lastClosedDay: cfg.lastClosedDay || null,
      closeHour: CLOSE_HOUR,
      version: app.getVersion(),
      autostart: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
    };
  });

  ipcMain.handle('folder:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Onde salvar os fechamentos do dia?',
      defaultPath: currentFolder(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    writeConfig({ backupFolder: result.filePaths[0] });
    return result.filePaths[0];
  });

  ipcMain.handle('folder:open', openFolder);

  ipcMain.handle('autostart:set', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  });

  ipcMain.handle('closing:run-now', () => runClosing(dayKey(new Date()), { manual: true }));

  ipcMain.on('closing:collected', (_e, msg) => {
    const waiting = msg && pendingRuns.get(msg.id);
    if (!waiting) return;
    pendingRuns.delete(msg.id);
    clearTimeout(waiting.timer);
    waiting.resolve(msg.result || { ok: false, error: 'Resposta vazia.' });
  });

  // A tela avisa quando terminou de conferir a sessão. Só a partir daí dá para
  // recuperar dia perdido e rodar o das 18h.
  ipcMain.on('renderer:ready', (_e, info) => {
    rendererReady = true;
    if (info && info.hasSession) {
      catchUp().then(tick);
    }
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
  });

  // ── Ciclo de vida ─────────────────────────────────────────────
  app.on('second-instance', showWindow);

  app.on('before-quit', () => {
    quitting = true;
  });

  // Com a janela fechada o programa continua na bandeja.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Fechamento do Dia', `Não consegui abrir o programa: ${err.message}`);
      app.exit(1);
      return;
    }

    // Primeira abertura do programa INSTALADO: já liga "abrir com o Windows".
    // Sem isto o fechamento automático dependia de a pessoa achar e marcar uma
    // opção — e o programa que ninguém lembra de abrir não salva nada às 18h.
    const cfg = readConfig();
    if (app.isPackaged && !cfg.firstRunDone) {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
      writeConfig({ firstRunDone: true });
    }

    createWindow();
    createTray();
    setInterval(tick, 60000);
  });
}
