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

## Estoque das lojas a partir do relatório do ERP

1. No Time Sistemas, tire o **Relatório de estoque** da loja inteira (*Grupo: Todos*, *Marca: Todas*, *Saldo: Positivos*) em PDF e salve na raiz do projeto. PDFs na raiz não vão para o GitHub (ver `.gitignore`).
2. Gere o JSON da loja (requer `pip install pypdf`):
   ```bash
   python tools/estoque-time-sistemas.py "estoque atualizado saj.pdf" SAJ frontend/src/saj_estoque.json "--loja=Saj pneus"
   ```
   O script confere tudo contra o rodapé do relatório (produtos, unidades e totais em R$) e não grava nada se não bater. No fim, lista o que mudou em relação ao arquivo anterior e os produtos cuja marca precisa de conferência.
3. Publique o frontend e, como administrador, use **Sincronizar Estoque &lt;loja&gt;** em Cadastros e Ajustes. Antes de gravar, a tela mostra a prévia: produtos novos, saldo que muda, zerados, preço que muda e o que precisa de conferência.

Regras da sincronização (detalhes em `frontend/src/utils/erpSync.ts`):
- O saldo que fica é o do ERP na hora da emissão **somado ao que o sistema movimentou depois dela** — uma venda registrada no sistema depois do relatório não é desfeita.
- Em produto que já existe, mudam só saldo e preço. Marca, modelo, medida, custo, foto e observações ficam como estão.
- Produto que sumiu do relatório é zerado (nunca apagado), e só quando o relatório cobre a loja inteira. Reserva nunca é solta.
- Cada alteração vai para a Auditoria como "Ajuste", com o saldo de antes e o de depois. Rodar de novo com o mesmo arquivo não muda nada.

## Fotos dos pneus

O dono de cada loja coloca até 4 fotos em cada pneu da própria loja (o administrador, em qualquer loja). A câmera ou a galeria abre ao tocar na foto do produto em **Cadastros e Ajustes** ou no **Estoque Unificado**, ou no botão **Fotos do pneu** da ficha do produto. A primeira foto é a capa que aparece na lista. O vendedor e o catálogo público (`/consulta`) só veem as fotos.

Como funciona (detalhes em `frontend/src/utils/productPhotos.ts`):
- A foto é reduzida e comprimida no próprio aparelho (lado maior de 1024 px, cerca de 150 KB) e gravada no Firestore, na coleção `stock_photos`, com um documento por pneu. O Storage do Firebase não é usado porque exige o plano pago.
- O documento de estoque guarda só a contagem (`photoCount`) e a capa em miniatura (`photoThumb`, cerca de 4 KB). A coleção `stock` é baixada inteira por todo mundo, inclusive pelo catálogo público, e por isso as fotos em tamanho de tela só são lidas quando alguém abre o pneu.
- A sincronização com o ERP, a restauração de backup e as transferências não mexem nas fotos. Excluir o pneu apaga as fotos dele.

**As regras do Firestore precisam estar publicadas** com o bloco `match /stock_photos/{itemId}` de `firestore.rules`. Sem ele, o banco recusa a foto e a tela avisa que faltam as regras. Para publicar, abra o Console do Firebase, vá em Firestore Database > Regras, cole o arquivo inteiro e clique em Publicar. Outra opção é rodar `firebase deploy --only firestore:rules` na raiz do projeto.
