/**
 * The contact address OpenAlex, Crossref and Unpaywall ask for.
 *
 * OpenAlex and Crossref both run a "polite pool" — give them a way to reach
 * you and your requests go to faster, more reliable infrastructure than the
 * anonymous one. Unpaywall simply refuses without it. It is set from Settings
 * rather than imported from the store so that the source modules stay free of
 * React.
 */
let email = '';

export function setContactEmail(value: string): void {
  email = (value || '').trim();
}

export function contactEmail(): string {
  return email;
}

/** Adds `mailto` to a query when we have one. Returns the same object. */
export function politely(params: URLSearchParams): URLSearchParams {
  if (email) params.set('mailto', email);
  return params;
}
