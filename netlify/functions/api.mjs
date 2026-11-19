// Co-Work - Netlify Function API (routes: /api/*)
// Storage: Netlify Blobs. Sessions: HttpOnly cookie + revocable server-side session blob.
import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const H = (m, s = 400) => new HttpError(s, m);

const store = () => getStore({ name: 'taskboard', consistency: 'strong' });
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } });
const today = () => new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);   // Manila date (UTC+8), not the server's UTC date
const hp = (pw, salt) => scryptSync(pw, salt, 64).toString('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const uniq = a => [...new Set(Array.isArray(a) ? a.map(String) : [])];

const ROLES = ['admin', 'host', 'staff'];            // admin = head, host = supervisor, staff
const DEFAULT_ADMIN = 'u_admin';                       // only the original admin account may use the all-users overview
const PRIORITIES = ['Now', 'Next', 'Later'];
const THEMES = ['white', 'dark', 'pink', 'cepalco'];
const PALETTE = { Now: ['#cbfec9', '#ebd3ff', '#dfc3ff'], Next: ['#fff3a1', '#c3e2ff'], Later: ['#ffd1ea', '#cbfec9'] };
const UN = /^[a-z0-9_.-]{3,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const COOKIE = 'stb_sess', SESSION_MS = 30 * 864e5;
const AVATAR_COOLDOWN = 15 * 864e5, AVATAR_MAX = 250 * 1024;   // profile picture: one change per 15 days, <= 250 KB
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const CH_ID = /^[a-z0-9-]{1,24}$/, CHAT_MAX = 300, CHAT_SHOW = 80, MAX_CH = 6;   // group chat: channel slug, messages kept per channel, messages sent per poll, channel cap
const ONLINE_MS = 75e3, TYPING_MS = 7e3;                                          // "online" = polled in the last 75 s (a background tab polls every 60 s); "typing" = typed in the last 7 s
const ROLE_ORDER = { admin: 0, host: 1, staff: 2 };

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

const normUser = u => ({ ...u, role: ROLES.includes(u.role) ? u.role : 'staff', hostIds: Array.isArray(u.hostIds) ? u.hostIds : [], pv: Number.isInteger(u.pv) ? u.pv : 0 });

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
  avatarAt: u.avatarAt || 0, avatarNext: u.avatarAt ? u.avatarAt + AVATAR_COOLDOWN : 0,
  hostIds: u.role === 'staff' ? u.hostIds : [],
  hostNames: u.role === 'staff' ? u.hostIds.map(id => all.find(x => x.id === id)?.name).filter(Boolean) : [],
});
const activeAdmins = us => us.filter(u => u.role === 'admin' && u.active).length;

// ---------- permissions & DTOs ----------
const assignable = (me, us) =>
  me.role === 'admin' ? us.filter(u => u.active && u.role !== 'admin')   // Heads assign to Supervisors and Staff only: never to themselves or any other Head (incl. the default admin)
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

// ---------- group chat ----------
// Storage: chat:channels = [{id,name}] · chat:<channel> = { rev, msgs[] } (rev bumps on every send/edit/delete) · pres:<userId> = { t, ty } (heartbeat + typing)
const chanList = async st => (await st.get('chat:channels', { type: 'json' })) || [{ id: 'general', name: 'general' }];
const mutChat = (st, ch, fn) => mutate(st, 'chat:' + ch, () => ({ rev: 0, msgs: [] }), fn);
const chatMsg = (m, me, us) => {
  const u = us.find(x => x.id === m.uid);
  return { id: m.id, uid: m.uid, name: u ? (u.name || u.username) : 'Deleted user', role: u ? u.role : 'staff', avatarAt: u?.avatarAt || 0,
    text: m.text, ts: m.ts, edited: !!m.edited, mine: m.uid === me.id, canDel: m.uid === me.id || me.role === 'admin' };   // Heads can remove anyone's message; only the author can edit
};
const chatText = v => { const t = String(v ?? '').trim().slice(0, 1000); if (!t) throw H('Type a message first.'); return t; };
const parseSeen = q => Object.fromEntries(String(q || '').split(',').map(p => p.split(':')).filter(([k, v]) => CH_ID.test(k || '') && v !== '' && Number(v) >= 0).map(([k, v]) => [k, Number(v)]));

// ---------- handler ----------
export default async (req) => {
  try {
    const st = store();
    const path = new URL(req.url).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const m = req.method;
    let body = {};
    if (m === 'POST' || m === 'PUT') {
      if (!(req.headers.get('content-type') || '').includes('application/json')) throw H('JSON required', 415);
      const raw = await req.text();
      try { body = raw.trim() ? (JSON.parse(raw) || {}) : {}; } catch { throw H('Bad JSON'); }
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
      await st.setJSON('sess:' + token, { id: u.id, pv: u.pv, exp: now + SESSION_MS });
      return J({ user: pub(u, us) }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
    }

    // ----- session cookie -----
    const ck = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
    const token = ck ? ck.slice(COOKIE.length + 1) : '';

    // ----- logout (public on purpose: it must work even if the session already expired) -----
    if (path === '/logout' && m === 'POST') {
      if (/^[a-f0-9]{48}$/.test(token)) await st.delete('sess:' + token);
      return J({ ok: 1 }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    // ----- everything below needs a session -----
    const sess = /^[a-f0-9]{48}$/.test(token) ? await st.get('sess:' + token, { type: 'json' }) : null;
    if (!sess || sess.exp < Date.now()) throw H('Not logged in', 401);
    const us = await getUsers(st);
    const me = us.find(x => x.id === sess.id && x.active);
    if (!me || (sess.pv || 0) !== me.pv) throw H('Not logged in', 401);   // disabled user, or password changed/reset since this login

    if (path === '/me' && m === 'GET') return J({ user: { ...pub(me, us), overview: me.id === DEFAULT_ADMIN }, board: await st.get('board:' + me.id, { type: 'json' }) });

    if (path === '/change-password' && m === 'POST') {
      const cur = String(body.currentPassword || ''), next = String(body.newPassword || '');
      if (!same(me.hash, hp(cur, me.salt))) throw H('Current password is incorrect.', 401);
      if (next.length < 8) throw H('New password must be at least 8 characters.');
      let pv = 0;
      await mutUsers(st, list => { const u = list.find(x => x.id === me.id); u.salt = randomBytes(8).toString('hex'); u.hash = hp(next, u.salt); u.pv = (u.pv || 0) + 1; pv = u.pv; delete u.mustChange; });
      await st.setJSON('sess:' + token, { ...sess, pv });   // this device stays signed in; every other session is now invalid
      return J({ ok: 1 });
    }

    // ----- profile picture -----
    const am = path.match(/^\/avatar(?:\/([\w-]+))?$/);   // /avatar = mine, /avatar/<id> = a teammate's (shown in the group chat)
    if (am && m === 'GET') {
      const a = await st.get('avatar:' + (am[1] || me.id), { type: 'json' });
      if (!a) throw H('No profile picture', 404);
      return new Response(Buffer.from(a.b64, 'base64'), { status: 200, headers: { 'Content-Type': a.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path === '/avatar' && m === 'POST') {
      const mt = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(body.image || ''));
      if (!mt) throw H('Please choose a JPG, PNG or WebP image.');
      const buf = Buffer.from(mt[2], 'base64');
      if (buf.length > AVATAR_MAX) throw H('Picture is too large (max 250 KB after resizing).', 413);
      const magic = { 'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8, 'image/png': b => b.subarray(1, 4).toString() === 'PNG', 'image/webp': b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
      if (!magic[mt[1]](buf)) throw H('That file is not a valid image.');
      let at = 0;
      await mutUsers(st, async list => {
        const u = list.find(x => x.id === me.id);
        const wait = (u.avatarAt || 0) + AVATAR_COOLDOWN - Date.now();   // enforced here, not just in the browser
        if (u.avatarAt && wait > 0) throw H(`You can change your picture again in ${Math.ceil(wait / 864e5)} day(s).`, 429);
        await st.setJSON('avatar:' + me.id, { type: mt[1], b64: mt[2] });
        u.avatarAt = at = Date.now();
      });
      return J({ ok: 1, avatarAt: at, avatarNext: at + AVATAR_COOLDOWN });
    }

    // ----- group chat (floating dock) -----
    if (path === '/chat' && m === 'GET') {
      const q = new URL(req.url).searchParams, now = Date.now();
      const chans = await chanList(st);
      const ch = chans.find(c => c.id === q.get('ch'))?.id || null;
      const ty = chans.find(c => c.id === q.get('typing'))?.id || null;
      await st.setJSON('pres:' + me.id, { t: now, ty: ty ? { c: ty, t: now } : null });                 // heartbeat: one key per person, so polls never collide
      const people = us.filter(u => u.active);
      const pres = Object.fromEntries(await Promise.all(people.map(async u => [u.id, u.id === me.id ? { t: now, ty: ty ? { c: ty, t: now } : null } : await st.get('pres:' + u.id, { type: 'json' })])));
      const on = people.filter(u => pres[u.id] && now - pres[u.id].t < ONLINE_MS);
      const seen = parseSeen(q.get('seen')), unseen = q.get('seen') ? 0 : Infinity;   // no 'seen' at all = brand-new browser (nothing unread); a channel missing from a known list = created since, so all of it is unread
      let rev = 0, msgs;
      const channels = [];
      for (const c of chans) {
        const d = (await st.get('chat:' + c.id, { type: 'json' })) || { rev: 0, msgs: [] };
        channels.push({ id: c.id, name: c.name, last: d.msgs.at(-1)?.ts || 0, unread: Math.min(99, d.msgs.filter(x => x.uid !== me.id && x.ts > (seen[c.id] ?? unseen)).length) });
        if (c.id === ch) { rev = d.rev || 0; if (rev !== Number(q.get('rev'))) msgs = d.msgs.slice(-CHAT_SHOW).map(x => chatMsg(x, me, us)); }
      }
      const card = u => ({ id: u.id, name: u.name || u.username, role: u.role, avatarAt: u.avatarAt || 0 });
      return J({
        me: card(me), ch, rev, channels, ...(msgs ? { msgs } : {}),
        online: on.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.name || '').localeCompare(b.name || '')).map(u => ({ ...card(u), typing: u.id !== me.id && pres[u.id].ty?.c === ch && now - pres[u.id].ty.t < TYPING_MS })),
        offline: people.length - on.length,
      });
    }
    if (path === '/chat/send' && m === 'POST') {
      const ch = (await chanList(st)).find(c => c.id === body.ch)?.id;
      if (!ch) throw H('Channel not found', 404);
      const text = chatText(body.text);
      let msg;
      await mutChat(st, ch, d => {
        msg = { id: 'm_' + randomBytes(6).toString('hex'), uid: me.id, text, ts: Math.max(Date.now(), (d.msgs.at(-1)?.ts || 0) + 1) };   // ts is strictly increasing per channel
        d.msgs.push(msg); if (d.msgs.length > CHAT_MAX) d.msgs.splice(0, d.msgs.length - CHAT_MAX); d.rev = (d.rev || 0) + 1;
      });
      return J(chatMsg(msg, me, us), 201);
    }
    const cm = path.match(/^\/chat\/msg\/([\w-]+)$/);
    if (cm && (m === 'PUT' || m === 'DELETE')) {
      const ch = (await chanList(st)).find(c => c.id === new URL(req.url).searchParams.get('ch'))?.id;
      if (!ch) throw H('Channel not found', 404);
      const text = m === 'PUT' ? chatText(body.text) : '';
      const out = await mutChat(st, ch, d => {
        const i = d.msgs.findIndex(x => x.id === cm[1]), x = d.msgs[i];
        if (!x) throw H('Message not found', 404);
        if (m === 'DELETE') { if (x.uid !== me.id && me.role !== 'admin') throw H('You can only delete your own messages.', 403); d.msgs.splice(i, 1); d.rev = (d.rev || 0) + 1; return null; }
        if (x.uid !== me.id) throw H('You can only edit your own messages.', 403);
        x.text = text; x.edited = true; d.rev = (d.rev || 0) + 1; return x;
      });
      return out ? J(chatMsg(out, me, us)) : J({ ok: 1 });
    }
    if (path === '/chat/channels' && m === 'POST') {
      if (me.role !== 'admin') throw H('Only Heads can add channels.', 403);
      const id = String(body.name || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 24);
      if (!CH_ID.test(id)) throw H('Channel name: letters, numbers and dashes.');
      await mutate(st, 'chat:channels', () => [{ id: 'general', name: 'general' }], list => {
        if (list.some(c => c.id === id)) throw H('That channel already exists.');
        if (list.length >= MAX_CH) throw H(`You can have up to ${MAX_CH} channels.`);
        list.push({ id, name: id });
      });
      return J({ ok: 1, id }, 201);
    }
    const chm = path.match(/^\/chat\/channels\/([a-z0-9-]+)$/);
    if (chm && m === 'DELETE') {
      if (me.role !== 'admin') throw H('Only Heads can remove channels.', 403);
      if (chm[1] === 'general') throw H('The general channel cannot be removed.');
      await mutate(st, 'chat:channels', () => [{ id: 'general', name: 'general' }], list => {
        const i = list.findIndex(c => c.id === chm[1]);
        if (i < 0) throw H('Channel not found', 404);
        list.splice(i, 1);
      });
      await st.delete('chat:' + chm[1]);
      return J({ ok: 1 });
    }

    // ----- personal board -----
    if (path === '/board' && m === 'PUT') {
      if (!Array.isArray(body.tasks) || JSON.stringify(body).length > 1e6) throw H('Invalid board');
      const key = 'board:' + me.id, cur = await st.getWithMetadata(key, { type: 'json' }), curRev = cur?.data?.rev || 0;
      const stale = () => H('Changed on another device. Latest version loaded; please redo your last change.', 409);
      if (Number.isInteger(body.rev) && body.rev !== curRev) throw stale();
      const w = await st.setJSON(key, { ...cleanBoard(body), rev: curRev + 1 }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (w && w.modified === false) throw stale();
      return J({ ok: 1, rev: curRev + 1 });
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

    // ----- default admin only: read-only view of every user's personal sticky notes -----
    if (path === '/personal-all' && m === 'GET') {
      if (me.id !== DEFAULT_ADMIN) throw H('Not allowed', 403);
      const tasks = [];
      for (const u of us) { const b = await st.get('board:' + u.id, { type: 'json' }); for (const t of (b?.tasks || [])) tasks.push({ ...t, userId: u.id }); }
      const sh = (await st.get('shared', { type: 'json' })) || { tasks: [] };   // the admin can manage every shared task, so the DTO shows all of them (incl. trash)
      return J({ users: us.map(u => ({ id: u.id, name: u.name || u.username, username: u.username, role: u.role, active: u.active })), tasks, shared: sh.tasks.map(t => taskDTO(t, me, us)) });
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
        let selfPv = null;
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
            u.salt = randomBytes(8).toString('hex'); u.hash = hp(body.password, u.salt); u.pv = (u.pv || 0) + 1;
            if (u.id === me.id) { delete u.mustChange; selfPv = u.pv; } else u.mustChange = true;
          }
        });
        if (selfPv !== null) await st.setJSON('sess:' + token, { ...sess, pv: selfPv });   // admin changing their own password keeps this session
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
        await st.delete('avatar:' + id);
        await st.delete('pres:' + id);
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
