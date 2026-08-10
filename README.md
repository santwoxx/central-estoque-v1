# Central Stoque

Este repositório foi dividido em dois subprojetos principais para facilitar o deploy independente:

## Frontend (Deploy na Vercel)
Contém a aplicação React construída com Vite, Tailwind CSS e Firebase.

**Como rodar localmente:**
```bash
cd frontend
npm install
npm run dev
```
Acesse `http://localhost:5173`.

## Backend (Deploy no Render)
Contém a API em Express/Node.js responsável por processar PDFs, XML de NF-e, CSV e fotos de notas — via parsers locais em RegEx, sem IA (a leitura de PDF/XML/CSV/texto colado já roda 100% no navegador; o backend serve como parser de apoio e cobre o caso de imagens).

**Como rodar localmente:**
```bash
cd backend
npm install
npm run dev
```
A API vai escutar na porta `3000` por padrão.

## Desktop (Windows/Mac/Linux via Electron)
Empacota o mesmo frontend como um aplicativo local, com login idêntico ao site (Firebase Auth via um servidor HTTP local embutido, necessário para o popup do Google funcionar) e leitura de PDF/XML/CSV client-side, igual ao site.

**Como rodar em desenvolvimento** (com `npm run dev` do frontend já ativo em outro terminal):
```bash
cd frontend
npm run electron:dev
```

**Como gerar o instalador:**
```bash
cd frontend
npm run electron:build
```
Gera o instalador em `frontend/dist-electron/`.
