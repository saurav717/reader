// The owner's routes on the proxy (/usage and the accounts beside it), asked
// as the owner: with the token named (a pass, or READER_TOKEN), and with the
// Google sign-in itself, so the Worker knows the owner by the email they sign
// in with even with no pass (ownerAuthorized in worker/index.js).

import { apiFetch } from './api';
import { liveAccessToken } from './google';

export function ownerFetch(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  // Named, since the token api.ts holds may be a render behind the one in Settings.
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  const google = liveAccessToken();
  if (google) headers['X-Google-Token'] = google;
  return apiFetch(path, { headers });
}
