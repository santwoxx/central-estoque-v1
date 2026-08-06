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
Contém a API em Express/Node.js responsável por processar PDFs via Google Gemini AI.

**Como rodar localmente:**
```bash
cd backend
npm install
npm run dev
```
A API vai escutar na porta `3000` por padrão. Lembre-se de configurar a variável `GEMINI_API_KEY` no arquivo `.env` dentro da pasta `/backend`.
