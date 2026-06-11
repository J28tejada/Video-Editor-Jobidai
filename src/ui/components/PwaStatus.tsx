/**
 * PWA install affordance + storage usage indicator.
 * - Desktop/Android: captures `beforeinstallprompt` → "Instalar" button.
 * - iOS Safari (not installed): shows the manual install hint.
 * - Always: shows storage used / quota with a warning when near the limit.
 */
import { useEffect, useState } from 'react';
import { detectPlatform, estimateStorage, formatBytes, type StorageEstimate } from '../../lib/platform';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

export function PwaStatus() {
  const [platform] = useState(detectPlatform);
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [storage, setStorage] = useState<StorageEstimate>(null);
  const [iosHintDismissed, setIosHintDismissed] = useState(
    () => localStorage.getItem('iosHintDismissed') === '1',
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    estimateStorage().then(setStorage);
    const interval = setInterval(() => estimateStorage().then(setStorage), 15000);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      clearInterval(interval);
    };
  }, []);

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  const showIosHint =
    platform.isIOS && !platform.standalone && !iosHintDismissed;

  const nearLimit = storage != null && storage.percent > 0.8;

  return (
    <div className="pwa">
      {storage && storage.quota > 0 && (
        <span
          className={`pwa__storage${nearLimit ? ' pwa__storage--warn' : ''}`}
          title="Almacenamiento usado por la app (proyecto + media + modelos)"
        >
          💾 {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
        </span>
      )}

      {installEvent && (
        <button className="pwa__install" onClick={install}>
          ⬇ Instalar app
        </button>
      )}

      {showIosHint && (
        <span className="pwa__ioshint">
          Instala: <strong>Compartir</strong> → <strong>Añadir a inicio</strong>
          <button
            className="pwa__dismiss"
            onClick={() => {
              localStorage.setItem('iosHintDismissed', '1');
              setIosHintDismissed(true);
            }}
            title="Ocultar"
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
