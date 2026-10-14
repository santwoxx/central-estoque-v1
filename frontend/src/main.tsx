import {StrictMode, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import './index.css';

// ── Rotas, decididas ANTES de baixar qualquer tela ───────────────────
// As duas páginas públicas — o catálogo que o cliente abre pelo link e a
// assinatura do motorista — não têm login. ANTES elas eram decididas dentro do
// App, o que obrigava o celular do cliente a baixar o sistema inteiro (telas
// de administração, Auth, notificações) para mostrar só o catálogo. Agora cada
// rota baixa só o que usa.
//
// O caminho chega com a barra final quando alguém copia o link do navegador ou
// o WhatsApp "arruma" a URL: sem normalizar, '/consulta/' não batia com nenhuma
// rota e caía na tela de login.
const route = window.location.pathname.replace(/\/+$/, '') || '/';

const App = lazy(() => import('./App.tsx'));
const PublicStock = lazy(() => import('./components/PublicStock.tsx'));
const PublicSignature = lazy(() => import('./components/PublicSignature.tsx'));

const Page = route === '/consulta' ? PublicStock : route === '/assinar' ? PublicSignature : App;

// Enquanto a tela chega. Um chunk que sumiu num deploy cai no ErrorBoundary,
// que recarrega a página sozinho.
const loading = (
  <div className="min-h-screen flex items-center justify-center bg-slate-50">
    <div className="h-6 w-6 border-2 border-gold-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={loading}>
        <Page />
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
