/** Types shared by the browser app (src/) and the backend (server/). */

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface QuizRequest {
  docTitle: string;
  sectionText: string;
  count: number;
}

export interface QuizResponse {
  questions: GeneratedQuestion[];
}

export type QuizErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'refusal'
  | 'invalid'
  | 'timeout'
  | 'api';

export interface ErrorResponse {
  error: string;
  kind?: QuizErrorKind;
}

/** The kinds of record that sync between devices. */
export const SYNC_STORES = ['docs', 'sections', 'questions', 'cards', 'reviews', 'progress'] as const;
export type SyncStore = (typeof SYNC_STORES)[number];

export interface SyncRecord {
  store: SyncStore;
  id: string;
  /** When the record was last changed on a device (ms). The newest change wins. */
  updatedAt: number;
  /** True when the record was deleted; `data` is then absent. */
  deleted?: boolean;
  data?: unknown;
}

export interface PushRequest {
  records: SyncRecord[];
}

export interface PushResponse {
  accepted: number;
}

export interface PullRequest {
  /** Cursor from the previous pull, or 0 for everything. */
  since: number;
  pageToken?: string;
}

export interface PullResponse {
  records: SyncRecord[];
  /** Present when there are more records to fetch for this pull. */
  nextPageToken?: string;
  /** Pass as `since` next time. */
  cursor: number;
}

/** Served at /config.json. Tells the app whether a login is required. */
export interface AppConfig {
  auth: null | {
    /** OIDC issuer, e.g. https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc */
    authority: string;
    clientId: string;
    /** Cognito hosted login domain, e.g. https://example.auth.us-east-1.amazoncognito.com */
    domain: string;
  };
}

/** Sent on every API request. Other websites cannot set it without a CORS preflight. */
export const API_HEADER = 'x-srq-client';

export const MAX_SECTION_CHARS = 60_000;
export const MAX_PUSH_RECORDS = 100;
