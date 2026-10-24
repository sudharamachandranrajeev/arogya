export type User = { id: string; username: string; name: string; role: string; practitionerId: string | null };

export class ApiError extends Error {
  status: number;
  alerts?: Alert[];
  constructor(status: number, message: string, alerts?: Alert[]) {
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
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.issue?.[0]?.diagnostics ?? r.statusText, data?.alerts);
  return data;
}
export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown, h?: Record<string, string>) => api<T>('POST', url, body ?? {}, h);

export const entries = (b: any): any[] => (b.entry ?? []).map((e: any) => e.resource);
export const fullName = (p: any) => p?.name?.[0]?.text ?? [p?.name?.[0]?.given?.join(' '), p?.name?.[0]?.family].filter(Boolean).join(' ');
export const label = (cc: any) => cc?.text ?? cc?.coding?.[0]?.display ?? cc?.coding?.[0]?.code ?? '';
export const age = (dob?: string) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / 31557600000) : '');
export const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');
export const time = (iso?: string) => (iso ? iso.slice(11, 16) : '');
