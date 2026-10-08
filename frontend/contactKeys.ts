// The keys contacts are matched on: phone numbers and email addresses in one
// spelling each. Shared by the Worker (finding an inquiry's contact, refusing
// duplicates) and the app (suggesting a saved contact while typing).
// Names are never matched: two people can share one.

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Where a number typed without a country code is from, when the organisation hasn't said. */
export const DEFAULT_COUNTRY = 'IN';

/**
 * "+91 98765 43210", "098765 43210" and "9876543210" (in India) are one
 * number: p:919876543210. A number without a country code is read as one
 * from `country`, the organisation's own (a two-letter code).
 */
export function phoneKey(raw: string | undefined | null, country: string = DEFAULT_COUNTRY): string | null {
  const parsed = parsePhoneNumberFromString((raw ?? '').trim(), (/^[A-Z]{2}$/.test(country) ? country : DEFAULT_COUNTRY) as CountryCode);
  return parsed?.isPossible() ? `p:${parsed.number.slice(1)}` : null;
}

export function emailKey(raw: string | undefined | null): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `e:${email}` : null;
}

/** Every key of these phones and emails, each once. */
export function contactKeys(phones: readonly string[], emails: readonly string[], country?: string): string[] {
  const keys = [...phones.map(p => phoneKey(p, country)), ...emails.map(emailKey)];
  return [...new Set(keys.filter((k): k is string => k !== null))];
}

/** Trimmed, blanks and repeats (by key) dropped, at most `max`. */
export function cleanList(values: unknown, keyOf: (v: string) => string | null, max = 10): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const value = v.trim().slice(0, 200);
    const key = keyOf(value) ?? value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, max);
}

/** Tag names are unique per organisation ignoring case and extra spaces. */
export const tagNameKey = (name: string): string => name.trim().replaceAll(/\s+/g, ' ').toLowerCase();

/** The contact in this list holding this phone or email key. */
export function contactWithKey<T extends { phone?: string; email?: string; phones?: string[]; emails?: string[] }>(
  list: readonly T[], key: string | null, country?: string,
): T | undefined {
  if (!key) return undefined;
  return list.find(c => contactKeys(c.phones ?? [c.phone ?? ''], c.emails ?? [c.email ?? ''], country).includes(key));
}
