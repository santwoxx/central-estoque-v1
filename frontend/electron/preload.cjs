// CommonJS on purpose (.cjs extension): the rest of this project is
// "type": "module", and Electron's preload script loader resolves module
// type from the nearest package.json — without the explicit .cjs extension
// this file would be loaded as ESM and `require()` below would throw.
const { contextBridge } = require('electron');

// PDF/XML/CSV/text importing already runs entirely client-side (see
// frontend/src/utils/parsers.ts, which uses PDF.js in the browser) — that
// code path works unchanged inside Electron's renderer, since it's just a
// normal Chromium tab. This bridge only needs to let the app know it's
// running inside the desktop shell, e.g. so AuthScreen.tsx can hide the
// "baixe o app desktop" banner when you're already using it.
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true
});
