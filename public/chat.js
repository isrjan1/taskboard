/* Co-Work group chat — a floating dock in the bottom-right corner (Facebook style) with Discord-style content:
   channels, flat messages, a "who's online" member list. Drag the chat window and the member list pops out.
   Needs auth.js (api helper + theme). No websockets on Netlify, so it polls; the rates are in POLL below (each poll is one
   function call, so lower rates = lighter Netlify usage). */
(() => {
  if (window.__cw || /login\.html$/.test(location.pathname)) return;
  window.__cw = 1;

  const $ = s => root.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: just don't remember */ } },
  };
  const isMobile = () => matchMedia('(max-width:700px)').matches;
  const POLL = { open: 5000, minimized: 30000, hidden: 60000 };   // ms between polls: chat open · dock minimized · browser tab in the background
  const GROUPS = [['admin', 'Heads'], ['host', 'Supervisors'], ['staff', 'Staff']];

  /* ---------- state ---------- */
  const S = {
    open: LS.get('cw_open', false), ch: LS.get('cw_ch', 'general'), members: false,
    me: null, channels: [], msgs: [], rev: -1, loaded: false, online: [], offline: 0, seen: LS.get('cw_seen', {}),
    edit: null, pos: LS.get('cw_pos', null), lastType: 0, err: false,
    fresh: localStorage.getItem('cw_seen') === null,   // brand-new browser: existing messages start as "read"
  };
  let busy = false, fails = 0, timer = 0, sending = false, noteT = 0, drag = null, sigM = '', sigC = '';

  /* ---------- DOM ---------- */
  const root = document.createElement('div');
  root.className = 'cw';
  root.innerHTML = `
<button class="cw-pill" id="cwPill" type="button" aria-label="Open group chat"><span aria-hidden="true">💬</span><span>Group chat</span><span class="cw-live" id="cwLive" hidden></span><em class="cw-badge" id="cwBadge" hidden></em></button>
<section class="cw-win" id="cwWin" role="dialog" aria-label="Group chat" hidden>
  <header class="cw-head" id="cwHead" title="Drag to move · double-click to put it back">
    <div class="cw-title"><b id="cwTitle"># general</b><small id="cwSub">Connecting…</small></div>
    <button class="cw-ib" id="cwMem" type="button" aria-label="Who is online" aria-expanded="false" aria-controls="cwMembers" title="Who is online">👥</button>
    <button class="cw-ib" id="cwMin" type="button" aria-label="Minimize chat" title="Minimize">—</button>
  </header>
  <nav class="cw-chans" id="cwChans" aria-label="Channels"></nav>
  <div class="cw-log" id="cwLog" role="log" aria-live="polite" tabindex="0"></div>
  <div class="cw-typing" id="cwTyping" aria-live="polite"></div>
  <div class="cw-edit" id="cwEdit" hidden><span>✎ Editing your message</span><button type="button" id="cwEditX">Cancel</button></div>
  <form class="cw-form" id="cwForm"><textarea id="cwText" rows="1" maxlength="1000" placeholder="Message" aria-label="Message"></textarea><button class="btn pri cw-send" type="submit" aria-label="Send message">➤</button></form>
</section>
<aside class="cw-mem" id="cwMembers" aria-label="Online now" hidden></aside>`;
  document.body.append(root);
  document.body.classList.add('cw-on');
  const win = $('#cwWin'), mem = $('#cwMembers'), log = $('#cwLog'), ta = $('#cwText');

  /* ---------- helpers ---------- */
  const tf = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
  const df = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
  const dl = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
  const dayLabel = ts => { const k = df.format(ts); return k === df.format(Date.now()) ? 'Today' : k === df.format(Date.now() - 864e5) ? 'Yesterday' : dl.format(ts); };
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const link = t => esc(t).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

  function avatar(u) {
    const d = document.createElement('span');
    d.className = 'av sm';
    d.style.background = `hsl(${hue(u.id)} 52% 40%)`; d.style.color = '#fff';
    d.textContent = String(u.name || '?').trim().split(/\s+/).slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
    if (u.avatarAt) { const i = new Image(); i.alt = ''; i.onload = () => { d.textContent = ''; d.append(i); }; i.src = '/api/avatar/' + encodeURIComponent(u.id) + '?v=' + u.avatarAt; }
    return d;
  }
  function note(msg) {                       // short error line above the composer
    const t = $('#cwTyping'); t.textContent = msg; t.classList.add('err');
    clearTimeout(noteT); noteT = setTimeout(() => { t.classList.remove('err'); renderTyping(); }, 3500);
  }

  /* ---------- render ---------- */
  const unreadOf = c => (S.open && !document.hidden && c.id === S.ch) ? 0 : c.unread;
  function renderPill() {
    const n = S.channels.reduce((a, c) => a + unreadOf(c), 0), b = $('#cwBadge'), l = $('#cwLive');
    b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
    $('#cwPill').setAttribute('aria-label', 'Open group chat' + (n ? ', ' + n + ' unread' : ''));
    l.hidden = !S.me; l.innerHTML = `<i class="cw-dot"></i>${S.online.length}`; l.title = S.online.length + ' online';
  }
  function renderHead() {
    $('#cwTitle').textContent = '# ' + S.ch;
    $('#cwSub').innerHTML = S.err ? 'Reconnecting…' : S.me ? `<i class="cw-dot"></i>${S.online.length} online` : 'Connecting…';
    ta.placeholder = 'Message #' + S.ch;
  }
  function renderChans() {
    const sig = JSON.stringify([S.ch, S.me && S.me.role, S.channels.map(c => [c.id, unreadOf(c)])]);
    if (sig === sigC) return; sigC = sig;
    const admin = S.me && S.me.role === 'admin';
    $('#cwChans').innerHTML = S.channels.map(c => { const u = unreadOf(c);
      return `<button type="button" class="cw-ch${c.id === S.ch ? ' on' : ''}" data-ch="${esc(c.id)}" aria-pressed="${c.id === S.ch}"># ${esc(c.name)}${u ? `<em class="cw-badge">${u}</em>` : ''}</button>`; }).join('')
      + (admin ? '<button type="button" class="cw-ch ghost" data-a="add" title="Add a channel" aria-label="Add a channel">＋</button>' : '')
      + (admin && S.ch !== 'general' ? '<button type="button" class="cw-ch ghost" data-a="rm" title="Remove this channel" aria-label="Remove this channel">🗑</button>' : '');
  }
  function renderTyping() {
    const t = $('#cwTyping'); if (t.classList.contains('err')) return;
    const n = S.online.filter(u => u.typing).map(u => u.name.split(' ')[0]);
    t.textContent = !n.length ? '' : n.length === 1 ? n[0] + ' is typing…' : n.length === 2 ? n[0] + ' and ' + n[1] + ' are typing…' : 'Several people are typing…';
  }
  function renderLog(stick) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    let h = '', day = '', prev = null;
    if (!S.loaded) h = '<p class="cw-empty">Loading…</p>';
    else if (!S.msgs.length) h = `<p class="cw-empty"><b>Welcome to #${esc(S.ch)}</b>Nothing here yet. Say hi 👋</p>`;
    S.msgs.forEach((m, i) => {
      const d = df.format(m.ts);
      if (d !== day) { h += `<div class="cw-day"><span>${dayLabel(m.ts)}</span></div>`; day = d; prev = null; }
      const grp = prev && prev.uid === m.uid && m.ts - prev.ts < 3e5;
      h += `<div class="cw-msg${grp ? ' grp' : ''}${m.mine ? ' mine' : ''}" data-id="${esc(m.id)}" tabindex="0">`
        + (grp ? `<span class="cw-gt">${tf.format(m.ts)}</span>` : `<span class="cw-av" data-i="${i}"></span>`)
        + `<div class="cw-body">${grp ? '' : `<div class="cw-meta"><b class="cw-nm r-${esc(m.role)}">${esc(m.name)}</b><time>${tf.format(m.ts)}</time></div>`}`
        + `<div class="cw-tx">${link(m.text)}${m.edited ? '<i class="cw-ed">(edited)</i>' : ''}</div></div>`
        + (m.mine || m.canDel ? `<span class="cw-act">${m.mine ? '<button type="button" data-a="edit" title="Edit" aria-label="Edit message">✎</button>' : ''}${m.canDel ? '<button type="button" data-a="del" title="Delete" aria-label="Delete message">🗑</button>' : ''}</span>` : '')
        + '</div>';
      prev = m;
    });
    log.className = 'cw-log' + (S.msgs.length ? ' has' : '');
    log.innerHTML = h;
    log.querySelectorAll('.cw-av').forEach(el => el.replaceWith(avatar(S.msgs[el.dataset.i])));
    if (stick || near) log.scrollTop = log.scrollHeight;
  }
  function renderMembers() {
    const sig = JSON.stringify([S.me && S.me.id, S.online.map(u => [u.id, u.typing, u.avatarAt]), S.offline]);
    if (sig === sigM) return; sigM = sig;
    let h = `<div class="cw-mh"><b>Online now</b><button class="cw-ib" type="button" data-a="closem" aria-label="Close list" title="Close">×</button></div>`;
    h += `<h4>Online — ${S.online.length}</h4>`;
    if (!S.online.length) h += '<p class="cw-none">Nobody yet.</p>';
    const idx = [];
    GROUPS.forEach(([r, label]) => {
      const g = S.online.filter(u => u.role === r); if (!g.length) return;
      h += `<h4>${label} — ${g.length}</h4>`;
      g.forEach(u => { idx.push(u); h += `<div class="cw-row"><span class="cw-st" data-i="${idx.length - 1}"></span><b>${esc(u.name)}</b>${S.me && u.id === S.me.id ? '<span class="cw-you">you</span>' : ''}${u.typing ? '<span class="cw-dots" title="typing"><i></i><i></i><i></i></span>' : ''}</div>`; });
    });
    h += `<p class="cw-off">${S.offline} offline</p>`;
    mem.innerHTML = h;
    mem.querySelectorAll('.cw-st').forEach(el => el.append(avatar(idx[el.dataset.i])));
  }
  const renderAll = () => { renderPill(); renderHead(); renderChans(); renderTyping(); renderMembers(); };

  /* ---------- window: open / minimize / position ---------- */
  function applyPos() {
    if (!S.pos || isMobile()) { win.classList.remove('moved'); win.style.left = win.style.top = ''; return placeMembers(); }
    const r = win.getBoundingClientRect(), w = r.width || 340, h = r.height || 520;
    S.pos = { x: Math.min(Math.max(8, S.pos.x), Math.max(8, innerWidth - w - 8)), y: Math.min(Math.max(8, S.pos.y), Math.max(8, innerHeight - h - 8)) };
    win.classList.add('moved'); win.style.left = S.pos.x + 'px'; win.style.top = S.pos.y + 'px';
    placeMembers();
  }
  function placeMembers() {                  // the member list docks beside the chat window, on whichever side has room
    if (mem.hidden) return;
    if (isMobile()) { mem.style.left = mem.style.top = mem.style.height = ''; return; }
    const r = win.getBoundingClientRect(), w = mem.offsetWidth || 232;
    let x = r.left - w - 10;
    if (x < 8) x = r.right + 10;
    if (x + w > innerWidth - 8) x = Math.max(8, innerWidth - w - 8);
    mem.style.left = x + 'px'; mem.style.top = r.top + 'px'; mem.style.height = r.height + 'px';
  }
  function setMembers(on) {
    S.members = on; mem.hidden = !on; $('#cwMem').setAttribute('aria-expanded', on);
    if (on) { renderMembers(); placeMembers(); }
  }
  function setOpen(on, focus) {
    S.open = on; LS.set('cw_open', on);
    win.hidden = !on; $('#cwPill').hidden = on;
    if (!on) { setMembers(false); cancelEdit(); }
    else { applyPos(); if (focus && !isMobile()) ta.focus(); log.scrollTop = log.scrollHeight; }
    renderAll(); schedule(on ? 0 : undefined);
  }
  function setPos(x, y) { S.pos = { x, y }; applyPos(); }

  /* ---------- drag the window → the online list pops out ---------- */
  const head = $('#cwHead');
  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button') || isMobile()) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;      // a click is not a drag
      drag.moved = true; root.classList.add('dragging'); document.body.classList.add('cw-drag');
      setMembers(true);
    }
    setPos(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) LS.set('cw_pos', S.pos);
    root.classList.remove('dragging'); document.body.classList.remove('cw-drag'); drag = null;
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('dblclick', e => { if (e.target.closest('button')) return; S.pos = null; LS.set('cw_pos', null); applyPos(); });
  addEventListener('resize', applyPos);

  /* ---------- polling ---------- */
  const delay = () => fails ? Math.min(30000, 4000 * 2 ** Math.min(fails, 3)) : document.hidden ? POLL.hidden : S.open ? POLL.open : POLL.minimized;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms == null ? delay() : ms); }
  async function poll() {
    if (busy) return;
    busy = true; clearTimeout(timer);
    const q = new URLSearchParams();
    if (S.open) { q.set('ch', S.ch); q.set('rev', S.rev); }
    const seen = Object.entries(S.seen).map(([k, v]) => k + ':' + v).join(',');
    if (seen) q.set('seen', seen);
    if (S.open && Date.now() - S.lastType < 5000) q.set('typing', S.ch);
    try { const d = await api('/api/chat?' + q); fails = 0; S.err = false; apply(d); }
    catch (e) { if (e.status === 401) return location.replace('login.html'); fails++; S.err = true; renderHead(); }
    finally { busy = false; schedule(); }
  }
  function apply(d) {
    S.me = d.me; S.channels = d.channels; S.online = d.online; S.offline = d.offline;
    d.channels.forEach(c => { if (S.seen[c.id] == null) S.seen[c.id] = S.fresh ? c.last : 0; });   // new browser: all read · channel created later: everything in it is unread
    S.fresh = false;
    if (!d.channels.some(c => c.id === S.ch)) { S.ch = d.channels[0].id; S.rev = -1; S.msgs = []; S.loaded = false; LS.set('cw_ch', S.ch); }   // my channel was removed
    if (S.open && d.ch === S.ch && d.msgs) { S.msgs = d.msgs; S.rev = d.rev; S.loaded = true; renderLog(); }
    if (S.open && S.loaded && !document.hidden) {
      const c = d.channels.find(x => x.id === S.ch);
      if (c && S.seen[c.id] !== c.last) { S.seen[c.id] = c.last; }
    }
    LS.set('cw_seen', S.seen);
    renderAll();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAll(); schedule(0); } });

  /* ---------- actions ---------- */
  function switchTo(id) {
    if (id === S.ch) return;
    S.ch = id; LS.set('cw_ch', id); S.rev = -1; S.msgs = []; S.loaded = false; cancelEdit();
    sigC = ''; renderAll(); renderLog(true); schedule(0);
  }
  function cancelEdit() { S.edit = null; $('#cwEdit').hidden = true; if (ta.value && ta.dataset.edit) ta.value = ''; delete ta.dataset.edit; autosize(); }
  function startEdit(id) {
    const m = S.msgs.find(x => x.id === id); if (!m || !m.mine) return;
    S.edit = id; ta.dataset.edit = 1; ta.value = m.text; $('#cwEdit').hidden = false; autosize(); ta.focus();
  }
  async function send() {
    const text = ta.value.trim(); if (!text || sending) return;
    sending = true;
    try {
      if (S.edit) {
        const m = await api(`/api/chat/msg/${encodeURIComponent(S.edit)}?ch=${encodeURIComponent(S.ch)}`, 'PUT', { text });
        const i = S.msgs.findIndex(x => x.id === S.edit); if (i >= 0) S.msgs[i] = m;
        cancelEdit(); ta.value = '';
      } else {
        const ch = S.ch, m = await api('/api/chat/send', 'POST', { ch, text });
        if (ch === S.ch && !S.msgs.some(x => x.id === m.id)) S.msgs.push(m);   // a poll may already have brought it in
        ta.value = '';
      }
      autosize(); renderLog(true); schedule(1500);
    } catch (e) { if (e.status === 401) return location.replace('login.html'); note(e.message); }
    finally { sending = false; }
  }
  async function del(id) {
    if (!confirm('Delete this message for everyone?')) return;
    try { await api(`/api/chat/msg/${encodeURIComponent(id)}?ch=${encodeURIComponent(S.ch)}`, 'DELETE'); S.msgs = S.msgs.filter(x => x.id !== id); if (S.edit === id) cancelEdit(); renderLog(); schedule(1500); }
    catch (e) { note(e.message); }
  }
  async function addChannel() {
    const name = prompt('New channel name (letters, numbers, dashes):'); if (!name) return;
    try { const r = await api('/api/chat/channels', 'POST', { name }); switchTo(r.id); schedule(0); } catch (e) { note(e.message); }
  }
  async function rmChannel() {
    if (!confirm(`Remove #${S.ch} and all its messages for everyone?`)) return;
    const id = S.ch;
    try { await api('/api/chat/channels/' + encodeURIComponent(id), 'DELETE'); S.channels = S.channels.filter(c => c.id !== id); switchTo('general'); } catch (e) { note(e.message); }
  }
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 96) + 'px'; }

  /* ---------- events ---------- */
  $('#cwPill').onclick = () => setOpen(true, true);
  $('#cwMin').onclick = () => { setOpen(false); $('#cwPill').focus(); };
  $('#cwMem').onclick = () => setMembers(!S.members);
  mem.addEventListener('click', e => { if (e.target.closest('[data-a=closem]')) setMembers(false); });
  $('#cwChans').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ch) switchTo(b.dataset.ch); else if (b.dataset.a === 'add') addChannel(); else if (b.dataset.a === 'rm') rmChannel();
  });
  log.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'), row = e.target.closest('.cw-msg'); if (!b || !row) return;
    if (b.dataset.a === 'edit') startEdit(row.dataset.id); else if (b.dataset.a === 'del') del(row.dataset.id);
  });
  $('#cwEditX').onclick = () => { cancelEdit(); ta.value = ''; autosize(); ta.focus(); };
  $('#cwForm').onsubmit = e => { e.preventDefault(); send(); };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && S.edit) { e.stopPropagation(); cancelEdit(); ta.value = ''; autosize(); }
  });
  ta.addEventListener('input', () => {
    autosize();
    if (!S.edit && Date.now() - S.lastType > 3000) { S.lastType = Date.now(); poll(); } else S.lastType = Date.now();   // tell the others I'm typing (first keystroke right away, then with each poll)
  });
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (S.members) setMembers(false); else if (S.open) { setOpen(false); $('#cwPill').focus(); }
  });

  /* ---------- go ---------- */
  win.hidden = !S.open; $('#cwPill').hidden = S.open;
  if (S.open) applyPos();
  renderLog(); renderAll(); poll();
})();
