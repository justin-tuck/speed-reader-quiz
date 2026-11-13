/**
 * Sign-in. The app asks /config.json whether a login is required:
 *   - Running locally, it is not: everything belongs to one local user.
 *   - Deployed, it is: sign-in goes through the Cognito hosted login page
 *     (OAuth authorization code flow with PKCE).
 */
import type { AppConfig } from '../../shared/api';
import { configureApiAuth } from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unavailable' } // the backend could not be reached
  | { status: 'local' } // no login needed
  | { status: 'signed-out'; error?: string }
  | { status: 'signed-in'; email: string };

type Manager = import('oidc-client-ts').UserManager;

let state: AuthState = { status: 'loading' };
const listeners = new Set<() => void>();
let manager: Manager | null = null;
let authConfig: NonNullable<AppConfig['auth']> | null = null;

function setState(next: AuthState) {
  state = next;
  listeners.forEach((l) => l());
}

export const getAuthState = (): AuthState => state;

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const redirectUri = () => `${window.location.origin}/`;

async function loadConfig(): Promise<AppConfig | null> {
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as AppConfig;
  } catch {
    return null;
  }
}

async function getToken(forceRefresh = false): Promise<string | null> {
  if (!manager) return null;
  try {
    let user = await manager.getUser();
    if (user && (forceRefresh || user.expired)) user = await manager.signinSilent();
    return user?.access_token ?? null;
  } catch {
    return null;
  }
}

let started: Promise<void> | null = null;

/** Works out whether the user is signed in. Safe to call more than once. */
export function initAuth(): Promise<void> {
  started ??= (async () => {
    const config = await loadConfig();
    if (!config) return setState({ status: 'unavailable' });
    if (!config.auth) return setState({ status: 'local' });

    authConfig = config.auth;
    // Loaded only when a login is configured.
    const { UserManager, WebStorageStateStore } = await import('oidc-client-ts');
    manager = new UserManager({
      authority: config.auth.authority,
      client_id: config.auth.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email',
      // Stay signed in across visits. Refresh tokens are rotated by Cognito.
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      automaticSilentRenew: true,
    });
    configureApiAuth(getToken, () => setState({ status: 'signed-out', error: 'Your sign-in has expired.' }));
    manager.events.addUserSignedOut(() => setState({ status: 'signed-out' }));

    try {
      const params = new URLSearchParams(window.location.search);
      let user;
      if (params.has('code') && params.has('state')) {
        // Returning from the hosted login page.
        user = await manager.signinRedirectCallback();
        window.history.replaceState({}, '', window.location.pathname);
      } else {
        user = await manager.getUser();
        if (user?.expired) user = await manager.signinSilent().catch(() => null);
      }
      if (user && !user.expired) {
        setState({ status: 'signed-in', email: String(user.profile.email ?? 'your account') });
      } else {
        setState({ status: 'signed-out' });
      }
    } catch {
      window.history.replaceState({}, '', window.location.pathname);
      setState({ status: 'signed-out', error: 'Sign-in did not complete. Please try again.' });
    }
  })();
  return started;
}

export async function signIn(): Promise<void> {
  await manager?.signinRedirect();
}

export async function signOut(): Promise<void> {
  if (!manager || !authConfig) return;
  await manager.revokeTokens().catch(() => {});
  await manager.removeUser();
  // Cognito ends its own session at /logout and then returns to the app.
  const url = new URL('/logout', authConfig.domain);
  url.searchParams.set('client_id', authConfig.clientId);
  url.searchParams.set('logout_uri', redirectUri());
  window.location.assign(url);
}
