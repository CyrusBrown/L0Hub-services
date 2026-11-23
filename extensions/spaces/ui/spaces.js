// The owner's Shared spaces page and the Inbox card for invitations and the assistant's requests.
// Everything here came from other members or the assistant: shown as text after escaping, never as HTML. Keys are never sent to the page.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => (t ? esc(String(t).slice(0, 16).replace('T', ' ')) : 'never');

const STYLE = `<style>
:host{display:block;font:14px var(--sans);color:var(--fg);max-width:820px}
h2{font:500 22px var(--serif);margin:0 0 12px}
h3{font:500 16px var(--serif);margin:18px 0 6px}
.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 8px}
button.row{display:block;width:100%;text-align:left;color:inherit;font:inherit;cursor:pointer}
button.row:hover{background:var(--hover)}
.meta{color:var(--muted);font-size:12px}
.note{background:var(--warnSoft);color:var(--warnInk);border-radius:8px;padding:8px 10px;margin:0 0 12px;font-size:12px}
.err{color:var(--badInk)} .ok{color:var(--okInk)}
.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
input{font:inherit;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--bg);color:var(--fg)}
button{font:inherit;cursor:pointer;border-radius:8px;padding:5px 11px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button.primary{background:var(--accent);color:var(--accentInk);border:0}
button.link{background:none;border:0;color:var(--accent);padding:0}
button.danger{color:var(--badInk)}
button:disabled{opacity:.5}
.mono{font-family:var(--mono);font-size:12px}
</style>`;

class SpacesPage extends HTMLElement {
  connectedCallback() {
    this.root = this.attachShadow({ mode: 'open' });
    this.view = { kind: 'list' };
    this.msg = '';
    this.off = this.l0w.on('spaces-changed', () => this.show());
    this.show();
  }
  disconnectedCallback() { this.off?.(); }

  async act(path, body, then) {
    try {
      await this.l0w.api(path, { method: 'POST', body });
      this.msg = '';
      if (then) then();
    } catch (e) { this.msg = e.message; }
    this.show();
  }

  async show() {
    const v = this.view;
    let html = '';
    try {
      const st = await this.l0w.api('/status');
      if (v.kind === 'list') html = this.list(st);
      else html = await this.detail(st, v.id);
    } catch (e) { html = `<p class="err">${esc(e.message)}</p>`; }
    this.root.innerHTML = STYLE + html;
    this.wire();
  }

  banner(st) {
    let out = '';
    if (!st.service) out += '<div class="note">No spaces service is connected on your hub (switch it on in Settings, Hub).</div>';
    if (this.msg) out += `<div class="note err">${esc(this.msg)}</div>`;
    return out + '<div class="note">Files and messages in a space come from other members: shown as plain text. Their files are untrusted, code included.</div>';
  }

  list(st) {
    const sp = st.spaces || [];
    const inv = sp.filter((s) => s.state === 'invited');
    const mine = sp.filter((s) => s.state !== 'invited');
    return `<h2>Shared spaces</h2>${this.banner(st)}` +
      (inv.length ? '<h3>Invitations</h3>' + inv.map((s) => `<div class="row"><b>${esc(s.name)}</b> <span class="meta">from ${esc(s.creator)}</span><div class="line"><button class="primary" data-accept="${esc(s.id)}">Accept</button><button data-decline="${esc(s.id)}">Decline</button></div></div>`).join('') : '') +
      '<h3>Your spaces</h3>' +
      (mine.map((s) => `<button class="row" data-open="${esc(s.id)}"><b>${esc(s.name)}</b> <span class="meta">${esc(s.state)} · ${esc(s.path)}/</span>
        <div class="meta">${s.members.length} members · version ${esc(s.seq)} · synced ${when(s.last_sync)}${s.syncing ? ' · syncing' : ''}</div>
        ${s.error ? `<div class="meta err">${esc(s.error)}</div>` : ''}${s.conflicts.length ? `<div class="meta err">${s.conflicts.length} file(s) in conflict</div>` : ''}</button>`).join('') || '<p class="meta">No spaces yet.</p>') +
      `<h3>New space</h3><div class="line"><input data-newname placeholder="name-like-a-slug" maxlength="40"><button class="primary" data-create ${st.service ? '' : 'disabled'}>Create</button></div>`;
  }

  async detail(st, id) {
    const s = await this.l0w.api(`/space?id=${encodeURIComponent(id)}`);
    const creator = st.me && s.creator === st.me;
    const canAct = creator;
    return `<p><button class="link" data-back>&larr; Spaces</button></p><h2>${esc(s.name)}</h2>${this.banner(st)}
      <div class="meta">Folder for your assistant: <span class="mono">${esc(s.path)}/</span> · creator ${esc(s.creator)} · epoch ${esc(s.epoch)} · version ${esc(s.seq)} · synced ${when(s.last_sync)}</div>
      ${s.error ? `<p class="err">${esc(s.error)}</p>` : ''}
      <div class="line"><button data-sync="${esc(s.id)}" ${s.state === 'member' ? '' : 'disabled'}>Sync now</button>
        ${creator ? `<button class="danger" data-delete="${esc(s.id)}">Delete space</button>` : `<button class="danger" data-leave="${esc(s.id)}">Leave</button>`}</div>
      ${s.conflicts.length ? `<h3>Conflicts</h3><div class="row err">${s.conflicts.map(esc).join('<br>')}<div class="meta">Both versions were kept; your assistant merges them by hand (copies are named "... (conflict ...)").</div></div>` : ''}
      <h3>Members</h3>${s.members.map((m) => `<div class="line"><span>${esc(m.address)}</span><span class="meta">${esc(m.state)}</span>${canAct && m.address !== s.creator ? `<button class="danger" data-remove="${esc(m.address)}" data-space="${esc(s.id)}">Remove</button>` : ''}</div>`).join('')}
      ${canAct ? `<div class="line"><input data-invite placeholder="name@hub.example"><button data-do-invite="${esc(s.id)}">Invite</button></div><div class="meta">Removing a member starts a new key epoch: what they already had, they keep.</div>` : ''}
      <h3>Locks</h3>${s.locks.length ? s.locks.map(([p, l]) => `<div class="line"><span class="mono">${esc(p)}</span><span class="meta">${esc(l.holder)} until ${when(l.expires)}${l.reason ? ' · ' + esc(l.reason) : ''}</span>${creator ? `<button data-break="${esc(l.tag)}" data-space="${esc(s.id)}">Break</button>` : ''}</div>`).join('') : '<p class="meta">No locks.</p>'}
      ${Object.keys(s.skipped || {}).length ? `<h3>Not synced</h3>${Object.entries(s.skipped).map(([p, w]) => `<div class="meta"><span class="mono">${esc(p)}</span> ${esc(w)}</div>`).join('')}` : ''}
      <h3>History</h3>${s.history.map((h) => `<div class="row"><b>version ${esc(h.seq)}</b> <span class="meta">${esc(h.author)} · ${when(h.at)} · ${esc(h.files)} files</span><div>${esc(h.message)}</div>${s.state === 'member' ? `<button data-restore="${esc(h.seq)}" data-space="${esc(s.id)}">Restore as a new version</button>` : ''}</div>`).join('') || '<p class="meta">No versions yet.</p>'}`;
  }

  wire() {
    const q = (sel, fn) => this.root.querySelectorAll(sel).forEach((b) => (b.onclick = () => fn(b)));
    q('[data-open]', (b) => { this.view = { kind: 'space', id: b.dataset.open }; this.show(); });
    q('[data-back]', () => { this.view = { kind: 'list' }; this.show(); });
    q('[data-accept]', (b) => this.act('/accept', { space: b.dataset.accept }));
    q('[data-decline]', (b) => this.act('/decline', { space: b.dataset.decline }));
    q('[data-create]', () => this.act('/create', { name: this.root.querySelector('[data-newname]').value }));
    q('[data-sync]', (b) => this.act('/sync', { space: b.dataset.sync }));
    q('[data-leave]', (b) => confirm('Leave this space? Its files stay in the folder but stop syncing.') && this.act('/leave', { space: b.dataset.leave }, () => (this.view = { kind: 'list' })));
    q('[data-delete]', (b) => confirm('Delete this space for everyone?') && this.act('/delete', { space: b.dataset.delete }, () => (this.view = { kind: 'list' })));
    q('[data-do-invite]', (b) => this.act('/invite', { space: b.dataset.doInvite, member: this.root.querySelector('[data-invite]').value }));
    q('[data-remove]', (b) => confirm(`Remove ${b.dataset.remove}? A new key epoch starts.`) && this.act('/remove', { space: b.dataset.space, member: b.dataset.remove }));
    q('[data-break]', (b) => this.act('/break-lock', { space: b.dataset.space, tag: b.dataset.break }));
    q('[data-restore]', (b) => confirm('Write that version\'s files as a new version?') && this.act('/restore', { space: b.dataset.space, seq: Number(b.dataset.restore) }));
  }
}
customElements.get('spaces-page') || customElements.define('spaces-page', SpacesPage);

class SpacesCard extends HTMLElement {
  set context(c) { this._c = c; this.draw(); }
  get context() { return this._c; }
  connectedCallback() { this.root ||= this.attachShadow({ mode: 'open' }); this.draw(); }
  draw() {
    if (!this.root || !this._c) return;
    const { card, resolve } = this._c;
    const d = card.data || {};
    const k = card.kind;
    const body = k === 'invite'
      ? `<b>${esc(d.creator)}</b> invites you to the shared space <b>${esc(d.name)}</b>. Its files will sync into your assistant's folder; they're other people's files, untrusted, code included.`
      : k === 'request-create'
        ? `Your assistant asks you to create the shared space <b>${esc(d.name)}</b>.${d.reason ? `<div class="meta">${esc(d.reason)}</div>` : ''}`
        : `Your assistant asks you to invite <b>${esc(d.member)}</b> to <b>${esc(d.name)}</b>.${d.reason ? `<div class="meta">${esc(d.reason)}</div>` : ''}`;
    const [yes, no] = k === 'invite' ? [['accept', 'Accept'], ['decline', 'Decline']] : [['approve', k === 'request-create' ? 'Create it' : 'Invite'], ['dismiss', 'No']];
    this.root.innerHTML = `${STYLE}<div>${body}<div class="line"><button class="primary" data-yes>${yes[1]}</button><button data-no>${no[1]}</button></div></div>`;
    this.root.querySelector('[data-yes]').onclick = () => resolve(yes[0], {});
    this.root.querySelector('[data-no]').onclick = () => resolve(no[0], {});
  }
}
customElements.get('spaces-card') || customElements.define('spaces-card', SpacesCard);
