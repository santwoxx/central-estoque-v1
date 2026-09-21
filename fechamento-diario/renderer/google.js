import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  signInWithPopup
} from 'firebase/auth';

// ─────────────────────────────────────────────────────────────────
// Página de login Google — abre no NAVEGADOR da pessoa, não no programa.
//
// O Google não permite entrar numa janela de programa (Electron); só num
// navegador de verdade. Esta página, servida pelo próprio programa em
// localhost, faz o login e devolve ao programa apenas o comprovante do Google
// (idToken), junto com o código de uso único que o programa gerou. O programa
// então entra no Firebase com esse comprovante.
//
// Nada fica salvo neste navegador: a sessão aqui é só em memória.
// ─────────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: 'AIzaSyDXen38LRqBt2qkCkS2nlAPhWVhyZfwDs4',
  authDomain: 'central-autocar.firebaseapp.com',
  projectId: 'central-autocar',
  storageBucket: 'central-autocar.firebasestorage.app',
  messagingSenderId: '560659713877',
  appId: '1:560659713877:web:6cb4be62d099494a5c29dc'
};

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
  persistence: inMemoryPersistence,
  popupRedirectResolver: browserPopupRedirectResolver
});

const state = new URLSearchParams(location.search).get('state');
const $ = (id) => document.getElementById(id);

function show(kind, html) {
  $('msg').className = `msg ${kind}`;
  $('msg').innerHTML = html;
  $('msg').hidden = false;
}

function explain(err) {
  const code = (err && err.code) || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'A janela do Google foi fechada antes de terminar. Clique no botão de novo.';
  }
  if (code === 'auth/popup-blocked') {
    return 'O navegador bloqueou a janela do Google. Libere pop-ups para esta página e clique de novo.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'O endereço "localhost" não está autorizado no Firebase do sistema. Peça ao administrador para ' +
      'incluir "localhost" em Authentication → Settings → Authorized domains.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Sem conexão com a internet. Verifique a rede e clique de novo.';
  }
  return (err && err.message) || 'Não consegui concluir o login.';
}

if (!state) {
  $('btn').disabled = true;
  show('error', 'Esta página só funciona aberta pelo programa. Volte ao Fechamento do Dia e clique em <b>Entrar com Google</b>.');
}

$('btn').addEventListener('click', async () => {
  $('btn').disabled = true;
  $('btn').textContent = 'Aguardando o Google…';
  $('msg').hidden = true;

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const idToken = credential && credential.idToken;
    if (!idToken) throw new Error('O Google não devolveu o comprovante de login. Tente de novo.');

    const response = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, idToken })
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer.ok) {
      throw new Error(answer.error || 'O programa não aceitou o login. Volte a ele e tente de novo.');
    }

    $('btn').hidden = true;
    show(
      'ok',
      `Pronto, <b>${(result.user.email || '').replace(/</g, '&lt;')}</b>.<br>` +
        'Pode fechar esta aba e voltar ao <b>Fechamento do Dia</b> para terminar a entrada.'
    );
  } catch (err) {
    console.error(err);
    show('error', explain(err));
    $('btn').disabled = false;
    $('btn').textContent = 'Continuar com Google';
  }
});
