export type User = { id: string; username: string; name: string; role: string; practitionerId: string | null; mfa: boolean };

export class ApiError extends Error {
  status: number;
  alerts?: any;
  constructor(status: number, message: string, alerts?: any) {
    super(message);
    this.status = status;
    this.alerts = alerts;
  }
}
export type Alert = { kind: string; severity: 'high' | 'moderate'; message: string };

export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'arogya', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    // Session ended (idle timeout, sign-out elsewhere, password change): the shell shows the sign-in screen.
    if (r.status === 401 && url !== '/api/login') dispatchEvent(new Event('arogya:signed-out'));
    if (r.status === 403 && data?.alerts?.mfaSetupRequired) dispatchEvent(new Event('arogya:mfa-required'));
    throw new ApiError(r.status, data?.issue?.[0]?.diagnostics ?? r.statusText, data?.alerts);
  }
  return data;
}
export const get = <T = any>(url: string, h?: Record<string, string>) => api<T>('GET', url, undefined, h);
export const post = <T = any>(url: string, body?: unknown, h?: Record<string, string>) => api<T>('POST', url, body ?? {}, h);

export const entries = (b: any): any[] => (b.entry ?? []).map((e: any) => e.resource);
export const fullName = (p: any) => p?.name?.[0]?.text ?? [p?.name?.[0]?.given?.join(' '), p?.name?.[0]?.family].filter(Boolean).join(' ');
export const label = (cc: any) => cc?.text ?? cc?.coding?.[0]?.display ?? cc?.coding?.[0]?.code ?? '';
export const age = (dob?: string) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / 31557600000) : '');
export const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');
export const time = (iso?: string) => (iso ? iso.slice(11, 16) : '');
export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
