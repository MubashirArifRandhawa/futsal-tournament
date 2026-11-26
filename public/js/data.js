// Realtime data store. Every view reads from `state`; Firestore snapshot
// listeners keep it current, so pages update without a refresh.
import { db, configured, doc, collection, onSnapshot } from './firebase.js';

export const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

export const state = {
  configured,
  config: null,
  tournaments: [],
  tid: null,
  pinned: false, // true once a visitor picks a tournament themselves
  teams: [],
  teamMap: {},
  matches: [],
  loaded: { config: false, tournaments: false, teams: false, matches: false },
  error: null,
};

const listeners = new Set();
let emitTimer = null;
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => listeners.forEach((fn) => fn(state)), 0);
}

const onErr = (e) => {
  console.error(e);
  state.error = e?.code === 'permission-denied' ? 'Firestore refused access. Check that firestore.rules are published.' : e?.message || String(e);
  emit();
};

let unsubTeams = null;
let unsubMatches = null;

export function start() {
  if (!configured) {
    emit();
    return;
  }
  onSnapshot(
    doc(db, 'config', 'site'),
    (snap) => {
      state.config = snap.exists() ? snap.data() : {};
      state.loaded.config = true;
      autoSelect();
      emit();
    },
    onErr
  );
  onSnapshot(
    collection(db, 'tournaments'),
    (snap) => {
      state.tournaments = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      state.loaded.tournaments = true;
      autoSelect();
      emit();
    },
    onErr
  );
}

function autoSelect() {
  if (!state.loaded.config || !state.loaded.tournaments) return;
  const exists = (id) => state.tournaments.some((t) => t.id === id);
  if (state.pinned && exists(state.tid)) return;
  const want = exists(state.config?.activeTournamentId) ? state.config.activeTournamentId : state.tournaments[0]?.id || null;
  if (want !== state.tid) selectTournament(want, false);
}

export function selectTournament(id, pin = true) {
  if (pin) state.pinned = true;
  if (id === state.tid && unsubTeams) return;
  unsubTeams?.();
  unsubMatches?.();
  unsubTeams = unsubMatches = null;
  state.tid = id;
  state.teams = [];
  state.teamMap = {};
  state.matches = [];
  state.loaded.teams = state.loaded.matches = !id;
  if (!id) return emit();
  unsubTeams = onSnapshot(
    collection(db, 'tournaments', id, 'teams'),
    (snap) => {
      state.teams = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
      state.teamMap = Object.fromEntries(state.teams.map((t) => [t.id, t]));
      state.loaded.teams = true;
      emit();
    },
    onErr
  );
  unsubMatches = onSnapshot(
    collection(db, 'tournaments', id, 'matches'),
    (snap) => {
      state.matches = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byKickoff);
      state.loaded.matches = true;
      emit();
    },
    onErr
  );
  emit();
}

export const tournament = () => state.tournaments.find((t) => t.id === state.tid) || null;
export const isReady = () => state.loaded.config && state.loaded.tournaments && state.loaded.teams && state.loaded.matches;

export function byKickoff(a, b) {
  return (a.kickoffAt || 0) - (b.kickoffAt || 0) || (a.slot || 0) - (b.slot || 0) || (a.court || 0) - (b.court || 0);
}

// ---------- derived data ----------

export function scoreOf(m) {
  let h = 0;
  let a = 0;
  for (const e of m.events || []) {
    if (e.type === 'goal') {
      if (e.teamId === m.homeId) h++;
      else if (e.teamId === m.awayId) a++;
    } else if (e.type === 'own_goal') {
      if (e.teamId === m.homeId) a++;
      else if (e.teamId === m.awayId) h++;
    }
  }
  return { h, a };
}

export const isLive = (m) => m.status === 'live';
export const isDone = (m) => m.status === 'ft';

/** Clock: elapsed ms and a football-style minute label. */
export function clockOf(m, t, now = Date.now()) {
  const c = m.clock || {};
  const elapsed = (c.elapsedMs || 0) + (c.running && c.startedAt ? Math.max(0, now - c.startedAt) : 0);
  const half = (m.matchMinutes || t?.matchMinutes || 20) / 2;
  const minute = Math.floor(elapsed / 60000) + 1;
  let label = '';
  if (m.status === 'ft') label = 'FT';
  else if (m.period === 'HT') label = 'HT';
  else if (m.status === 'live') {
    const cap = m.period === '2H' ? half * 2 : half;
    label = minute > cap ? `${cap}+${minute - cap}'` : `${minute}'`;
  }
  const mm = String(Math.floor(elapsed / 60000)).padStart(2, '0');
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  return { elapsed, minute, label, mmss: `${mm}:${ss}`, running: !!c.running };
}

export function playerName(p) {
  if (!p) return 'Unknown';
  return (p.name && p.name.trim()) || `Player ${p.number ?? ''}`.trim();
}

/** Player lookup across squads and saved match line-ups. */
export function playerIndex(teams = state.teams, matches = state.matches) {
  const idx = {};
  for (const t of teams) for (const p of t.players || []) idx[p.id] = { ...p, teamId: t.id };
  for (const m of matches)
    for (const side of ['home', 'away']) {
      const lu = m.lineups?.[side];
      const teamId = side === 'home' ? m.homeId : m.awayId;
      for (const p of lu?.players || []) if (!idx[p.id]) idx[p.id] = { ...p, teamId };
    }
  return idx;
}

export function computeStandings(teams = state.teams, matches = state.matches) {
  const rows = new Map(
    teams.map((t) => [t.id, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [], live: false }])
  );
  for (const m of matches.slice().sort(byKickoff)) {
    if ((m.stage || 'league') !== 'league') continue;
    const H = rows.get(m.homeId);
    const A = rows.get(m.awayId);
    if (!H || !A) continue;
    if (m.status === 'live') {
      H.live = A.live = true;
      continue;
    }
    if (m.status !== 'ft') continue;
    const { h, a } = scoreOf(m);
    H.p++;
    A.p++;
    H.gf += h;
    H.ga += a;
    A.gf += a;
    A.ga += h;
    if (h > a) {
      H.w++;
      A.l++;
      H.pts += 3;
      H.form.push({ r: 'W', m });
      A.form.push({ r: 'L', m });
    } else if (h < a) {
      A.w++;
      H.l++;
      A.pts += 3;
      A.form.push({ r: 'W', m });
      H.form.push({ r: 'L', m });
    } else {
      H.d++;
      A.d++;
      H.pts++;
      A.pts++;
      H.form.push({ r: 'D', m });
      A.form.push({ r: 'D', m });
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, gd: r.gf - r.ga, form: r.form.slice(-5) }))
    .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.name.localeCompare(y.team.name));
}

export function leaders(teams = state.teams, matches = state.matches) {
  const idx = playerIndex(teams, matches);
  const tally = {};
  const bump = (pid, teamId, key) => {
    if (!pid) return;
    const r = (tally[pid] ||= { player: idx[pid] || { id: pid, name: 'Unknown' }, teamId: idx[pid]?.teamId || teamId, goals: 0, assists: 0, yellow: 0, red: 0 });
    r[key]++;
  };
  for (const m of matches)
    for (const e of m.events || []) {
      if (e.type === 'goal') {
        bump(e.playerId, e.teamId, 'goals');
        bump(e.assistId, e.teamId, 'assists');
      } else if (e.type === 'yellow') bump(e.playerId, e.teamId, 'yellow');
      else if (e.type === 'red') bump(e.playerId, e.teamId, 'red');
    }
  const all = Object.values(tally);
  return {
    all,
    scorers: all.filter((r) => r.goals).sort((a, b) => b.goals - a.goals || b.assists - a.assists),
    assists: all.filter((r) => r.assists).sort((a, b) => b.assists - a.assists || b.goals - a.goals),
    discipline: all.filter((r) => r.yellow || r.red).sort((a, b) => b.red - a.red || b.yellow - a.yellow),
  };
}

/** Line-up for one side of a match: saved at kick-off, otherwise the current squad. */
export function lineupFor(m, side, teamMap = state.teamMap) {
  const saved = m.lineups?.[side];
  if (saved?.players?.length) return saved.players;
  const team = teamMap[side === 'home' ? m.homeId : m.awayId];
  return team?.players || [];
}

export function teamLabel(m, side, teamMap = state.teamMap) {
  const t = teamMap[side === 'home' ? m.homeId : m.awayId];
  return t ? t.name : (side === 'home' ? m.homeLabel : m.awayLabel) || 'TBD';
}

// ---------- rewards ----------
// `link` ties a reward to a live result so the site can show who holds it:
// champion | runnerup | topscorer | topassist | '' (organiser fills `winner`).
export const DEFAULT_REWARDS = [
  { title: 'Champions', prize: "Winners' trophy + gold medals", link: 'champion', winner: '' },
  { title: 'Runners-up', prize: 'Silver medals', link: 'runnerup', winner: '' },
  { title: 'Golden Boot', prize: 'Top scorer award', link: 'topscorer', winner: '' },
  { title: 'Best Goalkeeper', prize: 'Individual award', link: '', winner: '' },
  { title: 'Player of the Tournament', prize: 'Individual award', link: '', winner: '' },
];
export const REWARD_LINKS = { champion: 'Champions (auto)', runnerup: 'Runners-up (auto)', topscorer: 'Top scorer (auto)', topassist: 'Most assists (auto)', '': 'Chosen by organiser' };
export const rewardsOf = (t) => (Array.isArray(t?.rewards) ? t.rewards : DEFAULT_REWARDS);

/** Minute label for an event; quick-entered results may have no minute. */
export const minuteText = (e) => (e?.minute == null || e.minute === '' ? '' : `${e.minute}'`);
