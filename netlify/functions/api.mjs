// Smart Calendar Task Board - Netlify Function API (routes: /api/*)
// Storage: Netlify Blobs. Sessions: HttpOnly cookie + revocable server-side session blob.
import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const H = (m, s = 400) => new HttpError(s, m);

const store = () => getStore({ name: 'taskboard', consistency: 'strong' });
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } });
const today = () => new Date().toISOString().slice(0, 10);
const hp = (pw, salt) => scryptSync(pw, salt, 64).toString('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const uniq = a => [...new Set(Array.isArray(a) ? a.map(String) : [])];

const ROLES = ['admin', 'host', 'staff'];            // admin = head, host = supervisor, staff
const PRIORITIES = ['Now', 'Next', 'Later'];
const THEMES = ['white', 'dark', 'pink', 'cepalco'];
const PALETTE = { Now: ['#cbfec9', '#ebd3ff', '#dfc3ff'], Next: ['#fff3a1', '#c3e2ff'], Later: ['#ffd1ea', '#cbfec9'] };
const UN = /^[a-z0-9_.-]{3,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const COOKIE = 'stb_sess', SESSION_MS = 30 * 864e5;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

// ---------- storage helpers ----------
// Read-modify-write with optimistic concurrency (retries if someone else wrote first).
async function mutate(st, key, init, fn) {
  for (let i = 0; i < 6; i++) {
    const r = await st.getWithMetadata(key, { type: 'json' });
    const data = r ? r.data : await init();
    const out = await fn(data);
    const w = await st.setJSON(key, data, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (w && w.modified === false) continue;
    return out;
  }
  throw H('Busy, please try again.', 409);
}

const normUser = u => ({ ...u, role: ROLES.includes(u.role) ? u.role : 'staff', hostIds: Array.isArray(u.hostIds) ? u.hostIds : [] });

async function usersInit() {
  const pw = process.env.ADMIN_INITIAL_PASSWORD;
  if (!pw || pw.length < 8) throw H('Setup needed: set the ADMIN_INITIAL_PASSWORD environment variable (8+ characters) in Netlify, then redeploy.', 500);
  const salt = randomBytes(8).toString('hex');
  return [{ id: 'u_admin', username: 'admin', name: 'Administrator', role: 'admin', active: true, salt, hash: hp(pw, salt), created: today(), hostIds: [] }];
}
async function getUsers(st) {
  let r = await st.getWithMetadata('users', { type: 'json' });
  if (!r) { await st.setJSON('users', await usersInit(), { onlyIfNew: true }); r = await st.getWithMetadata('users', { type: 'json' }); }
  return r.data.map(normUser);
}
const mutUsers = (st, fn) => mutate(st, 'users', usersInit, us => { us.forEach(u => Object.assign(u, normUser(u))); return fn(us); });
const mutShared = (st, fn) => mutate(st, 'shared', () => ({ tasks: [] }), fn);

const pub = (u, all) => ({
  id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, created: u.created, mustChange: !!u.mustChange,
  hostIds: u.role === 'staff' ? u.hostIds : [],
  hostNames: u.role === 'staff' ? u.hostIds.map(id => all.find(x => x.id === id)?.name).filter(Boolean) : [],
});
const activeAdmins = us => us.filter(u => u.role === 'admin' && u.active).length;

// ---------- permissions & DTOs ----------
const assignable = (me, us) =>
  me.role === 'admin' ? us.filter(u => u.active)
  : me.role === 'host' ? us.filter(u => u.active && u.role === 'staff' && u.hostIds.includes(me.id)) : [];
const hostsFor = (ids, us) => uniq(ids.flatMap(id => { const u = us.find(x => x.id === id); return u && u.role === 'staff' ? u.hostIds : []; }));
const canManage = (me, t) => me.role === 'admin' || (me.role === 'host' && (t.createdBy === me.id || t.hostIds.includes(me.id)));
const isMine = (me, t) => t.assignees.find(a => a.id === me.id);
const visible = (me, t) => canManage(me, t) || (isMine(me, t) && t.status === 'active');

function taskDTO(t, me, us) {
  const nm = id => us.find(u => u.id === id)?.name || 'Deleted user';
  const mine = isMine(me, t);
  return {
    id: t.id, title: t.title, description: t.description, priority: t.priority, date: t.date, status: t.status,
    pinned: !!t.pinned, color: t.color, created: t.created, createdBy: t.createdBy, createdByName: nm(t.createdBy),
    assignees: t.assignees.map(a => ({ id: a.id, name: nm(a.id), done: !!a.done, doneAt: a.doneAt || null })),
    complete: t.assignees.length > 0 && t.assignees.every(a => a.done),
    canManage: canManage(me, t), mine: !!mine, myDone: !!(mine && mine.done),
  };
}

function cleanFields(b, creating) {
  const o = {};
  if (creating || 'title' in b) { const v = String(b.title || '').trim().slice(0, 120); if (!v) throw H('Task title is required'); o.title = v; }
  if (creating || 'description' in b) o.description = String(b.description || '').trim().slice(0, 500);
  if (creating || 'priority' in b) { if (!PRIORITIES.includes(b.priority)) throw H('Invalid priority'); o.priority = b.priority; }
  if (creating || 'date' in b) { if (!DATE.test(String(b.date || ''))) throw H('Pick a valid date'); o.date = b.date; }
  if ('pinned' in b) o.pinned = !!b.pinned;
  return o;
}

function cleanBoard(b) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    theme: THEMES.includes(b.theme) ? b.theme : 'white',
    tasks: b.tasks.slice(0, 5000).map(t => ({
      id: s(t.id, 40), date: DATE.test(String(t.date)) ? t.date : today(), title: s(t.title, 120), description: s(t.description, 500),
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'Next', status: ['active', 'done', 'trash'].includes(t.status) ? t.status : 'active',
      pinned: !!t.pinned, favorite: !!t.favorite, color: COLOR.test(String(t.color)) ? t.color : '#fff3a1',
      created: s(t.created, 10), completed: s(t.completed, 10),
    })).filter(t => t.id && t.title),
  };
}

// ---------- handler ----------
export default async (req) => {
  try {
    const st = store();
    const path = new URL(req.url).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const m = req.method;
    let body = {};
    if (m === 'POST' || m === 'PUT') {
      if (!(req.headers.get('content-type') || '').includes('application/json')) throw H('JSON required', 415);
      try { body = (await req.json()) || {}; } catch { throw H('Bad JSON'); }
    }

    // ----- login (public) -----
    if (path === '/login' && m === 'POST') {
      const un = String(body.username || '').trim().toLowerCase(), pw = String(body.password || '');
      if (!un || !pw) throw H('Enter your username and password.');
      const fk = 'fail:' + (un.replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'x');
      const f = await st.get(fk, { type: 'json' });
      const now = Date.now();
      if (f && f.until > now) throw H('Too many failed attempts. Try again in 15 minutes.', 429);
      const us = await getUsers(st);
      const u = us.find(x => x.username === un);
      const ok = u ? (hp(pw, u.salt), u.active && same(u.hash, hp(pw, u.salt))) : (hp(pw, '00'), false);
      if (!ok) {
        const n = (f && !(f.until && f.until <= now) ? f.count : 0) + 1;
        await st.setJSON(fk, { count: n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
        await new Promise(r => setTimeout(r, 400));
        throw H('Wrong username or password, or account disabled.', 401);
      }
      if (f) await st.delete(fk);
      const token = randomBytes(24).toString('hex');
      await st.setJSON('sess:' + token, { id: u.id, exp: now + SESSION_MS });
      return J({ user: pub(u, us) }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
    }

    // ----- everything below needs a session -----
    const ck = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
    const token = ck ? ck.slice(COOKIE.length + 1) : '';
    const sess = /^[a-f0-9]{48}$/.test(token) ? await st.get('sess:' + token, { type: 'json' }) : null;
    if (!sess || sess.exp < Date.now()) throw H('Not logged in', 401);
    const us = await getUsers(st);
    const me = us.find(x => x.id === sess.id && x.active);
    if (!me) throw H('Not logged in', 401);

    if (path === '/logout' && m === 'POST') {
      await st.delete('sess:' + token);
      return J({ ok: 1 }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }
    if (path === '/me' && m === 'GET') return J({ user: pub(me, us), board: await st.get('board:' + me.id, { type: 'json' }) });

    if (path === '/change-password' && m === 'POST') {
      const cur = String(body.currentPassword || ''), next = String(body.newPassword || '');
      if (!same(me.hash, hp(cur, me.salt))) throw H('Current password is incorrect.', 401);
      if (next.length < 8) throw H('New password must be at least 8 characters.');
      await mutUsers(st, list => { const u = list.find(x => x.id === me.id); u.salt = randomBytes(8).toString('hex'); u.hash = hp(next, u.salt); delete u.mustChange; });
      return J({ ok: 1 });
    }

    // ----- personal board -----
    if (path === '/board' && m === 'PUT') {
      if (!Array.isArray(body.tasks) || JSON.stringify(body).length > 1e6) throw H('Invalid board');
      await st.setJSON('board:' + me.id, cleanBoard(body));
      return J({ ok: 1 });
    }

    // ----- people I can assign tasks to -----
    if (path === '/people' && m === 'GET') {
      return J({ people: assignable(me, us).map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role })) });
    }

    // ----- shared calendar -----
    if (path === '/shared' && m === 'GET') {
      const sh = (await st.get('shared', { type: 'json' })) || { tasks: [] };
      return J({ tasks: sh.tasks.filter(t => visible(me, t)).map(t => taskDTO(t, me, us)) });
    }
    if (path === '/shared' && m === 'POST') {
      if (me.role === 'staff') throw H('Only supervisors can assign tasks.', 403);
      const f = cleanFields(body, true);
      const ids = uniq(body.assignees);
      if (!ids.length) throw H('Pick at least one person to assign.');
      const ok = assignable(me, us).map(u => u.id);
      if (ids.some(i => !ok.includes(i))) throw H('You can only assign tasks to your own team.', 403);
      const pal = PALETTE[f.priority];
      const t = { id: 's_' + randomBytes(6).toString('hex'), ...f, pinned: !!body.pinned, status: 'active', color: pal[Math.floor(Math.random() * pal.length)],
        created: today(), createdBy: me.id, hostIds: me.role === 'host' ? [me.id] : hostsFor(ids, us), assignees: ids.map(id => ({ id, done: false, doneAt: null })) };
      await mutShared(st, sh => { sh.tasks.push(t); });
      return J(taskDTO(t, me, us), 201);
    }
    const sm = path.match(/^\/shared\/([\w-]+)$/);
    if (sm && (m === 'PUT' || m === 'DELETE')) {
      const out = await mutShared(st, sh => {
        const i = sh.tasks.findIndex(x => x.id === sm[1]);
        const t = sh.tasks[i];
        if (!t || !visible(me, t)) throw H('Task not found', 404);
        const manage = canManage(me, t), mine = isMine(me, t);

        if (m === 'DELETE') {
          if (!manage) throw H("You don't have permission to do that.", 403);
          if (t.status !== 'trash') throw H('Move the task to Trash first.');
          sh.tasks.splice(i, 1);
          return null;
        }
        if ('done' in body) {
          const v = !!body.done, stamp = v ? today() : null;
          if (body.all) { if (!manage) throw H("You don't have permission to do that.", 403); t.assignees.forEach(a => { a.done = v; a.doneAt = stamp; }); }
          else { if (!mine) throw H('This task is not assigned to you.', 403); mine.done = v; mine.doneAt = stamp; }
        }
        if (['title', 'description', 'priority', 'date', 'pinned', 'assignees', 'status'].some(k => k in body)) {
          if (!manage) throw H("You don't have permission to do that.", 403);
          Object.assign(t, cleanFields(body, false));
          if ('status' in body) { if (!['active', 'trash'].includes(body.status)) throw H('Invalid status'); t.status = body.status; }
          if ('assignees' in body) {
            const ids = uniq(body.assignees);
            if (!ids.length) throw H('Pick at least one person to assign.');
            const allowed = new Set([...assignable(me, us).map(u => u.id), ...t.assignees.map(a => a.id)]);
            if (ids.some(x => !allowed.has(x))) throw H('You can only assign tasks to your own team.', 403);
            t.assignees = ids.map(id => t.assignees.find(a => a.id === id) || { id, done: false, doneAt: null });
            if (me.role === 'admin') t.hostIds = hostsFor(ids, us);
          }
        }
        return t;
      });
      return out ? J(taskDTO(out, me, us)) : J({ ok: 1 });
    }

    // ----- admin only -----
    if (me.role !== 'admin') throw H('Admins only', 403);

    if (path === '/users' && m === 'GET') return J({ users: us.map(u => pub(u, us)) });
    if (path === '/users' && m === 'POST') {
      const un = String(body.username || '').trim().toLowerCase();
      if (!UN.test(un)) throw H('Username: 3–30 letters, numbers, . _ -');
      if (String(body.password || '').length < 6) throw H('Password must be at least 6 characters.');
      const role = ROLES.includes(body.role) ? body.role : 'staff';
      await mutUsers(st, list => {
        if (list.some(x => x.username === un)) throw H('Username already exists.');
        const salt = randomBytes(8).toString('hex');
        const hostIds = role === 'staff' ? uniq(body.hostIds).filter(id => list.some(h => h.id === id && h.role === 'host')) : [];
        list.push({ id: 'u_' + randomBytes(6).toString('hex'), username: un, name: String(body.name || '').trim().slice(0, 60) || un, role, active: body.active !== false, salt, hash: hp(body.password, salt), created: today(), hostIds, mustChange: true });
      });
      return J({ ok: 1 });
    }
    const um = path.match(/^\/users\/([\w-]+)$/);
    if (um) {
      const id = um[1];
      if (m === 'PUT') {
        await mutUsers(st, list => {
          const u = list.find(x => x.id === id);
          if (!u) throw H('User not found', 404);
          const role = ROLES.includes(body.role) ? body.role : u.role, active = body.active !== false;
          if (u.id === me.id && (!active || role !== 'admin')) throw H("You can't disable your own account or remove your own admin role.");
          if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && activeAdmins(list) < 2) throw H('Keep at least one active admin.');
          u.name = String(body.name || '').trim().slice(0, 60) || u.username; u.role = role; u.active = active;
          u.hostIds = role === 'staff' ? uniq(body.hostIds).filter(h => list.some(x => x.id === h && x.role === 'host')) : [];
          if (body.password) {
            if (String(body.password).length < 6) throw H('Password must be at least 6 characters.');
            u.salt = randomBytes(8).toString('hex'); u.hash = hp(body.password, u.salt);
            if (u.id === me.id) delete u.mustChange; else u.mustChange = true;
          }
        });
        return J({ ok: 1 });
      }
      if (m === 'DELETE') {
        if (id === me.id) throw H("You can't delete your own account.");
        await mutUsers(st, list => {
          const i = list.findIndex(x => x.id === id);
          if (i < 0) throw H('User not found', 404);
          if (list[i].role === 'admin' && list[i].active && activeAdmins(list) < 2) throw H('Keep at least one active admin.');
          list.splice(i, 1);
          list.forEach(u => { u.hostIds = u.hostIds.filter(h => h !== id); });
        });
        await st.delete('board:' + id);
        await mutShared(st, sh => sh.tasks.forEach(t => {
          t.assignees = t.assignees.filter(a => a.id !== id); t.hostIds = t.hostIds.filter(h => h !== id);
          if (!t.assignees.length) t.status = 'trash';
        }));
        return J({ ok: 1 });
      }
    }
    if (path === '/backup' && m === 'GET') {
      const boards = {};
      for (const u of us) { const b = await st.get('board:' + u.id, { type: 'json' }); if (b) boards[u.id] = b; }
      return J({ version: 4, exportedAt: new Date().toISOString(), users: us, boards, shared: (await st.get('shared', { type: 'json' })) || { tasks: [] } });
    }
    if (path === '/backup' && m === 'POST') {
      if (![3, 4].includes(body.version) || !Array.isArray(body.users)) throw H('Invalid backup file');
      const users = body.users.map(normUser);
      if (!users.some(u => u.role === 'admin' && u.active)) throw H('Backup must contain an active admin.');
      for (const u of us) await st.delete('board:' + u.id);
      await st.setJSON('users', users);
      for (const [id, b] of Object.entries(body.boards || {})) if (Array.isArray(b?.tasks)) await st.setJSON('board:' + String(id).replace(/[^\w-]/g, ''), cleanBoard(b));
      await st.setJSON('shared', { tasks: Array.isArray(body.shared?.tasks) ? body.shared.tasks : [] });
      return J({ ok: 1 });
    }
    throw H('Not found', 404);
  } catch (e) {
    if (e instanceof HttpError) return J({ error: e.message }, e.status);
    console.error(e);
    return J({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api/*' };
