/**
 * kiosk — the clock-in kiosk's door into BizEazy, and the Hub's tools for it.
 *
 * Two kinds of caller:
 *  - A manager in the Hub (Supabase session token in Authorization), who
 *    registers, lists and revokes kiosks. A new kiosk's token is shown once;
 *    only its SHA-256 is stored.
 *  - A kiosk (its token in the x-device-token header), which pings, downloads
 *    the roster it enrols fingerprints against, and uploads scans.
 *
 * Scans are idempotent on (device, client_event_id): a kiosk that lost its
 * connection simply sends its queue again. Runs with the service key, so it
 * enforces company and role itself. Deployed with verify_jwt off because a
 * kiosk has no Supabase session.
 *
 * Kiosk requests: POST { action: 'ping' | 'roster' | 'events', events?: [...] }
 *   events: [{ client_event_id, employee_id, occurred_at (ISO, with offset),
 *              event_type?: 'in'|'out'|'scan', method?: 'fingerprint'|'face',
 *              clock_trusted?: boolean }]   (at most 500 per call)
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

class Refusal extends Error {}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Managers (from the Hub) ──────────────────────────────────────────────────

interface Manager { user_id: string; company_id: string }

async function signedInManager(req: Request): Promise<Manager> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = token ? await db.auth.getUser(token) : { data: { user: null }, error: null };
  if (error || !data.user) throw new Refusal('Your session has expired. Please sign in again.');
  const { data: me } = await db.from('hub_users').select('user_id, company_id, role, modules, active')
    .eq('user_id', data.user.id).maybeSingle();
  if (!me || !me.active) throw new Refusal('Your session has expired. Please sign in again.');
  if (me.role !== 'admin' && !(me.role === 'member' && (me.modules || []).includes('team'))) {
    throw new Refusal('Only managers can set up kiosks.');
  }
  return me as Manager;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function registerDevice(m: Manager, p: any) {
  const name = String(p.name ?? '').trim();
  if (!name) throw new Refusal('Give the kiosk a name, e.g. "A1 Bistro kitchen door".');
  // 32 characters from a 32-letter alphabet: 160 bits.
  const token = 'bzk_' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => ALPHABET[b % 32]).join('');
  const { data, error } = await db.from('attendance_devices').insert({
    company_id: m.company_id, name, branch: String(p.branch ?? '').trim(),
    token_hash: await sha256(token), created_by: m.user_id,
  }).select('id, name, branch').single();
  if (error) throw error;
  return { ...data, token };
}

async function listDevices(m: Manager) {
  const { data, error } = await db.from('attendance_devices')
    .select('id, name, branch, active, last_seen_at, created_at')
    .eq('company_id', m.company_id).order('created_at');
  if (error) throw error;
  return data;
}

async function revokeDevice(m: Manager, p: any) {
  const { data, error } = await db.from('attendance_devices').update({ active: false })
    .eq('company_id', m.company_id).eq('id', String(p.id ?? '')).select('id');
  if (error) throw error;
  if (!data?.length) throw new Refusal('That kiosk was not found.');
  return {};
}

// ── Kiosks ───────────────────────────────────────────────────────────────────

interface Device { id: string; company_id: string; name: string; branch: string }

async function device(req: Request): Promise<Device> {
  const token = (req.headers.get('x-device-token') || '').trim();
  if (!token) throw new Refusal('This kiosk is not registered.');
  const { data } = await db.from('attendance_devices').select('id, company_id, name, branch, active')
    .eq('token_hash', await sha256(token)).maybeSingle();
  if (!data || !data.active) throw new Refusal('This kiosk is not registered.');
  await db.from('attendance_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  return data as Device;
}

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);   // Malaysia date

/** Everyone still employed: no end date, or one that has not passed. */
async function roster(d: Device) {
  const { data, error } = await db.from('hub_records').select('id, data')
    .eq('company_id', d.company_id).eq('kind', 'employees');
  if (error) throw error;
  return (data || [])
    .filter(r => !r.data?.End_Date || String(r.data.End_Date).slice(0, 10) >= today())
    .map(r => ({
      employee_id: r.id,
      name: r.data?.Employee_Name || r.id,
      branch: r.data?.Branch_Location || '',
    }));
}

async function events(d: Device, p: any) {
  const list = Array.isArray(p.events) ? p.events : [];
  if (list.length > 500) throw new Refusal('Send at most 500 scans per call.');
  const known = new Set((await roster(d)).map(r => r.employee_id));
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const rejected: { client_event_id: string; reason: string }[] = [];

  for (const e of list) {
    const id = String(e?.client_event_id ?? '').trim();
    const at = Date.parse(String(e?.occurred_at ?? ''));
    const reason =
      !id ? 'missing client_event_id'
      : !known.has(String(e.employee_id)) ? 'unknown or former employee'
      : Number.isNaN(at) ? 'occurred_at is not a date'
      : at < now - 45 * 86400_000 ? 'older than 45 days'
      : null;
    if (reason) { rejected.push({ client_event_id: id, reason }); continue; }
    rows.push({
      company_id: d.company_id, device_id: d.id, client_event_id: id,
      employee_id: String(e.employee_id),
      event_type: ['in', 'out'].includes(e.event_type) ? e.event_type : 'scan',
      method: e.method === 'face' ? 'face' : 'fingerprint',
      occurred_at: new Date(at).toISOString(),
      // A scan dated in the future means the kiosk's clock is wrong, whatever it says.
      clock_trusted: e.clock_trusted !== false && at <= now + 10 * 60_000,
    });
  }

  if (rows.length) {
    const { error } = await db.from('attendance_events')
      .upsert(rows, { onConflict: 'company_id,device_id,client_event_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  // Accepted includes repeats of scans already stored: the kiosk may clear them.
  return { accepted: rows.map(r => r.client_event_id), rejected };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let p: any;
  try { p = await req.json(); } catch { return reply({ success: false, error: 'Bad request.' }); }

  try {
    switch (p?.action) {
      case 'registerDevice': return reply({ success: true, data: await registerDevice(await signedInManager(req), p) });
      case 'listDevices':    return reply({ success: true, data: await listDevices(await signedInManager(req)) });
      case 'revokeDevice':   return reply({ success: true, data: await revokeDevice(await signedInManager(req), p) });
      case 'ping': {
        const d = await device(req);
        return reply({ success: true, data: { server_time: new Date().toISOString(), name: d.name, branch: d.branch } });
      }
      case 'roster':         return reply({ success: true, data: await roster(await device(req)) });
      case 'events':         return reply({ success: true, data: await events(await device(req), p) });
      default:               return reply({ success: false, error: 'Unknown action.' });
    }
  } catch (err) {
    if (err instanceof Refusal) return reply({ success: false, error: err.message });
    console.error(p?.action, err);
    return reply({ success: false, error: 'Something went wrong on the server. Please try again.' });
  }
});
