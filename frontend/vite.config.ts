import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        // Duas páginas, o mesmo app: consulta.html é o index.html com o
        // cabeçalho do catálogo instalável (manifesto, ícone, nome) — ver o
        // comentário no próprio arquivo. Os pedaços de JS são compartilhados.
        input: {
          main: path.resolve(__dirname, 'index.html'),
          consulta: path.resolve(__dirname, 'consulta.html'),
        },
        output: {
          // ── Bibliotecas em pedaços próprios ─────────────────────────────
          // Firebase e React são ~75% do download e quase nunca mudam; o
          // código do sistema muda a cada deploy. Num pedaço só, todo deploy
          // obrigava cada celular a baixar 1,2 MB de novo. Separados, o
          // navegador reaproveita o cache das bibliotecas e baixa só o que
          // mudou. O Auth fica num pedaço à parte porque as páginas públicas
          // (consulta e assinatura) não fazem login e não devem baixá-lo.
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (/[\\/]node_modules[\\/]@?firebase[\\/]auth[\\/]/.test(id)) return 'firebase-auth';
            if (/[\\/]node_modules[\\/](@firebase|firebase|re2js|idb)[\\/]/.test(id)) return 'firebase';
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons';
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
