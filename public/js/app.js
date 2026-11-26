// Public website: read-only, updates live from Firestore.
import {
  start,
  subscribe,
  state,
  tournament,
  isReady,
  selectTournament,
  computeStandings,
  leaders,
  scoreOf,
  clockOf,
  playerIndex,
  playerName,
  lineupFor,
  teamLabel,
  byKickoff,
  rewardsOf,
  minuteText,
} from './data.js';
import * as ui from './ui.js';
import { SITE_NAME } from './firebase-config.js';

const { esc, crest, icon } = ui;
const $app = document.getElementById('app');
const ui_state = { fixturesTeam: 'all', teamTab: 'squad', matchTab: null, matchTabFor: null };

// ---------------- routing ----------------
const routes = [
  [/^\/?$/, home],
  [/^\/fixtures$/, fixtures],
  [/^\/table$/, table],
  [/^\/teams$/, teams],
  [/^\/team\/([\w-]+)$/, teamPage],
  [/^\/match\/([\w-]+)$/, matchPage],
  [/^\/stats$/, stats],
];

function currentRoute() {
  const path = (location.hash || '#/').slice(1) || '/';
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return { fn, args: m.slice(1), path };
  }
  return { fn: home, args: [], path: '/' };
}

let lastHtml = '';
let lastPath = '';
const prevScores = new Map();
const seenEvents = new Set();
let eventsPrimed = false;

function render() {
  const r = currentRoute();
  let html;
  if (!state.configured) html = setupNeeded();
  else if (state.error) html = ui.emptyState('Could not load data', esc(state.error));
  else if (!isReady()) html = loading();
  else if (!tournament()) html = ui.emptyState('No tournament yet', 'The organiser has not published a tournament. Check back soon.');
  else html = r.fn(tournament(), ...r.args);

  if (html !== lastHtml) {
    const keepScroll = r.path === lastPath;
    const y = window.scrollY;
    $app.innerHTML = html;
    lastHtml = html;
    if (keepScroll) window.scrollTo(0, y);
    else window.scrollTo(0, 0);
  }
  lastPath = r.path;
  attachTrophy();
  updateChrome(r.path);
  flashScores();
  announceGoals();
  tick();
}

function updateChrome(path) {
  const t = tournament();
  document.title = t ? `${t.name} · ${SITE_NAME}` : SITE_NAME;
  const top = '/' + (path.split('/')[1] || '');
  const section = { '/': '/', '/fixtures': '/fixtures', '/match': '/fixtures', '/table': '/table', '/teams': '/teams', '/team': '/teams', '/stats': '/stats' }[top] || '/';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const sel = document.getElementById('tournament-select');
  if (sel) {
    const opts = state.tournaments.map((x) => `<option value="${esc(x.id)}" ${x.id === state.tid ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    if (sel.dataset.opts !== opts) {
      sel.innerHTML = opts;
      sel.dataset.opts = opts;
    }
    sel.value = state.tid || '';
    sel.closest('.switcher').hidden = state.tournaments.length < 2;
  }
  const name = document.getElementById('brand-tournament');
  if (name) name.textContent = t?.name || '';
}

function flashScores() {
  for (const m of state.matches) {
    const { h, a } = scoreOf(m);
    const key = `${h}-${a}`;
    const prev = prevScores.get(m.id);
    if (prev && prev !== key) document.querySelectorAll(`[data-score="${CSS.escape(m.id)}"]`).forEach((el) => el.classList.add('flash'));
    prevScores.set(m.id, key);
  }
}

function announceGoals() {
  if (!isReady()) return;
  const idx = playerIndex();
  for (const m of state.matches)
    for (const e of m.events || []) {
      if (seenEvents.has(e.id)) continue;
      seenEvents.add(e.id);
      if (!eventsPrimed || m.status !== 'live') continue;
      if (e.type !== 'goal' && e.type !== 'own_goal') continue;
      const { h, a } = scoreOf(m);
      const who = e.playerId ? playerName(idx[e.playerId]) : '';
      ui.toast(
        `<b>GOAL!</b> ${esc(teamLabel(m, 'home'))} ${h}–${a} ${esc(teamLabel(m, 'away'))}${who ? `<br><small>${esc(who)}${e.type === 'own_goal' ? ' (OG)' : ''} ${esc(minuteText(e))}</small>` : ''}`,
        'toast--goal'
      );
    }
  eventsPrimed = true;
}

function tick() {
  const t = tournament();
  document.querySelectorAll('[data-clock]').forEach((el) => {
    const m = state.matches.find((x) => x.id === el.dataset.clock);
    if (m) el.textContent = clockOf(m, t).label || 'LIVE';
  });
  document.querySelectorAll('[data-mmss]').forEach((el) => {
    const m = state.matches.find((x) => x.id === el.dataset.mmss);
    if (m) el.textContent = clockOf(m, t).mmss;
  });
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const ms = Number(el.dataset.countdown) - Date.now();
    if (ms <= 0) return (el.textContent = 'Starting soon');
    const d = Math.floor(ms / 864e5);
    const h = Math.floor((ms % 864e5) / 36e5);
    const mi = Math.floor((ms % 36e5) / 6e4);
    const s = Math.floor((ms % 6e4) / 1e3);
    el.textContent = d ? `${d}d ${h}h ${mi}m` : `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });
}

// ---------------- 3D trophy ----------------
// The WebGL canvas lives in one element that is moved into #trophy-slot after
// every render, so live score updates never rebuild the 3D scene.
let trophyEl = null;
function attachTrophy() {
  const slot = document.getElementById('trophy-slot');
  if (!slot) return;
  if (!trophyEl) {
    trophyEl = document.createElement('div');
    trophyEl.className = 'trophy3d';
    trophyEl.innerHTML = '<div class="trophy3d-msg"><div class="spinner"></div></div>';
    import('./trophy3d.js')
      .then((mod) => mod.mountTrophy(trophyEl))
      .catch((e) => {
        console.error(e);
        trophyEl.innerHTML = '<div class="trophy3d-msg">The 3D trophy needs WebGL, which this browser could not start.</div>';
      });
  }
  if (trophyEl.parentNode !== slot) slot.appendChild(trophyEl);
}

const rewardIcon = {
  champion: '<svg viewBox="0 0 24 24"><path d="M7 4h10v4a5 5 0 0 1-10 0z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3 M12 13v4 M8 20h8 M9.5 17h5v3h-5z"/></svg>',
  runnerup: '<svg viewBox="0 0 24 24"><circle cx="12" cy="15" r="5"/><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8"/></svg>',
  topscorer: '<svg viewBox="0 0 24 24"><path d="M3 15c3 0 5-1 7-4l2-3c1 2 3 3 6 3 2 0 3 1 3 2v2H3z M3 15v2h18 M6 19v1 M10 19v1 M16 19v1"/></svg>',
  topassist: '<svg viewBox="0 0 24 24"><path d="M5 12h11 M12 7l5 5-5 5"/><circle cx="5" cy="12" r="2"/></svg>',
  '': '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
};

/** Who holds (or currently leads for) a reward. */
function rewardHolder(r, t) {
  const ms = state.matches;
  const final = ms.find((m) => m.stage === 'final');
  const leagueLeft = ms.some((m) => (m.stage || 'league') === 'league' && m.status !== 'ft');
  const decided = t.status === 'completed' || (final ? final.status === 'ft' : !leagueLeft && ms.length > 0);
  const anyPlayed = ms.some((m) => m.status === 'ft');
  const rows = computeStandings();
  const L = leaders();
  const team = (x) => (x ? { name: x.name, crest: crest(x, 26) } : null);
  let who = null;
  if (r.link === 'champion' || r.link === 'runnerup') {
    if (final && final.status === 'ft') {
      const w = winnerOf(final);
      const lose = w && state.teamMap[w.id === final.homeId ? final.awayId : final.homeId];
      who = team(r.link === 'champion' ? w : lose);
    } else if (anyPlayed) who = team(rows[r.link === 'champion' ? 0 : 1]?.team);
  } else if (r.link === 'topscorer' || r.link === 'topassist') {
    const top = (r.link === 'topscorer' ? L.scorers : L.assists)[0];
    if (top) {
      const n = r.link === 'topscorer' ? top.goals : top.assists;
      const tm = state.teamMap[top.teamId];
      who = { name: `${playerName(top.player)} · ${n} ${r.link === 'topscorer' ? (n === 1 ? 'goal' : 'goals') : n === 1 ? 'assist' : 'assists'}`, crest: tm ? crest(tm, 26) : '' };
    }
  } else if (r.winner) return { label: 'Winner', name: r.winner, crest: '' };
  if (!who) return null;
  // final standings of a league-only competition, or a played final, are settled
  const settled = r.link === 'champion' || r.link === 'runnerup' ? decided : t.status === 'completed';
  return { label: settled ? 'Winner' : 'Leading', ...who };
}

function rewardsSection(t) {
  const list = rewardsOf(t);
  return `<section class="trophy-sec">
    <div class="trophy-stage">
      <div id="trophy-slot"></div>
      <span class="trophy-hint">Drag to rotate · scroll or pinch to zoom · double-tap to reset</span>
    </div>
    <div class="rewards">
      <span class="rewards-eyebrow">Up for grabs</span>
      <h2>Trophy &amp; rewards</h2>
      ${
        list.length
          ? `<ul class="rewards-list">${list
              .map((r, i) => {
                const h = rewardHolder(r, t);
                return `<li class="reward ${i === 0 ? 'reward--top' : ''}">
              <span class="reward-ico">${rewardIcon[r.link || ''] || rewardIcon['']}</span>
              <span class="reward-main"><b>${esc(r.title)}</b>${r.prize ? `<small>${esc(r.prize)}</small>` : ''}</span>
              <span class="reward-holder">${
                h ? `<em class="${h.label === 'Winner' ? 'won' : ''}">${esc(h.label)}</em><span>${h.crest || ''}<b>${esc(h.name)}</b></span>` : '<em>To be decided</em>'
              }</span></li>`;
              })
              .join('')}</ul>`
          : '<p class="muted">Rewards will be announced soon.</p>'
      }
    </div>
  </section>`;
}

// ---------------- shared bits ----------------
function loading() {
  return `<div class="loading"><div class="spinner"></div><p>Loading tournament…</p></div>`;
}

function setupNeeded() {
  return `<section class="card setup">
    <h2>Connect Firebase to get started</h2>
    <p>Open <code>public/js/firebase-config.js</code> and paste your Firebase web app config. Then publish <code>firestore.rules</code> and create your admin account. The README has step-by-step instructions.</p>
  </section>`;
}

function sectionHead(title, link = '') {
  return `<div class="shead"><h2>${esc(title)}</h2>${link}</div>`;
}

function statusChip(t) {
  const s = t.status || 'draft';
  const label = { draft: 'Upcoming', live: 'Live now', completed: 'Completed' }[s] || s;
  return `<span class="tchip tchip--${esc(s)}">${s === 'live' ? '<i></i>' : ''}${esc(label)}</span>`;
}

function scorersLine(m, side) {
  const idx = playerIndex();
  const teamId = side === 'home' ? m.homeId : m.awayId;
  const other = side === 'home' ? m.awayId : m.homeId;
  const list = (m.events || [])
    .filter((e) => (e.type === 'goal' && e.teamId === teamId) || (e.type === 'own_goal' && e.teamId === other))
    .filter((e) => e.playerId || minuteText(e)) // skip goals entered as a bare score
    .sort((a, b) => (a.minute || 0) - (b.minute || 0));
  const by = new Map();
  list.forEach((e) => {
    const name = e.playerId ? playerName(idx[e.playerId]) : 'Goal';
    const tag = `${minuteText(e)}${e.type === 'own_goal' ? ' OG' : e.pen ? ' pen' : ''}`.trim();
    by.set(name, tag ? [...(by.get(name) || []), tag] : by.get(name) || []);
  });
  return [...by].map(([n, mins]) => `<li>${esc(n)} <span>${esc(mins.join(', '))}</span></li>`).join('');
}

function liveCard(m, t) {
  const H = state.teamMap[m.homeId];
  const A = state.teamMap[m.awayId];
  const { h, a } = scoreOf(m);
  return `<a class="livecard" href="#/match/${esc(m.id)}" style="--hc:${ui.teamColor(H)};--ac:${ui.teamColor(A)}">
    <div class="livecard-top">${ui.liveBadge(m, t)}<span>${esc(ui.stageLabel(m))}${m.referee ? ` · Ref: ${esc(m.referee)}` : ''}</span></div>
    <div class="livecard-body">
      <div class="lc-team">${crest(H, 56)}<b>${esc(teamLabel(m, 'home'))}</b><ul class="scorers">${scorersLine(m, 'home')}</ul></div>
      <div class="lc-score" data-score="${esc(m.id)}">${h}<i>–</i>${a}<small data-mmss="${esc(m.id)}">${clockOf(m, t).mmss}</small></div>
      <div class="lc-team">${crest(A, 56)}<b>${esc(teamLabel(m, 'away'))}</b><ul class="scorers">${scorersLine(m, 'away')}</ul></div>
    </div>
  </a>`;
}

function groupedMatches(list, t) {
  if (!list.length) return ui.emptyState('No matches here yet');
  const days = new Map();
  list.forEach((m) => {
    const k = ui.dayKey(m.kickoffAt);
    days.set(k, [...(days.get(k) || []), m]);
  });
  return [...days.values()]
    .map(
      (ms) => `<section class="daygroup"><h3 class="dayhead">${esc(ui.fmtLongDay(ms[0].kickoffAt))}</h3>
      <div class="card card--flush">${ms.map((m) => ui.matchRow(m, { t })).join('')}</div></section>`
    )
    .join('');
}

// ---------------- views ----------------
function home(t) {
  const ms = state.matches;
  const live = ms.filter((m) => m.status === 'live');
  const upcoming = ms.filter((m) => m.status === 'scheduled').sort(byKickoff).slice(0, 4);
  const results = ms.filter((m) => m.status === 'ft').sort((a, b) => byKickoff(b, a)).slice(0, 4);
  const played = ms.filter((m) => m.status === 'ft').length;
  const first = ms.slice().sort(byKickoff)[0];
  const rows = computeStandings();
  const L = leaders();
  const final = ms.find((m) => m.stage === 'final');
  const champion = final && final.status === 'ft' ? winnerOf(final) : null;

  return `
  <section class="hero">
    <div class="hero-inner">
      <div class="hero-text">
        ${statusChip(t)}
        <h1>${esc(t.name)}</h1>
        <p class="hero-meta">${t.venue ? `${icon.pin}${esc(t.venue)}` : ''}<span>${icon.clock}${esc(ui.fmtLongDay(first?.kickoffAt || t.startAt))}</span></p>
        <div class="hero-stats">
          <div><b>${state.teams.length}</b><span>Teams</span></div>
          <div><b>${ms.length}</b><span>Matches</span></div>
          <div><b>${ms.reduce((n, m) => n + scoreOf(m).h + scoreOf(m).a, 0)}</b><span>Goals</span></div>
          <div><b>${esc(t.matchMinutes || '—')}′</b><span>Match length</span></div>
        </div>
        <div class="progress"><span style="width:${ms.length ? (played / ms.length) * 100 : 0}%"></span></div>
        <p class="progress-label">${played} of ${ms.length} matches played</p>
      </div>
      ${
        champion
          ? `<div class="hero-side champion">${crest(champion, 84)}<span>Champions</span><b>${esc(champion.name)}</b></div>`
          : t.status !== 'live' && first && first.kickoffAt > Date.now() && !live.length
          ? `<div class="hero-side"><span>Kick-off in</span><b class="countdown" data-countdown="${first.kickoffAt}">—</b><small>${esc(ui.fmtDay(first.kickoffAt))} · ${esc(ui.fmtTime(first.kickoffAt))}</small></div>`
          : ''
      }
    </div>
  </section>

  ${live.length ? `<section>${sectionHead('Live now')}<div class="livegrid">${live.map((m) => liveCard(m, t)).join('')}</div></section>` : ''}

  ${rewardsSection(t)}

  <div class="grid-2">
    <div>
      ${sectionHead('Up next', '<a class="more" href="#/fixtures">All fixtures ' + icon.chevron + '</a>')}
      <div class="card card--flush">${upcoming.length ? upcoming.map((m) => ui.matchRow(m, { t })).join('') : '<p class="pad muted">No upcoming matches.</p>'}</div>
      ${sectionHead('Latest results')}
      <div class="card card--flush">${results.length ? results.map((m) => ui.matchRow(m, { t })).join('') : '<p class="pad muted">No results yet.</p>'}</div>
    </div>
    <div>
      ${sectionHead('Table', '<a class="more" href="#/table">Full table ' + icon.chevron + '</a>')}
      <div class="card card--flush">${ui.standingsTable(rows, { compact: true, qualify: t.format === 'league_final' ? 2 : 0 })}</div>
      ${sectionHead('Top scorers', '<a class="more" href="#/stats">All stats ' + icon.chevron + '</a>')}
      <div class="card card--flush">${leaderList(L.scorers.slice(0, 5), 'goals')}</div>
    </div>
  </div>`;
}

function winnerOf(m) {
  const { h, a } = scoreOf(m);
  let side = h > a ? 'home' : a > h ? 'away' : null;
  if (!side && m.shootout) side = m.shootout.home > m.shootout.away ? 'home' : m.shootout.away > m.shootout.home ? 'away' : null;
  return side ? state.teamMap[side === 'home' ? m.homeId : m.awayId] : null;
}

function leaderList(list, key) {
  if (!list.length) return `<p class="pad muted">Nothing recorded yet.</p>`;
  return `<ol class="leaders">${list
    .map((r, i) => {
      const team = state.teamMap[r.teamId];
      return `<li><span class="lpos">${i + 1}</span>${ui.shirt(ui.teamColor(team), ui.teamColor2(team), r.player.number, 'shirt--sm')}
      <span class="lname"><b>${esc(playerName(r.player))}</b><small>${esc(team?.name || '')}</small></span>
      <span class="lval">${key === 'cards' ? `${r.yellow ? `${icon.yellow}${r.yellow}` : ''} ${r.red ? `${icon.red}${r.red}` : ''}` : r[key]}</span></li>`;
    })
    .join('')}</ol>`;
}

function fixtures(t) {
  const sel = ui_state.fixturesTeam;
  const team = state.teamMap[sel];
  const list = state.matches.filter((m) => !team || m.homeId === sel || m.awayId === sel);
  const chips = [`<button class="chip ${!team ? 'active' : ''}" data-fixtures-team="all">All teams</button>`]
    .concat(state.teams.map((x) => `<button class="chip ${sel === x.id ? 'active' : ''}" data-fixtures-team="${esc(x.id)}">${crest(x, 18)}${esc(x.name)}</button>`))
    .join('');
  const rec = team ? computeStandings().find((r) => r.team.id === team.id) : null;
  return `
    <div class="pagehead"><h1>Fixtures &amp; Results</h1><p>${esc(t.name)}</p></div>
    <div class="chips" role="tablist">${chips}</div>
    ${
      team && rec
        ? `<div class="card teamstrip" style="--tc:${ui.teamColor(team)}">${crest(team, 40)}<div><b>${esc(team.name)} schedule</b><small>Played ${rec.p} · W ${rec.w} D ${rec.d} L ${rec.l} · ${rec.pts} pts</small></div><a class="more" href="#/team/${esc(team.id)}">Team page ${icon.chevron}</a></div>`
        : ''
    }
    ${groupedMatches(list, t)}`;
}

function table(t) {
  const rows = computeStandings();
  const final = state.matches.find((m) => m.stage === 'final');
  return `
    <div class="pagehead"><h1>Table</h1><p>${esc(t.name)} · 3 pts win, 1 pt draw</p></div>
    <div class="card card--flush">${ui.standingsTable(rows, { qualify: t.format === 'league_final' ? 2 : 0 })}</div>
    ${t.format === 'league_final' ? `<p class="legend"><span class="legend-q"></span>Top two qualify for the final</p>` : ''}
    ${final ? `${sectionHead('Final')}<div class="card card--flush">${ui.matchRow(final, { t })}</div>` : ''}`;
}

function teams(t) {
  const rows = computeStandings();
  return `
    <div class="pagehead"><h1>Teams</h1><p>${state.teams.length} teams · 5-a-side squads</p></div>
    <div class="teamgrid">${state.teams
      .map((x) => {
        const r = rows.find((y) => y.team.id === x.id);
        const pos = rows.indexOf(r) + 1;
        return `<a class="teamcard" href="#/team/${esc(x.id)}" style="--tc:${ui.teamColor(x)};--tc2:${ui.teamColor2(x)}">
        <span class="teamcard-band"></span>${crest(x, 64)}<b>${esc(x.name)}</b>
        <small>${x.coach ? `Coach: ${esc(x.coach)}` : `${(x.players || []).filter((p) => p.name).length} players`}</small>
        <span class="teamcard-rec"><span>${ordinal(pos)}</span><span>${r?.pts ?? 0} pts</span></span></a>`;
      })
      .join('')}</div>`;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function teamPage(t, id) {
  const team = state.teamMap[id];
  if (!team) return ui.emptyState('Team not found', '<a href="#/teams">Back to teams</a>');
  const tab = ui_state.teamTab;
  const ms = state.matches.filter((m) => m.homeId === id || m.awayId === id);
  const rows = computeStandings();
  const r = rows.find((x) => x.team.id === id);
  const L = leaders();
  const tabs = ['squad', 'fixtures', 'stats']
    .map((k) => `<button class="seg ${tab === k ? 'active' : ''}" data-team-tab="${k}">${{ squad: 'Squad', fixtures: 'Schedule', stats: 'Stats' }[k]}</button>`)
    .join('');
  let body = '';
  if (tab === 'squad') {
    body = `<div class="sheet">
      <div class="sheet-pitch">${ui.teamPitch(team)}</div>
      <div class="sheet-side card">
        <h4>Starting five</h4>
        <ul class="startlist">${ui
          .splitSquad(team.players)
          .starters.map((p) => `<li>${ui.shirt(p.position === 'GK' ? team.gkColor || '#1d1d1f' : ui.teamColor(team), ui.teamColor2(team), p.number, 'shirt--sm')}<span class="subs-name">${esc(playerName(p))}${p.captain ? ' <em class="cap">C</em>' : ''}</span><span class="subs-pos">${esc(p.position || '')}</span></li>`)
          .join('')}</ul>
        ${ui.subsList(team, team.players)}
        ${team.coach ? `<div class="coach"><span>Coach</span><b>${esc(team.coach)}</b></div>` : ''}
      </div></div>`;
  } else if (tab === 'fixtures') {
    body = groupedMatches(ms, t);
  } else {
    const mine = L.all.filter((x) => x.teamId === id).sort((a, b) => b.goals - a.goals || b.assists - a.assists);
    body = `<div class="statgrid">
      ${[['Played', r?.p], ['Won', r?.w], ['Drawn', r?.d], ['Lost', r?.l], ['Goals for', r?.gf], ['Goals against', r?.ga]]
        .map(([k, v]) => `<div class="stat card"><b>${v ?? 0}</b><span>${k}</span></div>`)
        .join('')}
    </div>
    <div class="card card--flush"><table class="ptable"><thead><tr><th>Player</th><th>Goals</th><th>Assists</th><th>Cards</th></tr></thead><tbody>${
      (team.players || [])
        .map((p) => {
          const s = mine.find((x) => x.player.id === p.id) || {};
          return `<tr><td>${ui.shirt(ui.teamColor(team), ui.teamColor2(team), p.number, 'shirt--xs')} ${esc(playerName(p))}</td><td>${s.goals || 0}</td><td>${s.assists || 0}</td><td>${s.yellow ? icon.yellow + s.yellow : ''}${s.red ? icon.red + s.red : ''}</td></tr>`;
        })
        .join('') || '<tr><td colspan="4" class="muted">No players yet</td></tr>'
    }</tbody></table></div>`;
  }
  return `
    <section class="teamhero" style="--tc:${ui.teamColor(team)};--tc2:${ui.teamColor2(team)}">
      <a class="back" href="#/teams">← Teams</a>
      <div class="teamhero-row">${crest(team, 84)}<div><h1>${esc(team.name)}</h1>
      <p>${r ? `${ordinal(rows.indexOf(r) + 1)} · ${r.pts} pts` : ''}${team.coach ? ` · Coach ${esc(team.coach)}` : ''}</p>
      <div class="formrow">${(r?.form || []).map((f) => `<span class="fchip fchip--${f.r}">${f.r}</span>`).join('')}</div></div></div>
    </section>
    <div class="segs">${tabs}</div>
    ${body}`;
}

function matchPage(t, id) {
  const m = state.matches.find((x) => x.id === id);
  if (!m) return ui.emptyState('Match not found', '<a href="#/fixtures">Back to fixtures</a>');
  if (ui_state.matchTabFor !== id) {
    ui_state.matchTabFor = id;
    ui_state.matchTab = m.status === 'scheduled' ? 'lineups' : 'overview';
  }
  const tab = ui_state.matchTab;
  const H = state.teamMap[m.homeId];
  const A = state.teamMap[m.awayId];
  const { h, a } = scoreOf(m);
  const started = m.status !== 'scheduled';
  const clk = clockOf(m, t);
  const status =
    m.status === 'live'
      ? `${ui.liveBadge(m, t)}<span class="mc-clock" data-mmss="${esc(m.id)}">${clk.mmss}</span>`
      : m.status === 'ft'
      ? '<span class="ft-badge ft-badge--lg">Full time</span>'
      : `<span class="mc-ko">${esc(ui.fmtDay(m.kickoffAt))} · ${esc(ui.fmtTime(m.kickoffAt))}</span>`;
  const tabs = ['overview', 'lineups']
    .map((k) => `<button class="seg ${tab === k ? 'active' : ''}" data-match-tab="${k}">${{ overview: 'Overview', lineups: 'Line-ups' }[k]}</button>`)
    .join('');

  let body;
  if (tab === 'lineups') {
    const hp = lineupFor(m, 'home');
    const ap = lineupFor(m, 'away');
    body = `<div class="lineups">
      <div class="lineups-pitch">${ui.matchPitch(m)}</div>
      <div class="lineups-subs card">
        ${m.lineups ? '' : '<p class="note">Predicted line-ups. Confirmed at kick-off.</p>'}
        ${ui.subsList(A, ap, m, `${teamLabel(m, 'away')} subs`)}
        ${ui.subsList(H, hp, m, `${teamLabel(m, 'home')} subs`)}
        ${[H, A].filter((x) => x?.coach).map((x) => `<div class="coach"><span>${esc(x.name)} coach</span><b>${esc(x.coach)}</b></div>`).join('')}
      </div></div>`;
  } else {
    body = `<div class="grid-2 grid-2--wide">
      <div class="card">${timeline(m)}</div>
      <div class="card info">
        <h4>Match info</h4>
        <dl>
          <dt>${icon.whistle} Referee</dt><dd>${esc(m.referee || 'To be confirmed')}</dd>
          <dt>${icon.clock} Kick-off</dt><dd>${esc(ui.fmtLongDay(m.kickoffAt))}, ${esc(ui.fmtTime(m.kickoffAt))}</dd>
          ${t.venue ? `<dt>${icon.pin} Venue</dt><dd>${esc(t.venue)}${(t.courts || 1) > 1 ? ` · Court ${esc(m.court)}` : ''}</dd>` : ''}
          <dt>Stage</dt><dd>${esc(ui.stageLabel(m))}</dd>
          <dt>Duration</dt><dd>2 × ${esc((m.matchMinutes || t.matchMinutes || 20) / 2)} min</dd>
        </dl>
        ${matchStats(m)}
      </div></div>`;
  }
  return `
    <section class="mc" style="--hc:${ui.teamColor(H)};--ac:${ui.teamColor(A)}">
      <a class="back" href="#/fixtures">← Fixtures</a>
      <div class="mc-stage">${esc(ui.stageLabel(m))}${m.referee ? ` · ${icon.whistle} ${esc(m.referee)}` : ''}</div>
      <div class="mc-row">
        <a class="mc-team" ${H ? `href="#/team/${esc(H.id)}"` : ''}>${crest(H, 72)}<b>${esc(teamLabel(m, 'home'))}</b></a>
        <div class="mc-mid">
          ${started ? `<div class="mc-score" data-score="${esc(m.id)}">${h}<i>–</i>${a}</div>` : `<div class="mc-score mc-score--ko">${esc(ui.fmtTime(m.kickoffAt))}</div>`}
          ${m.shootout && (m.shootout.home || m.shootout.away) ? `<div class="pens">${m.shootout.home}–${m.shootout.away} on penalties</div>` : ''}
          <div class="mc-status">${status}</div>
        </div>
        <a class="mc-team" ${A ? `href="#/team/${esc(A.id)}"` : ''}>${crest(A, 72)}<b>${esc(teamLabel(m, 'away'))}</b></a>
      </div>
      ${started ? `<div class="mc-scorers"><ul>${scorersLine(m, 'home')}</ul><span>${icon.ball}</span><ul>${scorersLine(m, 'away')}</ul></div>` : ''}
    </section>
    <div class="segs">${tabs}</div>
    ${body}`;
}

function matchStats(m) {
  const count = (type, teamId) => (m.events || []).filter((e) => e.type === type && e.teamId === teamId).length;
  const { h, a } = scoreOf(m);
  const rows = [
    ['Goals', h, a],
    ['Yellow cards', count('yellow', m.homeId), count('yellow', m.awayId)],
    ['Red cards', count('red', m.homeId), count('red', m.awayId)],
    ['Substitutions', count('sub', m.homeId), count('sub', m.awayId)],
  ];
  const H = state.teamMap[m.homeId];
  const A = state.teamMap[m.awayId];
  return `<h4>Match stats</h4><div class="mstats" style="--hc:${ui.teamColor(H)};--ac:${ui.teamColor(A)}">${rows
    .map(([k, x, y]) => {
      const tot = x + y || 1;
      return `<div class="mstat"><span>${x}</span><em>${k}</em><span>${y}</span><div class="mbar"><i style="width:${(x / tot) * 100}%;background:var(--hc)"></i><i style="width:${(y / tot) * 100}%;background:var(--ac)"></i></div></div>`;
    })
    .join('')}</div>`;
}

function timeline(m) {
  const idx = playerIndex();
  const evs = (m.events || []).slice().sort((x, y) => (y.minute || 0) - (x.minute || 0) || (y.at || 0) - (x.at || 0));
  if (m.status === 'scheduled') return `<h4>Timeline</h4><p class="muted">The timeline will appear here once the match kicks off.</p>`;
  const items = [];
  if (m.status === 'ft') items.push(`<li class="tl-mark">Full-time</li>`);
  let htShown = !(m.period === '2H' || m.status === 'ft');
  for (const e of evs) {
    if (!htShown && e.period !== '2H') {
      items.push(`<li class="tl-mark">Half-time</li>`);
      htShown = true;
    }
    const side = e.teamId === m.homeId ? 'home' : 'away';
    const P = idx[e.playerId];
    let main = esc(playerName(P));
    let sub = '';
    if (e.type === 'goal') {
      if (!e.playerId) main = 'Goal';
      if (e.pen) main += ' <small>(pen)</small>';
      if (e.assistId) sub = `Assist: ${esc(playerName(idx[e.assistId]))}`;
    } else if (e.type === 'own_goal') {
      main += ' <small>(OG)</small>';
    } else if (e.type === 'sub') {
      main = `<span class="in">${icon.subOn} ${esc(playerName(P))}</span>`;
      sub = `<span class="out">${icon.subOff} ${esc(playerName(idx[e.playerOutId]))}</span>`;
    } else if (e.type === 'yellow') sub = 'Yellow card';
    else if (e.type === 'red') sub = 'Red card';
    const goalish = e.type === 'goal' || e.type === 'own_goal';
    items.push(`<li class="tl tl--${side} ${goalish ? 'tl--goal' : ''}"><span class="tl-min">${esc(minuteText(e))}</span>
      <span class="tl-body"><span class="tl-ico">${ui.eventIcon(e.type)}</span><span><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</span></span></li>`);
  }
  if (!htShown) items.push(`<li class="tl-mark">Half-time</li>`);
  items.push(`<li class="tl-mark">Kick-off</li>`);
  const H = state.teamMap[m.homeId];
  const A = state.teamMap[m.awayId];
  return `<h4>Timeline</h4><div class="tl-head"><span>${crest(H, 20)} ${esc(teamLabel(m, 'home'))}</span><span>${esc(teamLabel(m, 'away'))} ${crest(A, 20)}</span></div><ul class="timeline">${items.join('')}</ul>`;
}

function stats(t) {
  const L = leaders();
  return `
    <div class="pagehead"><h1>Stats</h1><p>${esc(t.name)}</p></div>
    <div class="grid-3">
      <div>${sectionHead('Goals')}<div class="card card--flush">${leaderList(L.scorers.slice(0, 15), 'goals')}</div></div>
      <div>${sectionHead('Assists')}<div class="card card--flush">${leaderList(L.assists.slice(0, 15), 'assists')}</div></div>
      <div>${sectionHead('Discipline')}<div class="card card--flush">${leaderList(L.discipline.slice(0, 15), 'cards')}</div></div>
    </div>`;
}

// ---------------- events ----------------
document.addEventListener('click', (e) => {
  const ft = e.target.closest('[data-fixtures-team]');
  if (ft) {
    ui_state.fixturesTeam = ft.dataset.fixturesTeam;
    render();
  }
  const tt = e.target.closest('[data-team-tab]');
  if (tt) {
    ui_state.teamTab = tt.dataset.teamTab;
    render();
  }
  const mt = e.target.closest('[data-match-tab]');
  if (mt) {
    ui_state.matchTab = mt.dataset.matchTab;
    render();
  }
});

document.getElementById('tournament-select')?.addEventListener('change', (e) => {
  ui_state.fixturesTeam = 'all';
  selectTournament(e.target.value);
});

window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/team/')) ui_state.teamTab = 'squad';
  render();
});
subscribe(render);
setInterval(tick, 1000);
document.getElementById('brand-name').textContent = SITE_NAME;
start();
render();
