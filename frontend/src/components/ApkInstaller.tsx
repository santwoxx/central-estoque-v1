import React, { useState } from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbWebUsbBackendManager } from '@yume-chan/adb-backend-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { PackageManager } from '@yume-chan/android-bin';
import { WrapReadableStream } from '@yume-chan/stream-extra';
import { Smartphone, Upload, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

const manager = AdbWebUsbBackendManager.BROWSER;
const credentialStore = new AdbWebCredentialStore();

export const ApkInstaller: React.FC = () => {
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [adb, setAdb] = useState<Adb | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectDevice = async () => {
    try {
      if (!manager) {
        throw new Error("WebUSB is not supported in this browser. Please use Google Chrome or Microsoft Edge on a Desktop.");
      }
      
      setError(null);
      setStatus('Requesting device...');
      const backend = await manager.requestDevice();
      if (!backend) {
        setStatus('No device selected');
        return;
      }

      setStatus('Connecting to device...');
      const connection = await backend.connect();
      
      setStatus('Authenticating with ADB... Please check your device screen and click "Allow USB Debugging".');
      const transport = await AdbDaemonTransport.authenticate({
        serial: backend.serial,
        connection,
        credentialStore,
      });

      setStatus('Starting ADB...');
      const adbInstance = new Adb(transport);
      
      setDeviceName(backend.name);
      setAdb(adbInstance);
      setStatus('Device connected successfully!');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to connect to device');
      setStatus('');
    }
  };

  const disconnectDevice = async () => {
    if (adb) {
      await adb.close();
    }
    setDeviceName(null);
    setAdb(null);
    setFile(null);
    setStatus('');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const installApk = async () => {
    if (!adb || !file) return;

    setIsInstalling(true);
    setError(null);
    setStatus('Preparing installation...');

    try {
      const pm = new PackageManager(adb);
      setStatus('Streaming APK to device...');
      
      let stream;
      if (file.stream) {
        // stream-extra's WrapReadableStream bridges standard Web Streams to Yume-chan's streams
        stream = new WrapReadableStream(file.stream() as any);
      } else {
        throw new Error("Browser does not support File.stream()");
      }

      await pm.installStream(stream, file.size);
      
      setStatus('Installation completed successfully!');
      
      setFile(null);
      const fileInput = document.getElementById('apk-upload') as HTMLInputElement;
      if (fileInput) fileInput.value = '';

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Installation failed');
      setStatus('Installation failed');
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto p-6 bg-white rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.04)] border border-slate-200">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
        <div className="p-3 bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] rounded-xl shadow-inner border border-gold-300/30">
          <Smartphone className="w-6 h-6 stroke-[2]" />
        </div>
        <div>
          <h2 className="text-lg font-black text-slate-800 tracking-tight">APK Installer</h2>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Via WebUSB</p>
        </div>
      </div>

      {!deviceName ? (
        <div className="space-y-4">
          <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl text-sm font-semibold text-slate-600 leading-relaxed">
            Conecte seu dispositivo Android via cabo USB e certifique-se de que a <strong>Depuração USB</strong> está ativada nas Opções de Desenvolvedor.
          </div>
          <button
            onClick={connectDevice}
            className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 text-gold-400 border border-gold-500/20 shadow-[0_2px_10px_rgba(212,147,33,0.15)] font-black uppercase tracking-wider rounded-xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-xs"
          >
            Conectar Dispositivo
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-3 bg-green-50/50 border border-green-200/50 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="w-5 h-5" />
              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-wider text-green-600/70">Conectado</span>
                <span className="text-sm font-black tracking-tight">{deviceName}</span>
              </div>
            </div>
            <button 
              onClick={disconnectDevice}
              className="text-xs font-bold text-slate-400 hover:text-red-500 transition-colors"
            >
              Desconectar
            </button>
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">
              Arquivo APK
            </label>
            <input
              id="apk-upload"
              type="file"
              accept=".apk"
              onChange={handleFileChange}
              className="block w-full text-sm font-semibold text-slate-600 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-black file:uppercase file:tracking-wider file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 border border-slate-200 rounded-xl p-1.5 transition-colors cursor-pointer"
              disabled={isInstalling}
            />
          </div>

          <button
            onClick={installApk}
            disabled={!file || isInstalling}
            className={`w-full py-3 px-4 font-black uppercase tracking-wider text-xs rounded-xl transition-all flex items-center justify-center gap-2 ${
              !file || isInstalling
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                : 'bg-gradient-to-r from-gold-600 to-amber-500 text-white shadow-lg shadow-gold-500/20 active:scale-[0.98] cursor-pointer'
            }`}
          >
            {isInstalling ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Instalando...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Instalar no Dispositivo
              </>
            )}
          </button>
        </div>
      )}

      {(status || error) && (
        <div className={`mt-5 p-3 rounded-xl border flex items-start gap-2.5 transition-all ${
          error ? 'bg-red-50/50 border-red-200/50 text-red-700' : 'bg-slate-50 border-slate-200 text-slate-600'
        }`}>
          {error ? (
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <Loader2 className={`w-4 h-4 shrink-0 mt-0.5 ${status.includes('successfully') || status.includes('Conectado') ? 'hidden' : 'animate-spin'}`} />
          )}
          <div className="text-xs font-semibold leading-relaxed break-words">
            {error || status}
          </div>
        </div>
      )}
    </div>
  );
};
