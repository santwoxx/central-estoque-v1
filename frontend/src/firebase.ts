import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  CACHE_SIZE_UNLIMITED
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDXen38LRqBt2qkCkS2nlAPhWVhyZfwDs4",
  authDomain: "central-autocar.firebaseapp.com",
  projectId: "central-autocar",
  storageBucket: "central-autocar.firebasestorage.app",
  messagingSenderId: "560659713877",
  appId: "1:560659713877:web:6cb4be62d099494a5c29dc",
  measurementId: "G-3TLZZBS5RX"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Authentication
export const auth = getAuth(app);

// ── Cache offline, ligado na CRIACAO do Firestore ────────────────────
// ANTES: getFirestore(app) e, uma linha depois,
// enableMultiTabIndexedDbPersistence(db).catch(console.error).
//
// Duas coisas erradas nisso. A primeira e o aviso de deprecacao que aparecia no
// console a cada carregamento. A segunda importa dinheiro: aquela forma liga o
// cache DEPOIS que o Firestore ja subiu, e quando ela falha o erro morre dentro
// do .catch — a sessao inteira segue sem cache nenhum e ninguem fica sabendo.
// Sem cache, cada F5 refaz do zero a leitura da colecao `stock` inteira (uma
// leitura cobrada por pneu cadastrado, em toda aba de todo aparelho). Com o
// cache no lugar o listener reconecta com resume token e so paga pelos
// documentos que mudaram desde a ultima vez.
//
// Isso e mitigacao de custo, nao teto: quem estoura a cota de leituras do plano
// gratuito e o volume de sessoes frias (inclusive a consulta publica, que
// qualquer visitante abre sem login). Ver o relatorio da reserva da Alice.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
    cacheSizeBytes: CACHE_SIZE_UNLIMITED
  })
});
