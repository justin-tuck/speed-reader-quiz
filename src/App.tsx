import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { DocView } from './components/DocView';
import { ImportView } from './components/ImportView';
import { Library } from './components/Library';
import { SessionView } from './components/SessionView';
import { SettingsView } from './components/SettingsView';
import { StudyView } from './components/StudyView';
import { getAuthState, initAuth, signIn, subscribeAuth } from './lib/auth';
import { loadSettings, saveSettings } from './lib/settings';
import { getSyncStatus, onRemoteChange, startSync, subscribeSyncStatus } from './lib/sync';
import type { Settings } from './types';

type View =
  | { name: 'library' }
  | { name: 'import' }
  | { name: 'doc'; docId: string }
  | { name: 'session'; docId: string; sectionIndex: number }
  | { name: 'study' }
  | { name: 'settings' };

function SyncBadge() {
  const sync = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
  const label =
    sync.state === 'syncing'
      ? 'Syncing…'
      : sync.state === 'offline'
        ? 'Offline'
        : sync.state === 'error'
          ? 'Sync problem'
          : sync.lastSyncedAt
            ? 'Synced'
            : '';
  if (!label) return null;
  return (
    <span className={`sync-badge ${sync.state}`} title={sync.message ?? 'Your data is saved to your account'} role="status">
      {label}
    </span>
  );
}

export function App() {
  const auth = useSyncExternalStore(subscribeAuth, getAuthState);
  const [view, setView] = useState<View>({ name: 'library' });
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // Bumped when a sync brings in changes from another device, so lists reload.
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    void initAuth();
  }, []);

  const ready = auth.status === 'local' || auth.status === 'signed-in';
  useEffect(() => {
    if (!ready) return;
    const stopListening = onRemoteChange(() => setDataVersion((v) => v + 1));
    const stopSync = startSync();
    return () => {
      stopListening();
      stopSync();
    };
  }, [ready]);

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const setWpm = useCallback((wpm: number) => {
    setSettings((current) => {
      const next = { ...current, wpm };
      saveSettings(next);
      return next;
    });
  }, []);

  const navItem = (label: string, target: View, active: boolean) => (
    <button className={active ? 'nav-item active' : 'nav-item'} onClick={() => setView(target)}>
      {label}
    </button>
  );

  if (!ready) {
    return (
      <div className="app">
        <header className="top">
          <span className="brand">Speed Reader Quiz</span>
        </header>
        <main className="gate">
          {auth.status === 'loading' && <p className="muted">Loading…</p>}
          {auth.status === 'unavailable' && (
            <div className="card">
              <h1>The app's server could not be reached</h1>
              <p>Check your connection and reload the page.</p>
              <button className="primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          )}
          {auth.status === 'signed-out' && (
            <div className="card">
              <h1>Sign in</h1>
              <p>Sign in to read, take quizzes and keep your progress in sync across your devices.</p>
              {auth.error && (
                <p className="notice error" role="alert">
                  {auth.error}
                </p>
              )}
              <button className="primary" onClick={() => void signIn()}>
                Sign in
              </button>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <span className="brand">
          Speed Reader Quiz <SyncBadge />
        </span>
        <nav>
          {navItem('Library', { name: 'library' }, ['library', 'import', 'doc', 'session'].includes(view.name))}
          {navItem('Study', { name: 'study' }, view.name === 'study')}
          {navItem('Settings', { name: 'settings' }, view.name === 'settings')}
        </nav>
      </header>

      <main>
        {view.name === 'library' && (
          <Library
            dataVersion={dataVersion}
            onOpen={(docId) => setView({ name: 'doc', docId })}
            onAdd={() => setView({ name: 'import' })}
          />
        )}
        {view.name === 'import' && (
          <ImportView
            settings={settings}
            onSaved={(docId) => setView({ name: 'doc', docId })}
            onCancel={() => setView({ name: 'library' })}
          />
        )}
        {view.name === 'doc' && (
          <DocView
            docId={view.docId}
            dataVersion={dataVersion}
            onRead={(sectionIndex) => setView({ name: 'session', docId: view.docId, sectionIndex })}
            onBack={() => setView({ name: 'library' })}
          />
        )}
        {view.name === 'session' && (
          <SessionView
            key={`${view.docId}:${view.sectionIndex}`}
            docId={view.docId}
            sectionIndex={view.sectionIndex}
            settings={settings}
            onWpmChange={setWpm}
            onGoToSection={(sectionIndex) => setView({ name: 'session', docId: view.docId, sectionIndex })}
            onExit={() => setView({ name: 'doc', docId: view.docId })}
          />
        )}
        {view.name === 'study' && (
          <StudyView settings={settings} dataVersion={dataVersion} onGoToLibrary={() => setView({ name: 'library' })} />
        )}
        {view.name === 'settings' && <SettingsView settings={settings} auth={auth} onSave={updateSettings} />}
      </main>
    </div>
  );
}
