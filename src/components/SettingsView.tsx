import { useState, useSyncExternalStore } from 'react';
import { signOut, type AuthState } from '../lib/auth';
import { MAX_WPM, MIN_WPM } from '../lib/rsvp';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../lib/settings';
import { getSyncStatus, subscribeSyncStatus, syncNow } from '../lib/sync';
import type { Settings } from '../types';

interface Props {
  settings: Settings;
  auth: AuthState;
  onSave: (settings: Settings) => void;
}

export function SettingsView({ settings, auth, onSave }: Props) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const sync = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  function numberField(key: 'wpm' | 'minWords' | 'maxWords' | 'questionsPerQuiz' | 'newCardsPerDay', min: number, max: number, step = 1) {
    return (
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(draft[key]) ? draft[key] : ''}
        onChange={(e) => set(key, e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
    );
  }

  return (
    <section>
      <h1>Settings</h1>
      <div className="stack">
        <fieldset>
          <legend>Account and sync</legend>
          <p>
            {auth.status === 'signed-in'
              ? `Signed in as ${auth.email}.`
              : 'Running locally without a login. Data syncs to a file in this project folder.'}
          </p>
          <p className="muted" role="status">
            {sync.state === 'syncing'
              ? 'Syncing…'
              : sync.message
                ? sync.message
                : sync.lastSyncedAt
                  ? `Last synced at ${new Date(sync.lastSyncedAt).toLocaleTimeString()}.`
                  : 'Not synced yet.'}
            {sync.pending > 0 && sync.state !== 'syncing' && ` ${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting to sync.`}
          </p>
          <div className="row wrap">
            <button type="button" onClick={() => void syncNow()} disabled={sync.state === 'syncing'}>
              Sync now
            </button>
            {auth.status === 'signed-in' && (
              <button type="button" onClick={() => void signOut()}>
                Sign out
              </button>
            )}
          </div>
        </fieldset>

        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const clean = sanitizeSettings(draft);
            setDraft(clean);
            onSave(clean);
            setSaved(true);
          }}
        >
          <fieldset>
            <legend>Reading</legend>
            <div className="row wrap">
              <label className="narrow">
                Default speed (wpm)
                {numberField('wpm', MIN_WPM, MAX_WPM, 25)}
              </label>
              <label className="narrow">
                Re-read speed
                <select value={draft.rereadFactor} onChange={(e) => set('rereadFactor', Number(e.target.value))}>
                  <option value={0.5}>50% of normal</option>
                  <option value={0.6}>60% of normal</option>
                  <option value={0.75}>75% of normal</option>
                  <option value={0.9}>90% of normal</option>
                </select>
              </label>
            </div>
            <div className="row wrap">
              <label className="narrow">
                Section min words
                {numberField('minWords', 20, 5000, 10)}
              </label>
              <label className="narrow">
                Section max words
                {numberField('maxWords', 50, 5000, 10)}
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Quiz and study</legend>
            <div className="row wrap">
              <label className="narrow">
                Questions per quiz (3–5)
                {numberField('questionsPerQuiz', 3, 5)}
              </label>
              <label className="narrow">
                New cards per day
                {numberField('newCardsPerDay', 0, 500)}
              </label>
            </div>
          </fieldset>

          <p className="muted">These settings are kept on this device, so your phone and laptop can differ.</p>

          <div className="row">
            <button className="primary" type="submit">
              Save settings
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft({ ...DEFAULT_SETTINGS });
                setSaved(false);
              }}
            >
              Reset to defaults
            </button>
            {saved && (
              <span className="good-text" role="status">
                Saved
              </span>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
