const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────
// Gravacao dos arquivos do fechamento do dia.
//
// Separado do main.js porque aqui nao ha nada do Electron, so Node puro — e
// esta e a parte que mexe no disco do usuario, entao ela pode (e deve) ser
// testada com `node` antes de virar instalador.
// ─────────────────────────────────────────────────────────────────

// O nome do arquivo chega da TELA, e tela e a parte que roda codigo de fora.
// Entao nada do que vem de la pode virar caminho: basename() derruba qualquer
// pasta embutida ("..\\..\\", "C:\\Windows\\") e a troca em seguida deixa so
// letras, numeros, ponto, hifen e underscore.
function safeName(value) {
  const base = path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  // "." e ".." atravessam o filtro acima (ponto e caractere valido em nome de
  // arquivo) e voltariam a ser caminho: path.join(pasta, '..') sobe um nivel e
  // grava FORA da pasta de fechamentos.
  if (/^\.+$/.test(base)) return 'arquivo';
  return base.slice(0, 120) || 'arquivo';
}

// Grava os arquivos em <baseFolder>/<subfolder>/ e devolve onde foi.
function writeDailyFiles({ baseFolder, subfolder, files }) {
  if (!baseFolder) throw new Error('Pasta de destino não definida.');
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Nenhum arquivo para salvar.');
  }

  const folder = path.join(baseFolder, safeName(subfolder || 'sem-data'));
  fs.mkdirSync(folder, { recursive: true });

  const written = [];
  for (const file of files) {
    const name = safeName(file && file.name);
    fs.writeFileSync(path.join(folder, name), String((file && file.content) || ''), 'utf8');
    written.push(name);
  }

  return { folder, files: written };
}

module.exports = { safeName, writeDailyFiles };
