import { HttpHeaders } from '@angular/common/http';

/**
 * The headers of a generated client call, in whichever of the three forms the app passed them:
 * Angular's `HttpHeaders`, the Fetch `Headers`, or a plain record.
 */

/** `headers` with `added` set on top, in the form the app passed them. The input is not changed. */
export function withHeaders(headers: unknown, added: Readonly<Record<string, string>>): unknown {
  if (headers instanceof HttpHeaders) {
    let copy = headers;
    for (const [name, value] of Object.entries(added)) copy = copy.set(name, value);
    return copy;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const copy = new Headers(headers);
    for (const [name, value] of Object.entries(added)) copy.set(name, value);
    return copy;
  }
  const copy: Record<string, unknown> = { ...(headers as Record<string, unknown> | undefined) };
  for (const [name, value] of Object.entries(added)) {
    for (const existing of Object.keys(copy)) {
      if (existing !== name && existing.toLowerCase() === name.toLowerCase()) delete copy[existing];
    }
    copy[name] = value;
  }
  return copy;
}

/** The value of header `name`, matched without regard to case; undefined when it is not there. */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof HttpHeaders) return headers.get(name) ?? undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

/** `headers` as a plain record of strings, which survives a structured clone and JSON. */
export function headersRecord(headers: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers instanceof HttpHeaders) {
    for (const name of headers.keys()) {
      const value = headers.get(name);
      if (value !== null) record[name] = value;
    }
  } else if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => (record[name] = value));
  } else if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) record[name] = String(value);
    }
  }
  return record;
}
