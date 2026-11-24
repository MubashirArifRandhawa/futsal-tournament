// Admin panel: sign in, create tournaments (schedule by Gemini), edit squads,
// and run matches live. Every write goes straight to Firestore and the public
// site picks it up instantly through its snapshot listeners.
import { app, db, configured, doc, collection, getDoc, getDocs, updateDoc, writeBatch, runTransaction } from './firebase.js';
import {
  initializeAuth,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  start,
  subscribe,
  state,
  selectTournament,
  tournament,
  isReady,
  scoreOf,
  clockOf,
  computeStandings,
  playerName,
  lineupFor,
  teamLabel,
  playerIndex,
  POSITIONS,
  byKickoff,
} from './data.js';
import * as ui from './ui.js';
import { buildFallbackSchedule, cleanInput, FORMATS } from './scheduler.js';
import { SITE_NAME } from './firebase-config.js';

const { esc, crest, icon } = ui;

// Teams pre-filled in the "New tournament" form. Edit these to your own teams.
export const DEFAULT_TEAMS = [
  { name: 'Team 1', short: 'T1', color: '#e90052', color2: '#ffffff' },
  { name: 'Team 2', short: 'T2', color: '#0a84ff', color2: '#ffffff' },
  { name: 'Team 3', short: 'T3', color: '#00b25b', color2: '#ffffff' },
  { name: 'Team 4', short: 'T4', color: '#ffb400', color2: '#37003c' },
  { name: 'Team 5', short: 'T5', color: '#7b2cff', color2: '#ffffff' },
];
const EXTRA_COLORS = ['#ff6b00', '#00c2c7', '#d1006a', '#4a4a4a', '#8bc34a', '#3f51b5', '#a0522d'];

const $main = document.getElementById('admin');
const $user = document.getElementById('admin-user');
const auth = configured ? initializeAuth(app, { persistence: browserSessionPersistence }) : null;
let user = null;
let isAdmin = false;
let authChecked = false;
let dataStarted = false;

// ---------------- helpers ----------------
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const tRef = (tid) => doc(db, 'tournaments', tid);
const mRef = (tid, mid) => doc(db, 'tournaments', tid, 'matches', mid);
const teamRef = (tid, id) => doc(db, 'tournaments', tid, 'teams', id);
const toLocalInput = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);
const findMatch = (id) => state.matches.find((m) => m.id === id);

export function defaultPlayers() {
  const pos = ['GK', 'DEF', 'DEF', 'MID', 'FWD', 'GK', 'DEF', 'MID', 'MID', 'FWD'];
  return pos.map((p, i) => ({ id: rid(), number: i + 1, name: '', position: p, role: i < 5 ? 'starter' : 'sub', captain: false }));
}

async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) ui.toast(`<b>✓</b> ${esc(okMsg)}`, 'toast--ok');
    return r;
  } catch (e) {
    console.error(e);
    ui.toast(`<b>Error</b> ${esc(e.code === 'permission-denied' ? 'Permission denied: is this account in the admins collection?' : e.message || e)}`, 'toast--error');
    throw e;
  }
}

// ---------------- modal ----------------
function modal(title, body, { submit = 'Save', danger = false, wide = false, onSubmit, onMount } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<form class="modal ${wide ? 'modal--wide' : ''}" novalidate>
    <header><h3>${esc(title)}</h3><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="modal-body">${body}</div>
    <footer><button type="button" class="btn btn-ghost" data-close>Cancel</button>${
      submit ? `<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${esc(submit)}</button>` : ''
    }</footer></form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const keep = await onSubmit?.(form, close);
      if (keep !== false) close();
    } catch {
      /* toast already shown */
    } finally {
      btn.disabled = false;
    }
  });
  onMount?.(form, close);
  setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30);
  return { form, close };
}

const confirmBox = (title, text, okLabel = 'Confirm', danger = true) =>
  new Promise((resolve) => {
    let done = false;
    const { form } = modal(title, `<p>${text}</p>`, {
      submit: okLabel,
      danger,
      onSubmit: () => {
        done = true;
        resolve(true);
      },
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(form)) {
        obs.disconnect();
        if (!done) resolve(false);
      }
    });
    obs.observe(document.body, { childList: true });
  });

// ---------------- auth ----------------
if (configured) {
  onAuthStateChanged(auth, async (u) => {
    user = u;
    isAdmin = false;
    if (u) {
      try {
        isAdmin = (await getDoc(doc(db, 'admins', u.uid))).exists();
      } catch (e) {
        console.warn(e);
      }
      if (isAdmin && !dataStarted) {
        dataStarted = true;
        start();
      }
    }
    authChecked = true;
    $user.innerHTML = u
      ? `<span>${esc(u.email)}</span><button class="btn btn-ghost btn-sm" id="signout">Sign out</button>`
      : '';
    route();
  });
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'signout') signOut(auth);
});

// ---------------- router ----------------
let current = null;
function route() {
  current?.unmount?.();
  current = null;
  $main.innerHTML = '';
  if (!configured) return void ($main.innerHTML = `<div class="card setup"><h2>Firebase is not configured</h2><p>Paste your Firebase web config into <code>public/js/firebase-config.js</code>, then reload. See the README.</p></div>`);
  if (!authChecked) return void ($main.innerHTML = `<div class="loading"><div class="spinner"></div></div>`);
  if (!user) return mount(LoginView);
  if (!isAdmin) return mount(NotAdminView);
  const path = (location.hash || '#/').slice(1);
  let m;
  if ((m = path.match(/^\/t\/([\w-]+)\/match\/([\w-]+)$/))) return mount(MatchView, { tid: m[1], mid: m[2] });
  if ((m = path.match(/^\/t\/([\w-]+)\/team\/([\w-]+)$/))) return mount(TeamView, { tid: m[1], teamId: m[2] });
  if ((m = path.match(/^\/t\/([\w-]+)(?:\/(\w+))?$/))) return mount(ManageView, { tid: m[1], tab: m[2] || 'matches' });
  if (path === '/new') return mount(NewView);
  return mount(HomeView);
}
function mount(View, params = {}) {
  if (params.tid && state.tid !== params.tid) selectTournament(params.tid);
  // a fresh container per view, so old views' event listeners go away with it
  $main.innerHTML = '';
  const host = document.createElement('div');
  $main.appendChild(host);
  current = View(params);
  current.mount(host);
}
window.addEventListener('hashchange', route);
subscribe(() => current?.update?.());

setInterval(() => {
  const t = tournament();
  document.querySelectorAll('[data-mmss]').forEach((el) => {
    const m = findMatch(el.dataset.mmss);
    if (m) el.textContent = clockOf(m, t).mmss;
  });
  document.querySelectorAll('[data-clock]').forEach((el) => {
    const m = findMatch(el.dataset.clock);
    if (m) el.textContent = clockOf(m, t).label || 'LIVE';
  });
}, 1000);

// ---------------- views ----------------
function LoginView() {
  return {
    mount(el) {
      el.innerHTML = `<form class="card login" id="login">
        <div class="login-mark">${icon.ball}</div>
        <h2>Admin sign in</h2>
        <p class="muted">${esc(SITE_NAME)} control room</p>
        <label>Email<input type="email" name="email" required autocomplete="username"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
        <p class="err" id="login-err"></p>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <button class="linkbtn" type="button" id="forgot">Forgot password?</button>
      </form>`;
      const f = el.querySelector('#login');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = f.querySelector('#login-err');
        err.textContent = '';
        try {
          await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value);
        } catch (x) {
          err.textContent = x.code === 'auth/invalid-credential' ? 'Wrong email or password.' : x.message;
        }
      });
      f.querySelector('#forgot').addEventListener('click', async () => {
        const email = f.email.value.trim();
        if (!email) return (f.querySelector('#login-err').textContent = 'Type your email first.');
        await sendPasswordResetEmail(auth, email).catch(() => {});
        f.querySelector('#login-err').textContent = 'If that account exists, a reset email is on its way.';
      });
    },
  };
}

function NotAdminView() {
  return {
    mount(el) {
      el.innerHTML = `<div class="card setup">
        <h2>This account is not an admin yet</h2>
        <p>In the Firebase console open <b>Firestore Database</b>, create a collection called <code>admins</code>, and add a document whose <b>Document ID</b> is this UID (leave the fields empty or add <code>name</code>):</p>
        <p class="uid"><code id="uid">${esc(user.uid)}</code> <button class="btn btn-ghost btn-sm" id="copy">Copy</button></p>
        <p>Then reload this page.</p></div>`;
      el.querySelector('#copy').onclick = () => navigator.clipboard?.writeText(user.uid);
    },
  };
}

// ---------- tournaments list ----------
function HomeView() {
  let el;
  const render = () => {
    if (!state.loaded.tournaments) return (el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`);
    const active = state.config?.activeTournamentId;
    el.innerHTML = `
      <div class="pagehead row"><div><h1>Tournaments</h1><p>Create, schedule and run your futsal tournaments.</p></div>
      <a class="btn btn-primary" href="#/new">+ New tournament</a></div>
      ${
        state.tournaments.length
          ? `<div class="tlist">${state.tournaments
              .map(
                (t) => `<div class="card tcard">
            <div class="tcard-top"><span class="tchip tchip--${esc(t.status || 'draft')}">${esc({ draft: 'Not started', live: 'Live', completed: 'Completed' }[t.status || 'draft'])}</span>${
                  t.id === active ? '<span class="feat">★ Featured on site</span>' : ''
                }</div>
            <h3>${esc(t.name)}</h3>
            <p class="muted small">${esc(ui.fmtLongDay(t.startAt))}${t.venue ? ` · ${esc(t.venue)}` : ''}<br>${esc(t.teamCount || '?')} teams · ${esc(t.matchCount || '?')} matches · ${esc(t.matchMinutes)} min games</p>
            <div class="tcard-actions"><a class="btn btn-primary btn-sm" href="#/t/${esc(t.id)}">Manage</a>${
              t.id !== active ? `<button class="btn btn-ghost btn-sm" data-feature="${esc(t.id)}">Feature on site</button>` : ''
            }</div></div>`
              )
              .join('')}</div>`
          : ui.emptyState('No tournaments yet', '<a class="btn btn-primary" href="#/new">Create your first tournament</a>')
      }`;
  };
  return {
    mount(x) {
      el = x;
      render();
      el.addEventListener('click', (e) => {
        const f = e.target.closest('[data-feature]');
        if (f) guard(() => setActive(f.dataset.feature), 'Now featured on the public site');
      });
    },
    update: () => render(),
  };
}

const setActive = (id) => writeBatchSet(doc(db, 'config', 'site'), { activeTournamentId: id });
async function writeBatchSet(ref, data) {
  const b = writeBatch(db);
  b.set(ref, data, { merge: true });
  await b.commit();
}

// ---------- new tournament wizard ----------
function NewView() {
  let el;
  const startDefault = new Date();
  startDefault.setDate(startDefault.getDate() + 1);
  startDefault.setHours(16, 0, 0, 0);
  const w = {
    name: '',
    venue: '',
    startAt: toLocalInput(startDefault.getTime()),
    totalMinutes: 180,
    matchMinutes: '',
    halftimeMinutes: 2,
    breakMinutes: 5,
    courts: 1,
    format: 'league_final',
    feature: true,
    teams: DEFAULT_TEAMS.map((t) => ({ ...t })),
    plan: null,
    planSig: '',
    loading: false,
  };
  const sig = () => JSON.stringify([w.teams.length, w.format, w.totalMinutes, w.matchMinutes, w.halftimeMinutes, w.breakMinutes, w.courts]);
  const input = () =>
    cleanInput({
      teams: w.teams.map((t, i) => ({ key: `T${i + 1}`, name: t.name || `Team ${i + 1}` })),
      format: w.format,
      totalMinutes: w.totalMinutes,
      matchMinutes: w.matchMinutes || null,
      halftimeMinutes: w.halftimeMinutes,
      breakMinutes: w.breakMinutes,
      courts: w.courts,
      startAt: w.startAt,
    });

  function budgetLine() {
    const p = buildFallbackSchedule(input());
    const n = p.matches.length;
    return `<b>${n} matches</b> for ${w.teams.length} teams · about <b>${p.matchMinutes} min</b> per match (2 × ${p.matchMinutes / 2}) to fit in ${w.totalMinutes} min${
      p.warnings.length ? ` <span class="warn">${esc(p.warnings[0])}</span>` : ''
    }`;
  }

  function teamRows() {
    return w.teams
      .map(
        (t, i) => `<div class="team-row" data-i="${i}">
        ${crest({ ...t, short: t.short || t.name }, 34)}
        <input name="tname" value="${esc(t.name)}" placeholder="Team name" aria-label="Team ${i + 1} name" required>
        <input name="tshort" value="${esc(t.short)}" maxlength="3" placeholder="ABC" aria-label="Short name" class="w-short">
        <input type="color" name="tcolor" value="${esc(t.color)}" aria-label="Shirt colour" title="Shirt colour">
        <input type="color" name="tcolor2" value="${esc(t.color2)}" aria-label="Trim colour" title="Trim / number colour">
        <button type="button" class="iconbtn" data-remove-team="${i}" aria-label="Remove team" ${w.teams.length <= 2 ? 'disabled' : ''}>×</button>
      </div>`
      )
      .join('');
  }

  function planHtml() {
    if (w.loading) return `<div class="ai-loading"><div class="spinner"></div><p>Gemini is building your schedule…</p></div>`;
    if (!w.plan) return `<p class="muted">Fill in the details above, then generate the schedule. Gemini works out the match order, rest between games and match length that fit your total time.</p>`;
    const stale = w.planSig !== sig();
    const start = fromLocalInput(w.startAt) || Date.now();
    const p = w.plan;
    return `${stale ? '<p class="warnbox">Settings changed since this schedule was generated. Generate again before creating.</p>' : ''}
      <div class="plan-head"><span class="srcbadge ${p.source === 'gemini' ? 'srcbadge--ai' : ''}">${
        p.source === 'gemini' ? `✦ Generated by Gemini · ${esc(p.model)}` : 'Built-in scheduler'
      }</span><span>${p.matches.length} matches · ${p.matchMinutes} min each (2 × ${p.matchMinutes / 2}) · ${p.halftimeMinutes} min half-time · ${p.breakMinutes} min between · finishes ${ui.fmtTime(
      start + p.totalNeeded * 60000
    )}</span></div>
      ${p.summary ? `<p class="plan-summary">${esc(p.summary)}</p>` : ''}
      ${(p.warnings || []).map((x) => `<p class="warnbox">${esc(x)}</p>`).join('')}
      <div class="table-wrap"><table class="plan"><thead><tr><th>Time</th><th>Stage</th><th class="r">Home</th><th></th><th>Away</th>${w.courts > 1 ? '<th>Court</th>' : ''}</tr></thead><tbody>
      ${p.matches
        .map((m) => {
          const name = (k, label) => (k ? esc(w.teams[Number(k.slice(1)) - 1]?.name || k) : `<i>${esc(label)}</i>`);
          return `<tr><td>${ui.fmtTime(start + m.startOffsetMinutes * 60000)}</td><td>${m.stage === 'final' ? '<b>Final</b>' : `MD ${m.round}`}</td><td class="r">${name(m.home, m.homeLabel)}</td><td class="vs">v</td><td>${name(
            m.away,
            m.awayLabel
          )}</td>${w.courts > 1 ? `<td>${m.court}</td>` : ''}</tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  function render() {
    el.innerHTML = `
    <div class="pagehead"><a class="back back--dark" href="#/">← Tournaments</a><h1>New tournament</h1><p>5-a-side futsal · 5 starters + 5 substitutes per team</p></div>
    <form id="wiz" class="wiz" novalidate>
      <section class="card"><h4><span class="stepn">1</span>Details</h4>
        <div class="fgrid">
          <label class="span2">Tournament name<input name="name" value="${esc(w.name)}" placeholder="e.g. Winter Futsal Cup 2026" required></label>
          <label>Venue<input name="venue" value="${esc(w.venue)}" placeholder="Sports hall"></label>
          <label>Start date &amp; time<input type="datetime-local" name="startAt" value="${esc(w.startAt)}" required></label>
          <label>Total time available
            <span class="inline"><input type="number" name="totalMinutes" min="20" max="1440" step="5" value="${esc(w.totalMinutes)}"><em>min</em></span>
            <span class="presets">${[120, 180, 240, 300].map((v) => `<button type="button" class="chip chip--sm ${+w.totalMinutes === v ? 'active' : ''}" data-total="${v}">${v / 60} h</button>`).join('')}</span>
          </label>
          <label>Format<select name="format">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${w.format === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        </div>
        <details class="adv"><summary>Timing options</summary>
          <div class="fgrid">
            <label>Match length<span class="inline"><input type="number" name="matchMinutes" min="4" max="60" step="2" value="${esc(w.matchMinutes)}" placeholder="Auto"><em>min</em></span><small>Leave blank and Gemini picks the longest length that fits.</small></label>
            <label>Half-time<span class="inline"><input type="number" name="halftimeMinutes" min="0" max="15" value="${esc(w.halftimeMinutes)}"><em>min</em></span></label>
            <label>Break between matches<span class="inline"><input type="number" name="breakMinutes" min="0" max="60" value="${esc(w.breakMinutes)}"><em>min</em></span></label>
            <label>Courts<input type="number" name="courts" min="1" max="4" value="${esc(w.courts)}"></label>
          </div>
        </details>
        <p class="budget" id="budget">${budgetLine()}</p>
      </section>

      <section class="card"><h4><span class="stepn">2</span>Teams <small class="muted">(${w.teams.length})</small></h4>
        <div id="team-rows">${teamRows()}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="add-team" ${w.teams.length >= 16 ? 'disabled' : ''}>+ Add team</button>
        <p class="muted small">Players are added after creation, from each team's page (5 starters + 5 subs).</p>
      </section>

      <section class="card"><h4><span class="stepn">3</span>Schedule</h4>
        <div class="row gap">
          <button type="button" class="btn btn-ai" id="gen">✦ Generate with Gemini</button>
          <button type="button" class="btn btn-ghost" id="quick">Quick schedule (no AI)</button>
        </div>
        <div id="plan">${planHtml()}</div>
      </section>

      <div class="wiz-foot card">
        <label class="check"><input type="checkbox" name="feature" ${w.feature ? 'checked' : ''}> Feature this tournament on the public site</label>
        <button class="btn btn-primary" type="submit" id="create">Create tournament</button>
      </div>
    </form>`;
  }

  const refreshPlan = () => (el.querySelector('#plan').innerHTML = planHtml());

  async function generate(useAi) {
    const inp = input();
    w.loading = useAi;
    refreshPlan();
    let plan;
    if (useAi) {
      try {
        const token = await user.getIdToken();
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 30000);
        const res = await fetch('/api/generate-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(inp),
          signal: ctl.signal,
        });
        clearTimeout(to);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        plan = data;
      } catch (e) {
        plan = { ...buildFallbackSchedule(inp), source: 'fallback' };
        plan.warnings.unshift(`Could not reach the Gemini function (${e.name === 'AbortError' ? 'timed out' : e.message}). The built-in scheduler was used instead.`);
      }
    } else plan = { ...buildFallbackSchedule(inp), source: 'fallback' };
    w.plan = plan;
    w.planSig = sig();
    w.loading = false;
    refreshPlan();
  }

  async function create() {
    if (!w.name.trim()) return ui.toast('<b>!</b> Give the tournament a name.', 'toast--error');
    if (w.teams.some((t) => !t.name.trim())) return ui.toast('<b>!</b> Every team needs a name.', 'toast--error');
    if (!w.plan || w.planSig !== sig()) return ui.toast('<b>!</b> Generate the schedule first.', 'toast--error');
    const startMs = fromLocalInput(w.startAt);
    if (!startMs) return ui.toast('<b>!</b> Pick a start date and time.', 'toast--error');
    const btn = el.querySelector('#create');
    btn.disabled = true;
    try {
      const tref = doc(collection(db, 'tournaments'));
      const b = writeBatch(db);
      const keyToId = {};
      w.teams.forEach((t, i) => {
        const r = doc(collection(db, 'tournaments', tref.id, 'teams'));
        keyToId[`T${i + 1}`] = r.id;
        b.set(r, {
          name: t.name.trim(),
          short: (t.short || t.name).slice(0, 3).toUpperCase(),
          color: t.color,
          color2: t.color2,
          gkColor: '#1d1d1f',
          coach: '',
          logoUrl: '',
          order: i,
          players: defaultPlayers(),
        });
      });
      const p = w.plan;
      b.set(tref, {
        name: w.name.trim(),
        venue: w.venue.trim(),
        status: 'draft',
        startAt: startMs,
        totalMinutes: +w.totalMinutes,
        matchMinutes: p.matchMinutes,
        halftimeMinutes: p.halftimeMinutes,
        breakMinutes: p.breakMinutes,
        courts: +w.courts,
        format: w.format,
        teamCount: w.teams.length,
        matchCount: p.matches.length,
        schedule: { source: p.source, model: p.model || '', summary: p.summary || '' },
        createdAt: Date.now(),
      });
      p.matches.forEach((m) => {
        b.set(doc(collection(db, 'tournaments', tref.id, 'matches')), {
          round: m.round,
          slot: m.slot,
          court: m.court,
          stage: m.stage,
          homeId: m.home ? keyToId[m.home] : null,
          awayId: m.away ? keyToId[m.away] : null,
          homeLabel: m.homeLabel || '',
          awayLabel: m.awayLabel || '',
          kickoffAt: startMs + m.startOffsetMinutes * 60000,
          matchMinutes: p.matchMinutes,
          status: 'scheduled',
          period: 'pre',
          clock: { running: false, startedAt: null, elapsedMs: 0 },
          events: [],
          homeScore: 0,
          awayScore: 0,
          referee: '',
          lineups: null,
          shootout: null,
        });
      });
      if (w.feature) b.set(doc(db, 'config', 'site'), { activeTournamentId: tref.id }, { merge: true });
      await guard(() => b.commit(), 'Tournament created');
      location.hash = `#/t/${tref.id}/teams`;
    } catch {
      btn.disabled = false;
    }
  }

  return {
    mount(x) {
      el = x;
      render();
      el.addEventListener('input', (e) => {
        const t = e.target;
        const row = t.closest('.team-row');
        if (row) {
          const tm = w.teams[+row.dataset.i];
          if (t.name === 'tname') tm.name = t.value;
          if (t.name === 'tshort') tm.short = t.value.toUpperCase();
          if (t.name === 'tcolor') tm.color = t.value;
          if (t.name === 'tcolor2') tm.color2 = t.value;
          row.querySelector('.crest').outerHTML = crest({ ...tm, short: tm.short || tm.name }, 34);
          return;
        }
        if (t.name in w) {
          w[t.name] = t.type === 'checkbox' ? t.checked : t.value;
          if (t.name === 'totalMinutes') el.querySelectorAll('[data-total]').forEach((c) => c.classList.toggle('active', +c.dataset.total === +t.value));
          el.querySelector('#budget').innerHTML = budgetLine();
          if (w.plan) refreshPlan();
        }
      });
      el.addEventListener('change', (e) => {
        if (e.target.name === 'format' || e.target.name === 'feature') e.target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      el.addEventListener('click', (e) => {
        const tot = e.target.closest('[data-total]');
        if (tot) {
          const inp = el.querySelector('[name=totalMinutes]');
          inp.value = tot.dataset.total;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const rm = e.target.closest('[data-remove-team]');
        if (rm) {
          w.teams.splice(+rm.dataset.removeTeam, 1);
          el.querySelector('#team-rows').innerHTML = teamRows();
          el.querySelector('#budget').innerHTML = budgetLine();
          if (w.plan) refreshPlan();
        }
        if (e.target.id === 'add-team') {
          const i = w.teams.length;
          w.teams.push({ name: `Team ${i + 1}`, short: `T${i + 1}`, color: EXTRA_COLORS[(i - 5 + EXTRA_COLORS.length) % EXTRA_COLORS.length], color2: '#ffffff' });
          el.querySelector('#team-rows').innerHTML = teamRows();
          el.querySelector('#budget').innerHTML = budgetLine();
          if (w.plan) refreshPlan();
        }
        if (e.target.id === 'gen') generate(true);
        if (e.target.id === 'quick') generate(false);
      });
      el.querySelector('#wiz').addEventListener('submit', (e) => {
        e.preventDefault();
        create();
      });
    },
  };
}

// ---------- manage one tournament ----------
function ManageView({ tid, tab }) {
  let el;
  const render = () => {
    const t = tournament();
    if (!isReady() || state.tid !== tid) return (el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`);
    if (!t) return (el.innerHTML = ui.emptyState('Tournament not found', '<a href="#/">Back</a>'));
    const featured = state.config?.activeTournamentId === tid;
    const played = state.matches.filter((m) => m.status === 'ft').length;
    const tabs = [
      ['matches', `Matches (${state.matches.length})`],
      ['teams', `Teams &amp; squads (${state.teams.length})`],
      ['table', 'Table'],
    ]
      .map(([k, v]) => `<a class="seg ${tab === k ? 'active' : ''}" href="#/t/${esc(tid)}/${k}">${v}</a>`)
      .join('');
    let body = '';
    if (tab === 'teams') body = teamsTab();
    else if (tab === 'table') body = `<div class="card card--flush">${ui.standingsTable(computeStandings(), { qualify: t.format === 'league_final' ? 2 : 0 })}</div>`;
    else body = matchesTab(t);
    el.innerHTML = `
      <div class="pagehead row">
        <div><a class="back back--dark" href="#/">← Tournaments</a>
          <h1>${esc(t.name)}</h1>
          <p>${esc(ui.fmtLongDay(t.startAt))}${t.venue ? ` · ${esc(t.venue)}` : ''} · ${played}/${state.matches.length} played · ${esc(t.matchMinutes)} min matches${
      t.schedule?.source === 'gemini' ? ' · <span class="srcbadge srcbadge--ai">✦ Gemini schedule</span>' : ''
    }</p></div>
        <div class="row gap wrap">
          <span class="tchip tchip--${esc(t.status || 'draft')}">${esc({ draft: 'Not started', live: 'Live', completed: 'Completed' }[t.status || 'draft'])}</span>
          ${t.status === 'draft' || !t.status ? `<button class="btn btn-go" data-act="start">▶ Start tournament</button>` : ''}
          ${t.status === 'live' ? `<button class="btn btn-ghost" data-act="complete">Mark completed</button>` : ''}
          ${t.status === 'completed' ? `<button class="btn btn-ghost" data-act="reopen">Re-open</button>` : ''}
          ${featured ? '<span class="feat">★ Featured</span>' : `<button class="btn btn-ghost" data-act="feature">Feature on site</button>`}
          <button class="btn btn-ghost" data-act="edit">Edit details</button>
          <a class="btn btn-ghost" href="index.html" target="_blank" rel="noopener">View site ↗</a>
        </div>
      </div>
      <div class="segs">${tabs}</div>
      ${body}
      <div class="danger-zone"><button class="linkbtn danger" data-act="delete">Delete this tournament</button></div>`;
  };

  function matchesTab(t) {
    const rows = state.matches
      .slice()
      .sort(byKickoff)
      .map((m) => {
        const { h, a } = scoreOf(m);
        const status = m.status === 'live' ? ui.liveBadge(m, t) : m.status === 'ft' ? '<span class="ft-badge">FT</span>' : `<span class="muted">${ui.fmtTime(m.kickoffAt)}</span>`;
        return `<div class="arow ${m.status === 'live' ? 'arow--live' : ''}">
          <span class="arow-time">${ui.fmtTime(m.kickoffAt)}<small>${esc(ui.stageLabel(m))}${(t.courts || 1) > 1 ? ` · C${esc(m.court)}` : ''}</small></span>
          <span class="arow-teams"><span class="r">${esc(teamLabel(m, 'home'))} ${crest(state.teamMap[m.homeId], 22)}</span><b class="arow-score">${m.status === 'scheduled' ? 'v' : `${h} – ${a}`}</b><span>${crest(state.teamMap[m.awayId], 22)} ${esc(teamLabel(m, 'away'))}</span></span>
          <span class="arow-status">${status}</span>
          <span class="arow-ref">${icon.whistle} ${m.referee ? esc(m.referee) : '<span class="muted">No referee</span>'}</span>
          <span class="arow-actions"><button class="btn btn-ghost btn-sm" data-edit-match="${esc(m.id)}">Edit</button><a class="btn btn-primary btn-sm" href="#/t/${esc(tid)}/match/${esc(m.id)}">${
          m.status === 'live' ? 'Control ●' : m.status === 'ft' ? 'Open' : 'Run match'
        }</a></span></div>`;
      })
      .join('');
    return `<div class="row between"><p class="muted small">Tip: add referees here, then press <b>Run match</b> to go live.</p><button class="btn btn-ghost btn-sm" data-act="add-match">+ Add match</button></div>
      <div class="card card--flush alist">${rows || '<p class="pad muted">No matches.</p>'}</div>`;
  }

  function teamsTab() {
    return `<div class="teamgrid teamgrid--admin">${state.teams
      .map((x) => {
        const named = (x.players || []).filter((p) => p.name).length;
        return `<a class="teamcard" href="#/t/${esc(tid)}/team/${esc(x.id)}" style="--tc:${ui.teamColor(x)}"><span class="teamcard-band"></span>${crest(x, 60)}<b>${esc(x.name)}</b>
          <small>${named}/${(x.players || []).length} players named</small><span class="btn btn-primary btn-sm">Edit squad</span></a>`;
      })
      .join('')}</div>`;
  }

  async function act(a) {
    const t = tournament();
    if (a === 'start') {
      if (await confirmBox('Start tournament?', 'The public site will show this tournament as live. You can then run each match.', 'Start', false))
        await guard(() => updateDoc(tRef(tid), { status: 'live', startedAt: Date.now() }), 'Tournament is live');
    }
    if (a === 'complete') await guard(() => updateDoc(tRef(tid), { status: 'completed' }), 'Tournament completed');
    if (a === 'reopen') await guard(() => updateDoc(tRef(tid), { status: 'live' }));
    if (a === 'feature') await guard(() => setActive(tid), 'Featured on the public site');
    if (a === 'edit') editTournament(t);
    if (a === 'add-match') editMatch(null);
    if (a === 'delete') {
      if (!(await confirmBox('Delete tournament?', `This permanently removes <b>${esc(t.name)}</b>, its teams, squads and all match data.`, 'Delete forever'))) return;
      await guard(async () => {
        const [ts, ms] = await Promise.all([getDocs(collection(db, 'tournaments', tid, 'teams')), getDocs(collection(db, 'tournaments', tid, 'matches'))]);
        const b = writeBatch(db);
        ts.docs.concat(ms.docs).forEach((d) => b.delete(d.ref));
        b.delete(tRef(tid));
        if (state.config?.activeTournamentId === tid) b.set(doc(db, 'config', 'site'), { activeTournamentId: null }, { merge: true });
        await b.commit();
      }, 'Tournament deleted');
      location.hash = '#/';
    }
  }

  return {
    mount(x) {
      el = x;
      render();
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-act]');
        if (a) act(a.dataset.act);
        const em = e.target.closest('[data-edit-match]');
        if (em) editMatch(findMatch(em.dataset.editMatch));
      });
    },
    update: render,
  };
}

function editTournament(t) {
  modal(
    'Edit tournament',
    `<div class="fgrid">
      <label class="span2">Name<input name="name" value="${esc(t.name)}" required></label>
      <label>Venue<input name="venue" value="${esc(t.venue || '')}"></label>
      <label>Start<input type="datetime-local" name="startAt" value="${esc(toLocalInput(t.startAt))}"></label>
      <label>Status<select name="status">${['draft', 'live', 'completed'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${{ draft: 'Not started', live: 'Live', completed: 'Completed' }[s]}</option>`).join('')}</select></label>
      <label>Courts<input type="number" name="courts" min="1" max="4" value="${esc(t.courts || 1)}"></label>
    </div><p class="muted small">Changing the start time here does not move match kick-off times; edit those per match.</p>`,
    {
      onSubmit: (f) =>
        guard(
          () =>
            updateDoc(tRef(t.id), {
              name: f.name.value.trim() || t.name,
              venue: f.venue.value.trim(),
              startAt: fromLocalInput(f.startAt.value) || t.startAt,
              status: f.status.value,
              courts: +f.courts.value || 1,
            }),
          'Saved'
        ),
    }
  );
}

/** Edit (or add when m is null) a match's details: referee, kick-off, teams. */
function editMatch(m) {
  const t = tournament();
  const tid = state.tid;
  const isNew = !m;
  m ||= { stage: 'league', round: Math.max(0, ...state.matches.map((x) => x.round || 0)) || 1, court: 1, kickoffAt: Math.max(t.startAt || 0, ...state.matches.map((x) => x.kickoffAt || 0)) + ((t.matchMinutes || 20) + (t.halftimeMinutes || 0) + (t.breakMinutes || 0)) * 60000 };
  const teamOpts = (sel) => `<option value="">— TBD —</option>` + state.teams.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const knockout = m.stage === 'final';
  modal(
    isNew ? 'Add match' : `Edit match · ${teamLabel(m, 'home')} v ${teamLabel(m, 'away')}`,
    `<div class="fgrid">
      <label class="span2">Referee<input name="referee" value="${esc(m.referee || '')}" placeholder="Referee's name"></label>
      <label>Kick-off<input type="datetime-local" name="kickoffAt" value="${esc(toLocalInput(m.kickoffAt))}" required></label>
      <label>Match length<span class="inline"><input type="number" name="matchMinutes" min="4" max="90" step="2" value="${esc(m.matchMinutes || t.matchMinutes || 20)}"><em>min</em></span></label>
      <label>Home team<select name="homeId">${teamOpts(m.homeId)}</select></label>
      <label>Away team<select name="awayId">${teamOpts(m.awayId)}</select></label>
      <label>Stage<select name="stage"><option value="league" ${m.stage !== 'final' ? 'selected' : ''}>League</option><option value="final" ${m.stage === 'final' ? 'selected' : ''}>Final</option></select></label>
      <label>Matchday<input type="number" name="round" min="1" value="${esc(m.round || 1)}"></label>
      ${(t.courts || 1) > 1 ? `<label>Court<input type="number" name="court" min="1" max="${t.courts}" value="${esc(m.court || 1)}"></label>` : ''}
      ${
        knockout
          ? `<label>Penalties (home)<input type="number" name="penH" min="0" value="${esc(m.shootout?.home ?? '')}"></label><label>Penalties (away)<input type="number" name="penA" min="0" value="${esc(m.shootout?.away ?? '')}"></label>
             <div class="span2"><button type="button" class="btn btn-ghost btn-sm" id="finalists">Fill with 1st &amp; 2nd from the table</button></div>`
          : ''
      }
    </div>`,
    {
      onMount: (f) => {
        f.querySelector('#finalists')?.addEventListener('click', () => {
          const s = computeStandings();
          if (s[0]) f.homeId.value = s[0].team.id;
          if (s[1]) f.awayId.value = s[1].team.id;
        });
      },
      onSubmit: async (f) => {
        if (f.homeId.value && f.homeId.value === f.awayId.value) {
          ui.toast('<b>!</b> Home and away must be different teams.', 'toast--error');
          return false;
        }
        const data = {
          referee: f.referee.value.trim(),
          kickoffAt: fromLocalInput(f.kickoffAt.value) || m.kickoffAt,
          matchMinutes: +f.matchMinutes.value || t.matchMinutes,
          homeId: f.homeId.value || null,
          awayId: f.awayId.value || null,
          stage: f.stage.value,
          round: +f.round.value || 1,
          court: f.court ? +f.court.value || 1 : m.court || 1,
        };
        if (f.penH) data.shootout = f.penH.value === '' && f.penA.value === '' ? null : { home: +f.penH.value || 0, away: +f.penA.value || 0 };
        if (isNew) {
          const b = writeBatch(db);
          b.set(doc(collection(db, 'tournaments', tid, 'matches')), {
            ...data,
            slot: state.matches.length + 1,
            homeLabel: data.stage === 'final' ? '1st place' : '',
            awayLabel: data.stage === 'final' ? '2nd place' : '',
            status: 'scheduled',
            period: 'pre',
            clock: { running: false, startedAt: null, elapsedMs: 0 },
            events: [],
            homeScore: 0,
            awayScore: 0,
            lineups: null,
            shootout: null,
          });
          b.update(tRef(tid), { matchCount: state.matches.length + 1 });
          await guard(() => b.commit(), 'Match added');
        } else await guard(() => updateDoc(mRef(tid, m.id), data), 'Match saved');
      },
    }
  );
}

// ---------- team / squad editor ----------
function TeamView({ tid, teamId }) {
  let el;
  let mounted = false;
  let draft = null;
  let swapFrom = null;

  const row = (p, i) => `<div class="prow ${swapFrom === i ? 'swapping' : ''}" data-i="${i}">
      <input type="number" class="w-num" name="number" value="${esc(p.number ?? '')}" min="0" max="99" aria-label="Shirt number">
      <input name="pname" value="${esc(p.name || '')}" placeholder="Player name" aria-label="Player name">
      <select name="position" aria-label="Position">${POSITIONS.map((x) => `<option ${p.position === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label class="cap-radio" title="Captain"><input type="radio" name="captain" value="${i}" ${p.captain ? 'checked' : ''}><span>C</span></label>
      <button type="button" class="iconbtn" data-swap="${i}" title="${i < 5 ? 'Swap with a substitute' : 'Swap with a starter'}" aria-label="Swap">⇅</button>
    </div>`;

  function rowsHtml() {
    return `<h5>Starting five</h5>${draft.players.slice(0, 5).map((p, i) => row(p, i)).join('')}
      <h5>Substitutes</h5>${draft.players.slice(5).map((p, i) => row(p, i + 5)).join('')}`;
  }
  const preview = () => {
    const team = { ...draft, players: draft.players.map((p, i) => ({ ...p, role: i < 5 ? 'starter' : 'sub' })) };
    el.querySelector('#preview').innerHTML = ui.teamPitch(team) + ui.subsList(team, team.players);
    el.querySelector('#crest-prev').innerHTML = crest(draft, 64);
  };

  function mountForm() {
    const team = state.teamMap[teamId];
    if (!team) return (el.innerHTML = ui.emptyState('Team not found', `<a href="#/t/${esc(tid)}/teams">Back</a>`));
    const players = (team.players || []).slice();
    const starters = players.filter((p) => p.role !== 'sub').slice(0, 5);
    const subs = players.filter((p) => !starters.includes(p));
    const ordered = [...starters, ...subs];
    while (ordered.length < 10) ordered.push({ id: rid(), number: ordered.length + 1, name: '', position: 'MID', captain: false });
    draft = { ...team, players: ordered.map((p) => ({ ...p })) };
    mounted = true;
    el.innerHTML = `
      <div class="pagehead"><a class="back back--dark" href="#/t/${esc(tid)}/teams">← ${esc(tournament()?.name || 'Tournament')}</a><h1>Edit team</h1></div>
      <form id="teamform" class="team-edit">
        <div class="team-edit-form">
          <section class="card"><h4>Team</h4>
            <div class="team-id"><span id="crest-prev">${crest(draft, 64)}</span>
              <div class="fgrid">
                <label class="span2">Name<input name="name" value="${esc(draft.name)}" required></label>
                <label>Short name<input name="short" value="${esc(draft.short || '')}" maxlength="3"></label>
                <label>Coach<input name="coach" value="${esc(draft.coach || '')}" placeholder="Optional"></label>
                <label>Shirt<input type="color" name="color" value="${esc(ui.teamColor(draft))}"></label>
                <label>Trim<input type="color" name="color2" value="${esc(ui.teamColor2(draft))}"></label>
                <label>GK shirt<input type="color" name="gkColor" value="${esc(draft.gkColor || '#1d1d1f')}"></label>
                <label class="span2">Logo URL <small>(optional, https)</small><input name="logoUrl" value="${esc(draft.logoUrl || '')}" placeholder="https://…/logo.png"></label>
              </div></div>
          </section>
          <section class="card"><h4>Squad <small class="muted">· tap ⇅ on two rows to swap them</small></h4>
            <div class="prow prow--head"><span>No.</span><span>Name</span><span>Pos</span><span>C</span><span></span></div>
            <div id="prows">${rowsHtml()}</div>
            <details class="adv"><summary>Paste player list</summary>
              <p class="muted small">One player per line, e.g. <code>10 Ali Khan FWD</code>. The first 5 lines are starters, the next 5 substitutes.</p>
              <textarea id="paste" rows="6" placeholder="1 Hamza GK&#10;4 Bilal DEF&#10;…"></textarea>
              <button type="button" class="btn btn-ghost btn-sm" id="apply-paste">Apply</button>
            </details>
          </section>
          <div class="sticky-save card"><span class="muted small" id="dirty"></span><button class="btn btn-primary" type="submit">Save team</button></div>
        </div>
        <div class="team-edit-preview"><div class="card"><h4>Team sheet preview</h4><div id="preview"></div></div></div>
      </form>`;
    preview();
  }

  const setDirty = (txt = 'Unsaved changes') => {
    const d = el.querySelector('#dirty');
    if (d) d.textContent = txt;
  };

  return {
    mount(x) {
      el = x;
      if (isReady() && state.tid === tid) mountForm();
      else el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
      el.addEventListener('input', (e) => {
        if (!draft) return;
        const t = e.target;
        const r = t.closest('.prow');
        if (r) {
          const p = draft.players[+r.dataset.i];
          if (t.name === 'number') p.number = t.value === '' ? '' : +t.value;
          if (t.name === 'pname') p.name = t.value;
          if (t.name === 'position') p.position = t.value;
          if (t.name === 'captain') draft.players.forEach((q, i) => (q.captain = i === +t.value));
        } else if (['name', 'short', 'coach', 'color', 'color2', 'gkColor', 'logoUrl'].includes(t.name)) {
          draft[t.name] = t.name === 'short' ? t.value.toUpperCase() : t.value;
        } else return;
        setDirty();
        preview();
      });
      el.addEventListener('change', (e) => e.target.matches('select,[type=radio]') && e.target.dispatchEvent(new Event('input', { bubbles: true })));
      el.addEventListener('click', (e) => {
        const s = e.target.closest('[data-swap]');
        if (s) {
          const i = +s.dataset.swap;
          if (swapFrom === null) swapFrom = i;
          else if (swapFrom === i) swapFrom = null;
          else {
            const ps = draft.players;
            [ps[swapFrom], ps[i]] = [ps[i], ps[swapFrom]];
            swapFrom = null;
            setDirty();
          }
          el.querySelector('#prows').innerHTML = rowsHtml();
          preview();
        }
        if (e.target.id === 'apply-paste') {
          const lines = el.querySelector('#paste').value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);
          lines.forEach((l, i) => {
            const m = l.match(/^(\d{1,2})?[\s.,-]*(.*?)(?:[\s,-]+(GK|DEF|MID|FWD))?$/i);
            const p = draft.players[i];
            if (m[1]) p.number = +m[1];
            p.name = (m[2] || '').trim();
            if (m[3]) p.position = m[3].toUpperCase();
          });
          el.querySelector('#prows').innerHTML = rowsHtml();
          setDirty();
          preview();
        }
      });
      el.addEventListener('submit', (e) => {
        e.preventDefault();
        const players = draft.players.map((p, i) => ({
          id: p.id || rid(),
          number: p.number === '' || p.number == null ? i + 1 : +p.number,
          name: (p.name || '').trim(),
          position: POSITIONS.includes(p.position) ? p.position : 'MID',
          role: i < 5 ? 'starter' : 'sub',
          captain: !!p.captain,
        }));
        const nums = players.map((p) => p.number);
        if (new Set(nums).size !== nums.length) ui.toast('<b>Note</b> Two players share a shirt number.', '');
        guard(
          () =>
            updateDoc(teamRef(tid, teamId), {
              name: draft.name.trim() || 'Team',
              short: (draft.short || draft.name).slice(0, 3).toUpperCase(),
              coach: (draft.coach || '').trim(),
              color: draft.color,
              color2: draft.color2,
              gkColor: draft.gkColor || '#1d1d1f',
              logoUrl: /^https:\/\//.test(draft.logoUrl || '') ? draft.logoUrl.trim() : '',
              players,
            }),
          'Team saved'
        ).then(() => setDirty(''));
      });
    },
    update() {
      if (!mounted && isReady() && state.tid === tid) mountForm();
    },
  };
}

// ---------- live match control ----------
function MatchView({ tid, mid }) {
  let el;
  let mounted = false;

  const half = (m, t) => ((m.matchMinutes || t.matchMinutes || 20) / 2) * 60000;

  function board(m, t) {
    const H = state.teamMap[m.homeId];
    const A = state.teamMap[m.awayId];
    const { h, a } = scoreOf(m);
    const c = clockOf(m, t);
    const periodLabel = { pre: 'Not started', '1H': '1st half', HT: 'Half-time', '2H': '2nd half', FT: 'Full time' }[m.period || 'pre'];
    return `<section class="mc mc--admin" style="--hc:${ui.teamColor(H)};--ac:${ui.teamColor(A)}">
      <div class="mc-stage">${esc(ui.stageLabel(m))} · ${esc(ui.fmtTime(m.kickoffAt))}${m.referee ? ` · ${icon.whistle} ${esc(m.referee)}` : ''}</div>
      <div class="mc-row">
        <div class="mc-team">${crest(H, 64)}<b>${esc(teamLabel(m, 'home'))}</b></div>
        <div class="mc-mid"><div class="mc-score">${h}<i>–</i>${a}</div>
          <div class="bigclock ${c.running ? 'running' : ''}" data-mmss="${esc(m.id)}">${c.mmss}</div>
          <div class="period">${esc(periodLabel)}${m.status === 'live' && !c.running && m.period !== 'HT' ? ' · <b>paused</b>' : ''}</div></div>
        <div class="mc-team">${crest(A, 64)}<b>${esc(teamLabel(m, 'away'))}</b></div>
      </div></section>`;
  }

  function controls(m) {
    const c = m.clock || {};
    const b = (act, label, cls = 'btn-ghost') => `<button class="btn ${cls}" data-ctl="${act}">${label}</button>`;
    let main = '';
    if (m.status === 'scheduled') main = b('kickoff', '▶ Kick off', 'btn-go btn-lg');
    else if (m.period === '1H') main = (c.running ? b('pause', '❚❚ Pause clock') : b('resume', '▶ Resume clock', 'btn-go')) + b('ht', 'Half-time', 'btn-primary');
    else if (m.period === 'HT') main = b('2h', '▶ Start 2nd half', 'btn-go btn-lg');
    else if (m.period === '2H') main = (c.running ? b('pause', '❚❚ Pause clock') : b('resume', '▶ Resume clock', 'btn-go')) + b('ft', 'Full time', 'btn-primary');
    else if (m.status === 'ft') main = b('reopen', 'Re-open match');
    const adj = m.status === 'live' ? `<div class="row gap small-gap"><span class="muted small">Clock</span>${b('m60', '−1 min', 'btn-ghost btn-sm')}${b('m10', '−10 s', 'btn-ghost btn-sm')}${b('p10', '+10 s', 'btn-ghost btn-sm')}${b('p60', '+1 min', 'btn-ghost btn-sm')}</div>` : '';
    return `<h4>Match control</h4><div class="row gap wrap">${main}</div>${adj}
      <div class="row gap wrap ctl-secondary">${b('details', `${icon.whistle} Referee &amp; details`, 'btn-ghost btn-sm')}${m.status !== 'scheduled' ? b('reset', 'Reset match', 'btn-ghost btn-sm danger') : ''}</div>`;
  }

  function quick(m) {
    const side = (s) => {
      const team = state.teamMap[s === 'home' ? m.homeId : m.awayId];
      if (!team) return `<div class="qside"><p class="muted">Pick the ${s} team in “Referee &amp; details” first.</p></div>`;
      const q = (type, label, ic) => `<button class="qbtn qbtn--${type}" data-ev="${type}" data-side="${s}" ${m.status === 'scheduled' ? 'disabled' : ''}>${ic}<span>${label}</span></button>`;
      return `<div class="qside" style="--tc:${ui.teamColor(team)}"><div class="qhead">${crest(team, 26)}<b>${esc(team.name)}</b></div>
        <div class="qgrid">${q('goal', 'Goal', icon.ball)}${q('yellow', 'Yellow', icon.yellow)}${q('red', 'Red', icon.red)}${q('sub', 'Sub', icon.subOn)}${q('own_goal', 'Own goal', `<span class="og">${icon.ball}</span>`)}</div></div>`;
    };
    return `<h4>Add event</h4>${m.status === 'scheduled' ? '<p class="muted small">Kick off to start recording goals, cards and subs.</p>' : ''}<div class="qsides">${side('home')}${side('away')}</div>`;
  }

  function eventsList(m) {
    const idx = playerIndex();
    const evs = (m.events || []).slice().sort((x, y) => (y.minute || 0) - (x.minute || 0) || (y.at || 0) - (x.at || 0));
    if (!evs.length) return `<h4>Events</h4><p class="muted small">No events yet.</p>`;
    return `<h4>Events</h4><ul class="evlist">${evs
      .map((e) => {
        const team = state.teamMap[e.teamId];
        const who =
          e.type === 'sub'
            ? `${esc(playerName(idx[e.playerId]))} <small>for ${esc(playerName(idx[e.playerOutId]))}</small>`
            : e.playerId
            ? esc(playerName(idx[e.playerId]))
            : '<span class="muted">No player</span>';
        const extra = e.type === 'goal' && e.assistId ? ` <small>assist ${esc(playerName(idx[e.assistId]))}</small>` : '';
        return `<li><span class="evmin">${esc(e.minute)}'</span>${ui.eventIcon(e.type)}<span class="evwho">${who}${extra}${e.pen ? ' <small>(pen)</small>' : ''}${e.type === 'own_goal' ? ' <small>(OG)</small>' : ''}</span><span class="evteam">${ui.shortName(
          team
        )}</span><button class="iconbtn" data-del-ev="${esc(e.id)}" aria-label="Delete event">×</button></li>`;
      })
      .join('')}</ul>`;
  }

  function lineups(m) {
    const H = state.teamMap[m.homeId];
    const A = state.teamMap[m.awayId];
    return `<div class="row between"><h4>Line-ups</h4>${
      m.lineups ? '<button class="btn btn-ghost btn-sm" data-ctl="relineup">Refresh from squads</button>' : '<span class="muted small">Saved at kick-off from the squads</span>'
    }</div>${ui.matchPitch(m)}<div class="lineup-subs">${ui.subsList(A, lineupFor(m, 'away'), m, `${teamLabel(m, 'away')} subs`)}${ui.subsList(H, lineupFor(m, 'home'), m, `${teamLabel(m, 'home')} subs`)}</div>
      <p class="muted small">Edit squads from <a href="#/t/${esc(tid)}/teams">Teams &amp; squads</a>.</p>`;
  }

  function paint() {
    const m = findMatch(mid);
    const t = tournament();
    if (!m || !t) return;
    const set = (id, html) => {
      const n = el.querySelector(id);
      if (n && n.dataset.h !== html) {
        n.innerHTML = html;
        n.dataset.h = html;
      }
    };
    set('#mc-board', board(m, t));
    set('#mc-controls', controls(m));
    set('#mc-quick', quick(m));
    set('#mc-events', eventsList(m));
    set('#mc-lineups', lineups(m));
  }

  function mountShell() {
    const m = findMatch(mid);
    if (!m) return (el.innerHTML = ui.emptyState('Match not found', `<a href="#/t/${esc(tid)}">Back</a>`));
    mounted = true;
    el.innerHTML = `<div class="pagehead"><a class="back back--dark" href="#/t/${esc(tid)}/matches">← All matches</a></div>
      <div id="mc-board"></div>
      <div class="ctl-grid">
        <div class="ctl-col">
          <div class="card" id="mc-controls"></div>
          <div class="card" id="mc-quick"></div>
          <div class="card" id="mc-events"></div>
        </div>
        <div class="card" id="mc-lineups"></div>
      </div>`;
    paint();
  }

  const upd = (data, msg) => guard(() => updateDoc(mRef(tid, mid), data), msg);

  async function control(a) {
    const m = findMatch(mid);
    const t = tournament();
    const now = Date.now();
    const elapsed = clockOf(m, t, now).elapsed;
    if (a === 'kickoff') {
      const snap = (id) => ({ players: (state.teamMap[id]?.players || []).map((p) => ({ ...p })) });
      await upd({ status: 'live', period: '1H', clock: { running: true, startedAt: now, elapsedMs: 0 }, lineups: { home: snap(m.homeId), away: snap(m.awayId) } }, 'Kick-off!');
      if (t.status !== 'live' && t.status !== 'completed') updateDoc(tRef(tid), { status: 'live', startedAt: now }).catch(() => {});
    }
    if (a === 'pause') await upd({ clock: { running: false, startedAt: null, elapsedMs: elapsed } });
    if (a === 'resume') await upd({ clock: { running: true, startedAt: now, elapsedMs: m.clock?.elapsedMs || 0 } });
    if (a === 'ht') await upd({ period: 'HT', clock: { running: false, startedAt: null, elapsedMs: elapsed } }, 'Half-time');
    if (a === '2h') await upd({ period: '2H', clock: { running: true, startedAt: now, elapsedMs: half(m, t) } }, 'Second half under way');
    if (a === 'ft') {
      const { h, a: aw } = scoreOf(m);
      await upd({ status: 'ft', period: 'FT', clock: { running: false, startedAt: null, elapsedMs: elapsed }, homeScore: h, awayScore: aw }, 'Full time');
    }
    if (a === 'reopen') await upd({ status: 'live', period: '2H', clock: { running: false, startedAt: null, elapsedMs: m.clock?.elapsedMs || 0 } });
    if (['m60', 'm10', 'p10', 'p60'].includes(a)) {
      const d = { m60: -60000, m10: -10000, p10: 10000, p60: 60000 }[a];
      const c = m.clock || {};
      await upd({ clock: { ...c, elapsedMs: Math.max(0, (c.elapsedMs || 0) + d) } });
    }
    if (a === 'relineup') {
      const snap = (id) => ({ players: (state.teamMap[id]?.players || []).map((p) => ({ ...p })) });
      await upd({ lineups: { home: snap(m.homeId), away: snap(m.awayId) } }, 'Line-ups refreshed');
    }
    if (a === 'details') editMatch(m);
    if (a === 'reset') {
      if (await confirmBox('Reset match?', 'This clears the score, clock, events and saved line-ups for this match.', 'Reset'))
        await upd({ status: 'scheduled', period: 'pre', clock: { running: false, startedAt: null, elapsedMs: 0 }, events: [], homeScore: 0, awayScore: 0, lineups: null, shootout: null }, 'Match reset');
    }
  }

  function eventModal(type, side) {
    const m = findMatch(mid);
    const t = tournament();
    const teamId = side === 'home' ? m.homeId : m.awayId;
    const team = state.teamMap[teamId];
    const players = lineupFor(m, side);
    const minute = Math.max(1, clockOf(m, t).minute);
    const opts = (list, empty = '— none —') => `<option value="">${empty}</option>` + list.map((p) => `<option value="${esc(p.id)}">${esc(p.number)} · ${esc(playerName(p))}</option>`).join('');
    const starters = players.filter((p) => p.role !== 'sub');
    const subs = players.filter((p) => p.role === 'sub');
    const title = { goal: 'Goal', own_goal: 'Own goal', yellow: 'Yellow card', red: 'Red card', sub: 'Substitution' }[type];
    let fields = '';
    if (type === 'sub')
      fields = `<label>Player coming on<select name="playerId" required>${opts(subs.concat(starters), '— choose —')}</select></label>
                <label>Player going off<select name="playerOutId" required>${opts(starters.concat(subs), '— choose —')}</select></label>`;
    else
      fields = `<label>${type === 'own_goal' ? `Player (of ${esc(team?.name)}) who scored the own goal` : 'Player'}<select name="playerId">${opts(players, type === 'goal' ? '— unknown scorer —' : '— choose —')}</select></label>
        ${type === 'goal' ? `<label>Assist<select name="assistId">${opts(players)}</select></label><label class="check"><input type="checkbox" name="pen"> Penalty / 10 m kick</label>` : ''}`;
    modal(
      `${title} · ${team?.name || ''}`,
      `<div class="fgrid">${fields}<label>Minute<input type="number" name="minute" min="1" max="200" value="${minute}"></label></div>`,
      {
        submit: `Add ${title.toLowerCase()}`,
        onSubmit: async (f) => {
          const ev = {
            id: rid(),
            type,
            teamId,
            playerId: f.playerId?.value || null,
            minute: +f.minute.value || minute,
            period: m.period === '2H' || m.status === 'ft' ? '2H' : '1H',
            at: Date.now(),
          };
          if (type === 'goal') {
            ev.assistId = f.assistId.value && f.assistId.value !== ev.playerId ? f.assistId.value : null;
            ev.pen = f.pen.checked;
          }
          if (type === 'sub') {
            ev.playerOutId = f.playerOutId.value || null;
            if (!ev.playerId || !ev.playerOutId || ev.playerId === ev.playerOutId) {
              ui.toast('<b>!</b> Choose two different players.', 'toast--error');
              return false;
            }
          }
          await guard(() => changeEvents(tid, mid, (evs) => [...evs, ev]), type === 'goal' || type === 'own_goal' ? 'Goal added' : 'Event added');
        },
      }
    );
  }

  return {
    mount(x) {
      el = x;
      if (isReady() && state.tid === tid) mountShell();
      else el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
      el.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-ctl]');
        if (c) {
          c.disabled = true;
          control(c.dataset.ctl).finally(() => (c.disabled = false));
        }
        const q = e.target.closest('[data-ev]');
        if (q) eventModal(q.dataset.ev, q.dataset.side);
        const d = e.target.closest('[data-del-ev]');
        if (d && (await confirmBox('Delete event?', 'The score updates automatically.', 'Delete')))
          guard(() => changeEvents(tid, mid, (evs) => evs.filter((x) => x.id !== d.dataset.delEv)), 'Event removed');
      });
    },
    update() {
      if (!mounted) {
        if (isReady() && state.tid === tid) mountShell();
        return;
      }
      paint();
    },
  };
}

/** Change a match's events in a transaction so two admins can't overwrite each other. */
async function changeEvents(tid, mid, fn) {
  await runTransaction(db, async (tx) => {
    const ref = mRef(tid, mid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Match no longer exists');
    const m = { id: snap.id, ...snap.data() };
    const events = fn(m.events || []);
    const { h, a } = scoreOf({ ...m, events });
    tx.update(ref, { events, homeScore: h, awayScore: a });
  });
}

document.getElementById('brand-name').textContent = SITE_NAME;
route();
