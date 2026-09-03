const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { writeDailyFiles } = require('./dailyBackup');

// ─────────────────────────────────────────────────────────────────
// FECHAMENTO CENTRAL ESTOQUE — processo principal
//
// Programa separado do sistema, de proposito. Ele nao abre o estoque, nao
// edita nada e nao tem abas: entra com a mesma credencial da loja, le, grava
// os arquivos do dia numa pasta do computador e sai. Quem so precisa da copia
// diaria nao precisa abrir o sistema inteiro para consegui-la.
//
// A pasta de destino e resolvida AQUI, nunca vem pronta da tela: a janela
// manda apenas nome de arquivo e conteudo (ver dailyBackup.js).
// ─────────────────────────────────────────────────────────────────

// Hora em que o programa, se estiver aberto (inclusive escondido no boot do
// Windows), aparece sozinho pedindo o fechamento.
const CLOSE_HOUR = 18;

// Uma instancia so. Sem isto, o atalho clicado duas vezes abriria duas janelas
// gravando o mesmo arquivo ao mesmo tempo.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let lastSavedFolder = null;
let closeReminderTimer = null;

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
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[Fechamento] Nao consegui salvar a configuracao:', err.message);
  }
  return cfg;
}

function defaultBackupFolder() {
  // Pasta Documentos do usuario do Windows — traduzida e no lugar certo mesmo
  // quando o perfil esta em outro disco.
  return path.join(app.getPath('documents'), 'Central Estoque', 'Fechamentos');
}

function currentBackupFolder() {
  const cfg = readConfig();
  return typeof cfg.backupFolder === 'string' && cfg.backupFolder.trim()
    ? cfg.backupFolder
    : defaultBackupFolder();
}

// O atalho de inicializacao do Windows abre o programa ESCONDIDO (--hidden).
// Ele fica quieto o dia inteiro e so aparece na hora de fechar a loja — que e
// o pedido original: "no fim do dia, peca para a pessoa baixar".
const startedHidden = process.argv.includes('--hidden');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 680,
    show: !startedHidden,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Fechamento do Dia',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Nada de abrir link externo dentro do programa.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Lembrete do fim do dia: enquanto o programa estiver rodando (escondido ou
// nao), na virada da hora ele aparece e avisa a tela. Confere de minuto em
// minuto porque o computador pode ter dormido no meio do caminho — um
// setTimeout unico para as 18h nao sobrevive a suspensao da maquina.
function startCloseReminder() {
  let lastFired = '';
  closeReminderTimer = setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() < CLOSE_HOUR || lastFired === today) return;
    lastFired = today;

    if (!mainWindow) createWindow();
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.flashFrame(true);
    mainWindow.webContents.send('daily-backup:reminder');
  }, 60000);
}

app.on('second-instance', () => {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  createWindow();
  startCloseReminder();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // No Windows o programa continua vivo depois que a janela fecha SE ele foi
  // aberto junto com o sistema: e assim que ele consegue reaparecer as 18h.
  // Fechado pela pessoa num dia normal, encerra de vez.
  if (startedHidden) return;
  if (closeReminderTimer) clearInterval(closeReminderTimer);
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ──────────────────────────────────────────────────────────

ipcMain.handle('daily-backup:get-folder', () => currentBackupFolder());

ipcMain.handle('daily-backup:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Onde salvar os fechamentos do dia?',
    defaultPath: currentBackupFolder(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  writeConfig({ backupFolder: result.filePaths[0] });
  return result.filePaths[0];
});

ipcMain.handle('daily-backup:save', async (_event, payload) => {
  try {
    const { folder, files } = writeDailyFiles({
      baseFolder: currentBackupFolder(),
      subfolder: payload && payload.subfolder,
      files: payload && payload.files
    });
    lastSavedFolder = folder;
    console.log(`[Fechamento] ${files.length} arquivo(s) salvos em ${folder}`);
    return { ok: true, folder, files };
  } catch (err) {
    console.error('[Fechamento] Falha ao salvar:', err);
    // Quase sempre e pasta de rede fora do ar, pen drive removido ou permissao
    // negada — o texto do sistema e o que ajuda quem esta olhando a tela.
    return { ok: false, error: err.message || 'Erro desconhecido ao gravar os arquivos.' };
  }
});

ipcMain.handle('daily-backup:open-folder', async () => {
  const target = lastSavedFolder || currentBackupFolder();
  if (!fs.existsSync(target)) return { ok: false, error: 'A pasta ainda não existe.' };
  await shell.openPath(target);
  return { ok: true, folder: target };
});

// Abrir junto com o Windows, escondido, para poder avisar as 18h.
ipcMain.handle('daily-backup:get-autostart', () => {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
});

ipcMain.handle('daily-backup:set-autostart', (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    args: ['--hidden']
  });
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
});

ipcMain.handle('app:quit', () => {
  if (closeReminderTimer) clearInterval(closeReminderTimer);
  app.exit(0);
});
