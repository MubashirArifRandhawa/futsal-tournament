// Shared HTML builders used by both the public site and the admin panel.
import { scoreOf, clockOf, playerName, lineupFor, teamLabel, state } from './data.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const safeColor = (c, d) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : d);

export function inkFor(hex) {
  const h = safeColor(hex, '#37003c').replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.6 ? '#1e0021' : '#ffffff';
}

export const teamColor = (t) => safeColor(t?.color, '#5a2d82');
export const teamColor2 = (t) => safeColor(t?.color2, '#ffffff');
export const shortName = (t) => esc((t?.short || t?.name || '?').slice(0, 3).toUpperCase());

// ---------- time ----------
const dtf = (o) => new Intl.DateTimeFormat(undefined, o);
export const fmtTime = (ms) => (ms ? dtf({ hour: '2-digit', minute: '2-digit' }).format(ms) : '--:--');
export const fmtDay = (ms) => (ms ? dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms) : 'Date TBC');
export const fmtLongDay = (ms) => (ms ? dtf({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ms) : 'Date TBC');
export const dayKey = (ms) => (ms ? new Date(ms).toDateString() : 'tbc');

// ---------- icons ----------
export const icon = {
  ball: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.2l4.2 3-1.6 4.9H9.4L7.8 10.2z" fill="currentColor"/><path d="M12 2v5.2M16.2 10.2l5-1.6M14.6 15.1l3 4.3M9.4 15.1l-3 4.3M7.8 10.2l-5-1.6" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>`,
  yellow: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="2" fill="#ffd60a" transform="rotate(8 12 12)"/></svg>`,
  red: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="2" fill="#ef1d3b" transform="rotate(8 12 12)"/></svg>`,
  subOn: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#00b25b"/><path d="M12 17V7m-4.5 4.5L12 7l4.5 4.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  subOff: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ef1d3b"/><path d="M12 7v10m-4.5-4.5L12 17l4.5-4.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  whistle: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M3 12a6 6 0 1 0 12 0h6V8H9.5A6 6 0 0 0 3 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="12" r="1.8" fill="currentColor"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function eventIcon(type) {
  if (type === 'goal') return icon.ball;
  if (type === 'own_goal') return `<span class="og">${icon.ball}</span>`;
  if (type === 'yellow') return icon.yellow;
  if (type === 'red') return icon.red;
  if (type === 'sub') return icon.subOn;
  return '';
}

// ---------- crest ----------
export function crest(team, size = 36) {
  if (!team) return `<span class="crest crest--tbd" style="--s:${size}px">?</span>`;
  if (team.logoUrl && /^https:\/\//.test(team.logoUrl))
    return `<span class="crest crest--img" style="--s:${size}px"><img src="${esc(team.logoUrl)}" alt="" loading="lazy"></span>`;
  const c1 = teamColor(team);
  const c2 = teamColor2(team);
  return `<span class="crest" style="--s:${size}px;--ink:${inkFor(c1)}" aria-hidden="true">
    <svg viewBox="0 0 40 46"><path d="M20 1.5 37.5 7v15c0 11.6-7.6 18.6-17.5 22.5C10.1 40.6 2.5 33.6 2.5 22V7z" fill="${c1}" stroke="${c2}" stroke-width="2.4"/><path d="M20 1.5 37.5 7v15c0 1-.1 2-.2 3H2.7c-.1-1-.2-2-.2-3V7z" fill="#fff" opacity=".10"/></svg>
    <b>${shortName(team)}</b></span>`;
}

// ---------- shirt ----------
export function shirt(fill, trim, num, extraClass = '') {
  const ink = inkFor(fill);
  return `<span class="shirt ${extraClass}"><svg viewBox="0 0 48 44" aria-hidden="true"><path d="M15.5 2 5.5 6.5 1 16.5l7.5 4 2-3V42h27V17.5l2 3 7.5-4-4.5-10L32.5 2c-1.6 3.8-4.8 6-8.5 6s-6.9-2.2-8.5-6z" fill="${fill}" stroke="${trim}" stroke-width="1.8" stroke-linejoin="round"/></svg><span class="shirt-num" style="color:${ink}">${esc(num ?? '')}</span></span>`;
}

// ---------- status ----------
export function liveBadge(m, t) {
  const c = clockOf(m, t);
  return `<span class="live-badge"><i></i><span data-clock="${esc(m.id)}">${esc(c.label || 'LIVE')}</span></span>`;
}

export function statusText(m, t) {
  if (m.status === 'live') return liveBadge(m, t);
  if (m.status === 'ft') return `<span class="ft-badge">FT</span>`;
  return `<span class="ko-time">${fmtTime(m.kickoffAt)}</span>`;
}

export function stageLabel(m) {
  if (m.stage === 'final') return 'Final';
  return `Matchday ${m.round || 1}`;
}

// ---------- match row ----------
export function matchRow(m, { teamMap = state.teamMap, t = null, showMeta = true } = {}) {
  const H = teamMap[m.homeId];
  const A = teamMap[m.awayId];
  const { h, a } = scoreOf(m);
  const started = m.status === 'live' || m.status === 'ft';
  const center = started
    ? `<span class="score ${m.status === 'live' ? 'score--live' : ''}" data-score="${esc(m.id)}">${h}<i>–</i>${a}</span>`
    : `<span class="score score--ko">${fmtTime(m.kickoffAt)}</span>`;
  const pens = m.shootout && (m.shootout.home || m.shootout.away) ? `<span class="pens">(${m.shootout.home}–${m.shootout.away} pens)</span>` : '';
  return `<a class="mrow ${m.status === 'live' ? 'mrow--live' : ''}" href="#/match/${esc(m.id)}">
    <span class="mrow-team mrow-team--home"><span class="tname">${esc(teamLabel(m, 'home', teamMap))}</span><span class="tshort">${H ? shortName(H) : 'TBD'}</span>${crest(H, 30)}</span>
    <span class="mrow-mid">${center}${pens}</span>
    <span class="mrow-team">${crest(A, 30)}<span class="tname">${esc(teamLabel(m, 'away', teamMap))}</span><span class="tshort">${A ? shortName(A) : 'TBD'}</span></span>
    ${
      showMeta
        ? `<span class="mrow-meta">${m.status === 'live' ? liveBadge(m, t) : m.status === 'ft' ? '<span class="ft-badge">FT</span>' : ''}
      <span>${esc(stageLabel(m))}</span>${m.court && (t?.courts || 1) > 1 ? `<span>Court ${esc(m.court)}</span>` : ''}${
        m.referee ? `<span class="ref">${icon.whistle}${esc(m.referee)}</span>` : ''
      }</span>`
        : ''
    }
  </a>`;
}

// ---------- formation / pitch ----------
const ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export function splitSquad(players = []) {
  const starters = players.filter((p) => p.role !== 'sub').slice(0, 5);
  const subs = players.filter((p) => !starters.includes(p));
  return { starters, subs };
}

/** Returns { gk, rows: [[p..],[p..]] , label } ordered defence → attack */
export function formation(starters) {
  const list = starters.slice();
  let gkIdx = list.findIndex((p) => p.position === 'GK');
  if (gkIdx < 0) gkIdx = 0;
  const gk = list.splice(gkIdx, 1)[0] || null;
  const groups = { DEF: [], MID: [], FWD: [] };
  list.forEach((p) => (groups[p.position === 'GK' ? 'DEF' : p.position] || groups.MID).push(p));
  const rows = ['DEF', 'MID', 'FWD'].map((k) => groups[k]).filter((r) => r.length);
  return { gk, rows, label: rows.map((r) => r.length).join('-') || '—' };
}

function spreadX(n, i) {
  if (n === 1) return 50;
  const span = Math.min(64, 22 * (n - 1));
  return 50 - span / 2 + (span / (n - 1)) * i;
}

/** Compute token positions. side: 'full' | 'home' | 'away' */
function layout(starters, side) {
  const { gk, rows } = formation(starters);
  const out = [];
  const cfg = {
    full: { gk: 88, from: 68, to: 22 },
    home: { gk: 93, from: 79, to: 57 },
    away: { gk: 7, from: 21, to: 43 },
  }[side];
  if (gk) out.push({ p: gk, x: 50, y: cfg.gk, gk: true });
  const R = rows.length;
  rows.forEach((row, ri) => {
    const y = R === 1 ? (cfg.from + cfg.to) / 2 : cfg.from + ((cfg.to - cfg.from) / (R - 1)) * ri;
    row.forEach((p, i) => {
      const x = spreadX(row.length, i);
      out.push({ p, x: side === 'away' ? 100 - x : x, y });
    });
  });
  return out;
}

/** Per-player match markers (goals, cards, subbed off) */
export function playerMarks(m) {
  const marks = {};
  const get = (id) => (marks[id] ||= { goals: 0, og: 0, yellow: 0, red: 0, off: null, on: null });
  for (const e of m?.events || []) {
    if (!e.playerId && e.type !== 'sub') continue;
    if (e.type === 'goal') get(e.playerId).goals++;
    else if (e.type === 'own_goal') get(e.playerId).og++;
    else if (e.type === 'yellow') get(e.playerId).yellow++;
    else if (e.type === 'red') get(e.playerId).red++;
    else if (e.type === 'sub') {
      if (e.playerOutId) get(e.playerOutId).off = e.minute;
      if (e.playerId) get(e.playerId).on = e.minute;
    }
  }
  return marks;
}

function token({ p, x, y, gk }, team, marks) {
  const mk = marks?.[p.id];
  const fill = gk ? safeColor(team?.gkColor, '#1d1d1f') : teamColor(team);
  const trim = gk ? '#ffffff' : teamColor2(team);
  const badges = [];
  if (mk?.goals) badges.push(`<span class="tb tb-goal">${icon.ball}${mk.goals > 1 ? `<b>${mk.goals}</b>` : ''}</span>`);
  if (mk?.og) badges.push(`<span class="tb tb-goal og">${icon.ball}</span>`);
  if (mk?.red) badges.push(`<span class="tb">${icon.red}</span>`);
  else if (mk?.yellow) badges.push(`<span class="tb">${icon.yellow}</span>`);
  const off = mk?.off != null ? `<span class="tb tb-off">${icon.subOff}<b>${esc(mk.off)}'</b></span>` : '';
  return `<div class="pp" style="left:${x}%;top:${y}%">
    <div class="pp-shirt">${shirt(fill, trim, p.number)}${p.captain ? '<span class="pp-c">C</span>' : ''}<span class="pp-badges">${badges.join('')}</span>${off}</div>
    <div class="pp-name">${esc(playerName(p))}</div>
  </div>`;
}

const PITCH_LINES = `<svg class="pitch-lines" viewBox="0 0 200 300" preserveAspectRatio="none" aria-hidden="true">
  <g fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.4">
    <rect x="8" y="8" width="184" height="284" rx="2"/>
    <line x1="8" y1="150" x2="192" y2="150"/>
    <circle cx="100" cy="150" r="26"/>
    <path d="M44 8v8a40 40 0 0 0 40 38h32a40 40 0 0 0 40-38V8"/>
    <path d="M44 292v-8a40 40 0 0 1 40-38h32a40 40 0 0 1 40 38v8"/>
    <rect x="86" y="2" width="28" height="6"/><rect x="86" y="292" width="28" height="6"/>
  </g>
  <g fill="rgba(255,255,255,.8)"><circle cx="100" cy="150" r="2"/><circle cx="100" cy="44" r="1.6"/><circle cx="100" cy="256" r="1.6"/></g>
</svg>`;

/** Team sheet for one team on a full pitch. */
export function teamPitch(team, players = team?.players || [], m = null) {
  const { starters } = splitSquad(players);
  const marks = m ? playerMarks(m) : null;
  const f = formation(starters);
  return `<div class="pitch pitch--full">
    ${PITCH_LINES}
    <span class="pitch-formation">${esc(f.label)}</span>
    ${layout(starters, 'full').map((t) => token(t, team, marks)).join('')}
  </div>`;
}

/** Both teams on one pitch: home bottom half, away top half. */
export function matchPitch(m, teamMap = state.teamMap) {
  const H = teamMap[m.homeId];
  const A = teamMap[m.awayId];
  const hs = splitSquad(lineupFor(m, 'home', teamMap)).starters;
  const as = splitSquad(lineupFor(m, 'away', teamMap)).starters;
  const marks = playerMarks(m);
  const label = (team, side, f) => `<div class="pitch-label">${crest(team, 22)}<span>${esc(teamLabel(m, side, teamMap))}</span><b>${esc(f)}</b></div>`;
  return `<div class="match-pitch">
    ${label(A, 'away', formation(as).label)}
    <div class="pitch pitch--match">
      ${PITCH_LINES}
      ${layout(as, 'away').map((t) => token(t, A, marks)).join('')}
      ${layout(hs, 'home').map((t) => token(t, H, marks)).join('')}
    </div>
    ${label(H, 'home', formation(hs).label)}
  </div>`;
}

export function subsList(team, players, m = null, title = 'Substitutes') {
  const { subs } = splitSquad(players);
  const marks = m ? playerMarks(m) : {};
  if (!subs.length) return `<div class="subs"><h4>${esc(title)}</h4><p class="muted small">No substitutes listed.</p></div>`;
  return `<div class="subs"><h4>${esc(title)}</h4><ul>${subs
    .map((p) => {
      const mk = marks[p.id];
      return `<li>${shirt(p.position === 'GK' ? safeColor(team?.gkColor, '#1d1d1f') : teamColor(team), p.position === 'GK' ? '#ffffff' : teamColor2(team), p.number, 'shirt--sm')}<span class="subs-name">${esc(playerName(p))}${
        p.captain ? ' <em class="cap">C</em>' : ''
      }</span><span class="subs-pos">${esc(p.position || '')}</span>${
        mk?.on != null ? `<span class="subs-on">${icon.subOn}${esc(mk.on)}'</span>` : ''
      }${mk?.goals ? `<span class="subs-on">${icon.ball}${mk.goals > 1 ? mk.goals : ''}</span>` : ''}</li>`;
    })
    .join('')}</ul></div>`;
}

// ---------- standings ----------
export function standingsTable(rows, { compact = false, qualify = 0 } = {}) {
  if (!rows.length) return `<p class="muted">No teams yet.</p>`;
  return `<div class="table-wrap"><table class="standings ${compact ? 'standings--compact' : ''}">
    <thead><tr><th class="pos">Pos</th><th class="club">Club</th><th>Pl</th>${compact ? '' : '<th>W</th><th>D</th><th>L</th><th class="hide-sm">GF</th><th class="hide-sm">GA</th>'}<th>GD</th><th class="pts">Pts</th>${
      compact ? '' : '<th class="form hide-sm">Form</th>'
    }</tr></thead>
    <tbody>${rows
      .map(
        (r, i) => `<tr class="${i < qualify ? 'q' : ''}">
        <td class="pos"><span>${i + 1}</span></td>
        <td class="club"><a href="#/team/${esc(r.team.id)}">${crest(r.team, 24)}<span class="club-name">${esc(r.team.name)}</span>${r.live ? '<span class="dot-live" title="Playing now"></span>' : ''}</a></td>
        <td>${r.p}</td>${compact ? '' : `<td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td class="hide-sm">${r.gf}</td><td class="hide-sm">${r.ga}</td>`}
        <td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td class="pts">${r.pts}</td>
        ${compact ? '' : `<td class="form hide-sm">${r.form.map((f) => `<span class="fchip fchip--${f.r}">${f.r}</span>`).join('') || '<span class="muted">—</span>'}</td>`}
      </tr>`
      )
      .join('')}</tbody></table></div>`;
}

export function emptyState(title, body = '') {
  return `<div class="empty"><div class="empty-ball">${icon.ball}</div><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}</div>`;
}

export function toast(html, kind = '') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4800);
}
