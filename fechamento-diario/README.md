# Fechamento do Dia — Central Estoque

Programa separado, de uma tarefa só: **todo dia às 18h, sem ninguém clicar,
salva numa pasta do computador a planilha do dia** — vendas, estoque, movimento,
transferências, baixas pendentes e a conferência de saldo.

Fica escondido na bandeja do Windows (perto do relógio). Não edita estoque e
não tem abas: entra com a mesma conta que a pessoa usa no sistema, lê, grava e
volta a esperar o dia seguinte.

## O que ele salva

Um arquivo por dia, organizado por mês
(padrão: `Documentos\Central Estoque\Fechamentos\2026-09\`):

| Arquivo | Para quê |
|---|---|
| `Fechamento <loja> <data>.xlsx` | A planilha para ler. Abre direto no Excel. |
| `backup\fechamento-<loja>-<data>.json` | A cópia que **restaura**: é o formato que a tela *Restaurar Backup* do sistema lê. |

Abas da planilha:

| Aba | O que tem |
|---|---|
| **Resumo** | Uma linha por loja (vendas, outras saídas, entradas, transferências, estoque, reservado, livre, baixas pendentes, divergências). Abaixo, as **medidas vendidas no dia** e as **saídas que não são venda, por motivo e por quem fez** — exclusão de cadastro sai destacada. |
| **Vendas** | Cada venda do dia: hora, loja, cliente, CPF/CNPJ, placa, documento, medida, pneu, quantidade, valor, quem pediu e quem aprovou. |
| **Saídas por medida** | Tudo que saiu no dia agrupado por medida e loja: vendidas, outras saídas e enviadas para outra loja. As mais vendidas primeiro — é a lista de reposição. |
| **Estoque *loja*** | Uma aba por empresa, com o estoque dela no fechamento (físico, reservado, livre, preços), ordenado por medida. Loja que terminou o dia zerada também ganha a aba, dizendo isso. |
| **Movimentações** | Tudo que se moveu no dia. |
| **Transferências** | Os pedidos entre lojas que andaram no dia. |
| **Baixas pendentes** | Pneus presos esperando aprovação na hora do fechamento. |
| **Conferência** | Pneus cujo saldo no cadastro **não bate** com o último movimento registrado. Vazia é o resultado bom. |

**Quem vê o quê:** o administrador recebe **todas as lojas** numa planilha só;
o dono da loja recebe a dele. Vendedor não usa este programa.

## Como instalar (para enviar a quem vai usar)

1. Baixe `Fechamento-Central-Estoque-Setup-2.1.1.exe` e abra.
2. O Windows vai mostrar **"O Windows protegeu o computador"**. É porque o
   programa não tem assinatura digital paga — não é vírus. Clique em
   **Mais informações** → **Executar assim mesmo**.
3. Instale (Avançar → Instalar). No fim, o programa abre sozinho.
4. **Conta com Google** (é o caso de quem entra no sistema pelo Google):
   clique em **Entrar com Google**. Vai abrir o navegador — escolha a mesma
   conta Google do sistema, espere aparecer "Pronto", volte ao programa e
   digite **usuário e senha do sistema**.
   **Conta sem Google:** usuário e senha direto na tela.
5. Pronto. Pode fechar a janela: o programa fica na bandeja e salva sozinho às
   18h, todo dia. O login fica guardado — não precisa entrar de novo.

## Como funciona o automático

- **Às 18h** o programa lê o banco e grava a planilha do dia. Aparece uma
  notificação do Windows com o total de vendas; tocar nela abre a pasta.
- **Abre junto com o Windows**, escondido. Vem ligado (dá para desligar na
  tela do programa) e é **regravado a cada abertura**, apontando para o
  executável que está rodando. Assim, instalar uma versão nova ou mudar o
  programa de pasta não deixa o Windows tentando abrir um arquivo que sumiu.
- **Computador desligado às 18h?** Na próxima vez que ligar, o programa
  recupera os dias perdidos (até 7). Esses arquivos são marcados: as vendas e o
  movimento são daquele dia, mas o **estoque é o do momento da recuperação**.
  Domingo e feriado sem movimento não geram arquivo.
- **Sem internet às 18h?** Tenta de novo a cada 15 minutos.
- **Sem login?** Avisa com uma notificação e abre a janela.
- Tem também o botão **Salvar o fechamento de hoje agora**, para quando a loja
  fechar mais cedo. Salvar de novo no mesmo dia substitui o arquivo do dia.

## Segurança

- **Nenhuma senha fica guardada no computador.** A versão 1 guardava usuário e
  senha em texto puro para entrar sozinha. Agora o login fica com o próprio
  Firebase, como no navegador, e o papel e a loja são relidos do servidor a
  cada abertura.
- O login Google acontece no **navegador de verdade**, não dentro do programa
  (o Google recusa login em janelas de programa). O navegador devolve ao
  programa só o comprovante do Google, amarrado a um código de uso único.
- O programa escuta só em `localhost`, e só entrega os arquivos da própria
  tela.

## Desenvolvimento

```bash
npm install
node node_modules/electron/install.js   # se o npm bloquear o download do Electron
npm start      # abre em modo desenvolvimento
npm run dist   # gera o instalador em release/
```

> Rodando de dentro do VS Code, o terminal herda `ELECTRON_RUN_AS_NODE=1` e o
> Electron vira Node puro ("bad option: --hidden"). Use `env -u
> ELECTRON_RUN_AS_NODE npm start`.

- `electron/main.js` — janela, bandeja, agendamento das 18h, recuperação de
  dias perdidos, servidor local e retorno do login Google. **Só ele grava no
  disco.** Vai embutido (esbuild) em `main.bundle.js`, junto com o exceljs.
- `electron/dailyBackup.js` — monta a planilha e grava os arquivos. Node puro,
  testável com `node` sem o Electron.
- `renderer/app.js` — login e leitura do Firestore. Embutido em `bundle.js`.
- `renderer/google.js` — a página de login Google que abre no navegador.
- `build/make-icon.js` — gera o ícone sem dependência nenhuma.

O instalador fica em ~92 MB: o Firebase e o exceljs vão embutidos no código (e
não como `node_modules`), e só os idiomas português e inglês do Chromium
entram. Abaixo de 100 MB o Google Drive consegue verificar vírus no arquivo —
acima disso, mostra um aviso para quem baixa.

O programa usa o mesmo projeto Firebase do sistema (`central-autocar`) e
obedece às mesmas regras do Firestore. A única escrita que faz é o próprio
perfil da sessão em `users/{uid}`, no login.
