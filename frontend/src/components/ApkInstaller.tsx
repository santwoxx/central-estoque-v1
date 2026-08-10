import React from 'react';
import { Smartphone, Download } from 'lucide-react';

export const ApkInstaller: React.FC = () => {
  return (
    <div className="w-full max-w-md mx-auto p-6 bg-white rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.04)] border border-slate-200">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
        <div className="p-3 bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] rounded-xl shadow-inner border border-gold-300/30">
          <Smartphone className="w-6 h-6 stroke-[2]" />
        </div>
        <div>
          <h2 className="text-lg font-black text-slate-800 tracking-tight">Aplicativo Mobile</h2>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Download direto</p>
        </div>
      </div>

      <div className="space-y-4 text-center">
        <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl text-sm font-semibold text-slate-600 leading-relaxed text-left">
          Baixe o arquivo <strong>APK</strong> diretamente pelo Google Drive e instale no seu dispositivo Android.
        </div>
        <a
          href="COLOQUE_AQUI_O_LINK_DO_GOOGLE_DRIVE"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 text-gold-400 border border-gold-500/20 shadow-[0_2px_10px_rgba(212,147,33,0.15)] font-black uppercase tracking-wider rounded-xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-xs"
        >
          <Download className="w-4 h-4" />
          Baixar pelo Google Drive
        </a>
      </div>
    </div>
  );
};
