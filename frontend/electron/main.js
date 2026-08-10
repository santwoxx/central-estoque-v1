import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Blindagem contra Falhas Fatais (Crash Prevention)
process.on('uncaughtException', (error) => {
  console.error('[Electron] Uncaught Exception:', error);
  // Mantém o app rodando
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Electron] Unhandled Rejection at:', promise, 'reason:', reason);
  // Mantém o app rodando
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

// Variável para armazenar o servidor HTTP
let localServer = null;

function serveDistFolder(distDir) {
  return new Promise((resolve, reject) => {
    // 2. Servidor HTTP Robusto
    localServer = http.createServer((req, res) => {
      // 2.1 Rejeita métodos que não sejam GET ou HEAD
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      // 2.2 Cabeçalhos de Segurança e Cache
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(distDir, reqPath);

      // Proteção de travessia de diretório (Directory Traversal)
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // SPA fallback
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }

      // Adicionar cache para arquivos estáticos (melhora performance)
      if (filePath.match(/\.(js|css|woff2?|png|jpe?g|svg)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 ano
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }

      // Se for apenas HEAD, termina aqui
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      // 2.3 Tratamento de erro de leitura robusto
      fs.readFile(filePath, (err, data) => {
        if (err) {
          console.error(`[Servidor Local] Erro ao ler arquivo ${filePath}:`, err.message);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });

    localServer.on('error', (err) => {
      console.error('[Servidor Local] Falha crítica:', err);
      reject(err);
    });
    
    localServer.listen(0, 'localhost', () => {
      const port = localServer.address().port;
      console.log(`[Servidor Local] Rodando com sucesso na porta ${port}`);
      resolve(port);
    });
  });
}

let mainWindow;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    }
  }));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    try {
      const distDir = path.join(__dirname, '../dist');
      const port = await serveDistFolder(distDir);
      mainWindow.loadURL(`http://localhost:${port}/`);
    } catch (err) {
      console.error('[Electron] Falha ao iniciar servidor local:', err);
      // Fallback seguro caso o servidor falhe por porta bloqueada, etc
      mainWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent('<h1>Erro fatal ao iniciar o servidor interno. Verifique seu firewall ou antivírus.</h1>'));
    }
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 3. Fechamento Gracioso do Servidor HTTP
app.on('window-all-closed', () => {
  if (localServer) {
    console.log('[Servidor Local] Encerrando servidor HTTP graciosamente...');
    localServer.close();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
