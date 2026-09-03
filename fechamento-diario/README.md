# Fechamento do Dia — Central Estoque

Programa separado, de uma tarefa só: **baixar a cópia do dia da sua loja**.
Não abre o sistema, não edita estoque, não tem abas. Entra com a mesma
credencial que a pessoa já usa, lê, grava os arquivos numa pasta do computador
e sai.

## O que ele salva

Uma pasta por dia, dentro da pasta escolhida
(padrão: `Documentos\Central Estoque\Fechamentos\2026-09-01\`):

| Arquivo | O que tem dentro |
|---|---|
| `estoque-<loja>-<data>.csv` | O estoque inteiro da loja: código, medida, marca, modelo, quantidade física, reservado, disponível e os dois preços |
| `movimentacoes-<loja>-<data>.csv` | Tudo que se moveu **naquele dia**: vendas, entradas, ajustes e transferências, com cliente, documento, placa e valores |
| `transferencias-<loja>-<data>.csv` | Os pedidos de transferência que andaram no dia, com origem, destino, itens e situação |
| `fechamento-<loja>-<data>.json` | A cópia completa, no formato que a tela **Restaurar Backup** do sistema lê. É este arquivo que salva a loja se o estoque for apagado por engano |

Os CSV abrem direto no Excel em português (separador `;` e acentuação certa).

## Como usar

1. Instale com `Fechamento Central Estoque Setup 1.0.0.exe`.
2. Entre com **o mesmo usuário e senha do sistema**. A loja vem da credencial —
   cada pessoa baixa o estoque da própria filial.
3. Confira a pasta de destino (dá para trocar a qualquer momento) e clique em
   **Salvar fechamento do dia**.

Duas opções que valem marcar na primeira vez:

- **Manter conectado neste computador** — não pede senha todo fim de dia.
- **Abrir com o Windows e avisar às 18h** — o programa passa a subir junto com
  o computador, fica escondido o dia inteiro e **aparece sozinho às 18h**
  pedindo o fechamento. É esta opção que faz o lembrete acontecer sem ninguém
  precisar lembrar.

## Desenvolvimento

```bash
npm install
npm start      # abre o programa em modo desenvolvimento
npm run dist   # gera o instalador em dist/
```

- `electron/main.js` — janela, escolha de pasta, gravação em disco e o
  lembrete das 18h. **Só ele decide onde grava**: a tela manda nome de arquivo
  e conteúdo, nunca um caminho.
- `electron/dailyBackup.js` — a gravação em si, sem nada do Electron, para
  poder ser testada com `node`.
- `renderer/app.js` — login, leitura do Firestore e montagem dos arquivos.
  É empacotado em `renderer/bundle.js` pelo esbuild (`npm run build:renderer`),
  que roda sozinho antes de `start` e `dist`.

O programa usa o mesmo projeto Firebase do sistema (`central-autocar`) e
obedece às mesmas regras do Firestore: ele só consegue ler o que aquela
credencial já podia ler. A única escrita que faz é o próprio perfil da sessão
em `users/{uid}` — exigido pelas regras para liberar a leitura das
movimentações e transferências.
