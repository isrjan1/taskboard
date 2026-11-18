// Dependency-free smoke test for the API.  Run:  npm test
// Runs the real netlify/functions/api.mjs against an in-memory stand-in for Netlify Blobs.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOCK = `
const data = new Map(); let ver = 0;
export function getStore() { return {
  async get(k) { const r = data.get(k); return r ? structuredClone(r.v) : null; },
  async getWithMetadata(k) { const r = data.get(k); return r ? { data: structuredClone(r.v), etag: r.e } : null; },
  async setJSON(k, v, o = {}) { const r = data.get(k);
    if (o.onlyIfNew && r) return { modified: false };
    if (o.onlyIfMatch && (!r || r.e !== o.onlyIfMatch)) return { modified: false };
    data.set(k, { v: structuredClone(v), e: String(++ver) }); return { modified: true }; },
  async delete(k) { data.delete(k); } }; }`;

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-'));
fs.writeFileSync(path.join(tmp, 'blobs-mock.mjs'), MOCK);
fs.writeFileSync(path.join(tmp, 'api.mjs'), fs.readFileSync(path.join(here, '../netlify/functions/api.mjs'), 'utf8').replace("'@netlify/blobs'", "'./blobs-mock.mjs'"));
process.env.ADMIN_INITIAL_PASSWORD = 'test-password-123';
const handler = (await import(pathToFileURL(path.join(tmp, 'api.mjs')).href)).default;

// a "browser": own cookie jar, calls the API exactly like public/auth.js (JSON header always, body only if given)
const browser = () => {
  let jar = '';
  return async (p, method = 'GET', body, rawBody) => {
    const res = await handler(new Request('https://x.test/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}) }, body: rawBody ?? (body ? JSON.stringify(body) : undefined) }));
    const sc = res.headers.get('set-cookie');
    if (sc) { const [pair, ...a] = sc.split(/;\s*/); jar = a.some(x => /^Max-Age=0$/i.test(x)) ? '' : pair; }
    let d = {}; try { d = await res.json(); } catch {}
    return { status: res.status, d, cookie: jar };
  };
};

let failed = 0;
const check = (name, ok) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); if (!ok) failed++; };
const ADMIN = { username: 'admin', password: 'test-password-123' };

console.log('Login / logout');
const A = browser();
check('wrong password is rejected (401)', (await A('/login', 'POST', { username: 'admin', password: 'nope-nope-1' })).status === 401);
check('login works', (await A('/login', 'POST', ADMIN)).status === 200);
check('/me works when logged in', (await A('/me')).status === 200);
const oldCookie = (await A('/me')).cookie;
check('logout with no body works (the original auto-login bug)', (await A('/logout', 'POST')).status === 200);
check('/me is 401 after logout, so the login page will not auto-login', (await A('/me')).status === 401);
const replay = browser(); await replay('/me');   // fresh jar, then replay the OLD cookie
const r = await handler(new Request('https://x.test/api/me', { headers: { cookie: oldCookie } }));
check('the old session cookie is revoked server-side', r.status === 401);
check('logout still succeeds with no session at all', (await browser()('/logout', 'POST')).status === 200);
check('malformed JSON is still rejected (400)', (await browser()('/login', 'POST', null, '{not json')).status === 400);

console.log('Board: no silent overwrite between devices');
const D1 = browser(), D2 = browser();
await D1('/login', 'POST', ADMIN); await D2('/login', 'POST', ADMIN);
const b1 = await D1('/board', 'PUT', { theme: 'white', tasks: [], rev: 0 });
check('first save returns revision 1', b1.status === 200 && b1.d.rev === 1);
const b2 = await D2('/board', 'PUT', { theme: 'white', tasks: [{ id: 'x', title: 'from device 2', date: '2026-01-02' }], rev: 0 });
check('a stale device is refused (409) instead of overwriting', b2.status === 409);
check('...and the first device\'s data is intact', (await D2('/me')).d.board.rev === 1);
const b3 = await D1('/board', 'PUT', { theme: 'white', tasks: [], rev: 1 });
check('saving with the current revision works (rev 2)', b3.status === 200 && b3.d.rev === 2);
check('an older client that sends no revision still works', (await D1('/board', 'PUT', { theme: 'white', tasks: [] })).status === 200);

console.log('Passwords revoke other sessions');
const P1 = browser(), P2 = browser();
await P1('/login', 'POST', ADMIN); await P2('/login', 'POST', ADMIN);
check('changing password succeeds', (await P1('/change-password', 'POST', { currentPassword: ADMIN.password, newPassword: 'new-password-456' })).status === 200);
check('the device that changed it stays signed in', (await P1('/me')).status === 200);
check('every other device is signed out', (await P2('/me')).status === 401);
check('the old password no longer works', (await browser()('/login', 'POST', ADMIN)).status === 401);
const N = browser(); check('the new password works', (await N('/login', 'POST', { username: 'admin', password: 'new-password-456' })).status === 200);

console.log('Admin reset signs the user out; dates use Manila time');
const real = Date.now, fake = Date.parse('2026-01-01T17:00:00Z');   // 01:00 on 2 Jan in Manila, still 1 Jan in UTC
Date.now = () => fake;
await N('/users', 'POST', { username: 'staff1', name: 'Staff One', role: 'staff', password: 'temp-pass-1' });
Date.now = real;
const created = (await N('/users')).d.users.find(u => u.username === 'staff1');
check('records created after midnight in Manila get the Manila date', created.created === '2026-01-02');
const S = browser(); check('staff can log in', (await S('/login', 'POST', { username: 'staff1', password: 'temp-pass-1' })).status === 200);
await N('/users/' + created.id, 'PUT', { name: 'Staff One', role: 'staff', active: true, hostIds: [], password: 'reset-pass-2' });
check('admin password reset signs that user out everywhere', (await S('/me')).status === 401);
check('admin changing their own password via Users keeps their session', (await N('/users/u_admin', 'PUT', { name: 'Administrator', role: 'admin', active: true, password: 'admin-new-789' })).status === 200 && (await N('/me')).status === 200);

console.log('Heads (admins) never receive tasks');
await N('/users', 'POST', { username: 'head2', name: 'Second Head', role: 'admin', password: 'head-pass-2' });
await N('/users', 'POST', { username: 'sup1', name: 'Supervisor', role: 'host', password: 'sup-pass-12' });
const users = (await N('/users')).d.users, id = u => users.find(x => x.username === u).id;
await N('/users', 'POST', { username: 'staff2', name: 'Staff Two', role: 'staff', password: 'staff-pass-2', hostIds: [id('sup1')] });
const staff2 = (await N('/users')).d.users.find(x => x.username === 'staff2').id;
const task = a => ({ title: 'Do it', description: '', priority: 'Now', date: '2026-02-01', assignees: a });
const people = (await N('/people')).d.people.map(x => x.username);
check("the Head's 'assign to' list excludes every Head (including the default admin)", !people.includes('admin') && !people.includes('head2'));
check("...but still lists supervisors and staff", people.includes('sup1') && people.includes('staff2'));
check('a Head cannot assign a task to themselves', (await N('/shared', 'POST', task(['u_admin']))).status === 403);
check('a Head cannot assign a task to another Head', (await N('/shared', 'POST', task([id('head2')]))).status === 403);
check('a Head cannot assign to [staff + a Head] together', (await N('/shared', 'POST', task([staff2, id('head2')]))).status === 403);
const ok = await N('/shared', 'POST', task([staff2, id('sup1')]));
check('a Head can still assign to staff and supervisors', ok.status === 201);
check('a Head cannot add a Head to an existing task', (await N('/shared/' + ok.d.id, 'PUT', { assignees: [staff2, 'u_admin'] })).status === 403);
const H2 = browser(); await H2('/login', 'POST', { username: 'head2', password: 'head-pass-2' });
check('a NEW Head cannot assign a task to the default admin', (await H2('/shared', 'POST', task(['u_admin']))).status === 403);
check('a NEW Head cannot assign a task to themselves', (await H2('/shared', 'POST', task([id('head2')]))).status === 403);
check('a NEW Head can assign to staff', (await H2('/shared', 'POST', task([staff2]))).status === 201);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
