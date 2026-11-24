// Pure scheduling helpers. No browser or Node APIs, so this file is shared by
// the website (fallback when the AI is unavailable) and the Netlify function
// that talks to Gemini.

export const FORMATS = {
  league: 'Single round-robin (everyone plays everyone once)',
  league_final: 'Round-robin + Final (1st vs 2nd)',
  double: 'Double round-robin (everyone plays everyone twice)',
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

export function cleanInput(input = {}) {
  const teams = (input.teams || [])
    .map((t, i) => ({ key: String(t.key || `T${i + 1}`), name: String(t.name || `Team ${i + 1}`).slice(0, 60) }))
    .slice(0, 16);
  return {
    teams,
    format: FORMATS[input.format] ? input.format : 'league',
    totalMinutes: clampInt(input.totalMinutes, 10, 24 * 60, 180),
    matchMinutes: input.matchMinutes ? clampInt(input.matchMinutes, 4, 90, null) : null,
    halftimeMinutes: clampInt(input.halftimeMinutes, 0, 15, 2),
    breakMinutes: clampInt(input.breakMinutes, 0, 60, 5),
    courts: clampInt(input.courts, 1, 4, 1),
    startAt: input.startAt || null,
  };
}

/** Circle-method round robin. Returns rounds -> [homeKey, awayKey][] */
export function roundRobin(keys) {
  const ids = [...keys];
  if (ids.length % 2) ids.push(null); // bye
  const n = ids.length;
  const rounds = [];
  let arr = ids.slice();
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a && b) pairs.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return rounds;
}

/** Pack matches into time slots (one match per court per slot), trying to give
 * every team a rest between games. */
export function packSlots(list, courts = 1) {
  const remaining = list.slice();
  const slots = [];
  let prev = new Set();
  while (remaining.length) {
    const slot = [];
    const busy = new Set();
    const fits = (m, avoidPrev) =>
      !busy.has(m.home) && !busy.has(m.away) && (!avoidPrev || (!prev.has(m.home) && !prev.has(m.away)));
    for (const avoidPrev of [true, false]) {
      for (let i = 0; i < remaining.length && slot.length < courts; i++) {
        const m = remaining[i];
        // only look one round ahead so the order stays roughly by matchday
        if (m.round > remaining[0].round + 1) break;
        if (fits(m, avoidPrev)) {
          slot.push(m);
          busy.add(m.home);
          busy.add(m.away);
          remaining.splice(i, 1);
          i--;
        }
      }
      if (slot.length >= courts) break;
    }
    if (!slot.length) slot.push(remaining.shift());
    slots.push(slot);
    prev = new Set(slot.flatMap((m) => [m.home, m.away]));
  }
  return slots;
}

/** Work out match length and the time each slot needs. */
export function timing(input, slots) {
  const { totalMinutes, halftimeMinutes: ht, breakMinutes: br } = input;
  const warnings = [];
  let mm = input.matchMinutes;
  if (!mm) {
    const avail = totalMinutes - (slots - 1) * br - slots * ht;
    mm = Math.floor(avail / slots);
    if (mm % 2) mm -= 1;
    mm = Math.min(mm, 40);
    if (mm < 4) {
      mm = 4;
      warnings.push('The total time is very tight, so matches were set to the 4-minute minimum.');
    }
  }
  const slotLen = mm + ht + br;
  const totalNeeded = slots * (mm + ht) + Math.max(0, slots - 1) * br;
  if (totalNeeded > totalMinutes) {
    warnings.push(
      `This schedule needs ${totalNeeded} minutes, which is ${totalNeeded - totalMinutes} more than the ${totalMinutes} available. Shorten matches or breaks, or add a court.`
    );
  }
  return { matchMinutes: mm, halftimeMinutes: ht, breakMinutes: br, slotLen, totalNeeded, warnings };
}

function finalizePlan(slots, input, extra = {}) {
  const t = timing(input, slots.length);
  const matches = slots.flatMap((slot, si) =>
    slot.map((m, ci) => ({
      round: m.round,
      slot: si + 1,
      court: ci + 1,
      stage: m.stage || 'league',
      home: m.home || null,
      away: m.away || null,
      homeLabel: m.homeLabel || '',
      awayLabel: m.awayLabel || '',
      startOffsetMinutes: si * t.slotLen,
    }))
  );
  return {
    matchMinutes: t.matchMinutes,
    halftimeMinutes: t.halftimeMinutes,
    breakMinutes: t.breakMinutes,
    totalNeeded: t.totalNeeded,
    matches,
    summary: extra.summary || '',
    warnings: [...(extra.warnings || []), ...t.warnings],
  };
}

function leagueList(input) {
  const keys = input.teams.map((t) => t.key);
  let rounds = roundRobin(keys);
  if (input.format === 'double') rounds = rounds.concat(rounds.map((r) => r.map(([a, b]) => [b, a])));
  return { rounds, list: rounds.flatMap((r, ri) => r.map(([home, away]) => ({ round: ri + 1, home, away, stage: 'league' }))) };
}

function finalMatch(round) {
  return { round, home: null, away: null, stage: 'final', homeLabel: '1st place', awayLabel: '2nd place' };
}

/** Deterministic schedule, used when Gemini is not reachable or returns something invalid. */
export function buildFallbackSchedule(rawInput) {
  const input = cleanInput(rawInput);
  const { rounds, list } = leagueList(input);
  const slots = packSlots(list, input.courts);
  if (input.format === 'league_final') slots.push([finalMatch(rounds.length + 1)]);
  const plan = finalizePlan(slots, input, {
    summary: `${list.length} league matches over ${rounds.length} matchdays${
      input.format === 'league_final' ? ', then a final between the top two' : ''
    }. Teams are rested between games wherever possible.`,
  });
  return plan;
}

/** Turn Gemini's answer into the same shape as the fallback, recomputing all
 * times ourselves so the arithmetic is always right. */
export function normalizeAiPlan(raw, rawInput) {
  const input = cleanInput(rawInput);
  const lookup = new Map();
  input.teams.forEach((t) => {
    lookup.set(t.key.toLowerCase(), t.key);
    lookup.set(t.name.toLowerCase(), t.key);
  });
  const find = (v) => (v == null ? null : lookup.get(String(v).trim().toLowerCase()) || null);

  let ms = (Array.isArray(raw?.matches) ? raw.matches : []).map((m, i) => ({
    idx: i,
    slotHint: Number(m.slot) || i + 1,
    offset: Number(m.startOffsetMinutes) || 0,
    round: Number(m.round) || 1,
    stage: m.stage === 'final' ? 'final' : 'league',
    home: find(m.homeTeam ?? m.home),
    away: find(m.awayTeam ?? m.away),
  }));
  if (input.format !== 'league_final') ms = ms.filter((m) => m.stage !== 'final');
  ms.sort((a, b) => a.slotHint - b.slotHint || a.offset - b.offset || a.idx - b.idx);

  // group by the slot Gemini chose; split any slot that breaks court/team rules
  const slots = [];
  let current = null;
  let currentHint = null;
  for (const m of ms) {
    if (m.stage === 'final') {
      slots.push([{ ...finalMatch(m.round) }]);
      current = null;
      continue;
    }
    const clash = current && (current.length >= input.courts || current.some((x) => [x.home, x.away].some((k) => k === m.home || k === m.away)));
    if (!current || m.slotHint !== currentHint || clash) {
      current = [];
      currentHint = m.slotHint;
      slots.push(current);
    }
    current.push({ round: m.round, home: m.home, away: m.away, stage: 'league' });
  }
  // keep finals last
  const finals = slots.filter((s) => s[0]?.stage === 'final');
  const league = slots.filter((s) => s[0]?.stage !== 'final');
  if (input.format === 'league_final' && !finals.length) {
    finals.push([finalMatch(Math.max(1, ...league.flat().map((m) => m.round)) + 1)]);
  }
  const ordered = league.concat(finals.slice(0, 1));

  let mm = input.matchMinutes;
  const warnings = [];
  const aiMM = Number(raw?.matchMinutes);
  if (!mm && Number.isFinite(aiMM) && aiMM >= 4 && aiMM <= 40) {
    const t = timing({ ...input, matchMinutes: Math.round(aiMM / 2) * 2 }, ordered.length);
    if (t.totalNeeded <= input.totalMinutes) mm = Math.round(aiMM / 2) * 2;
    else warnings.push(`Gemini suggested ${aiMM}-minute matches, which would overrun, so the length was recalculated.`);
  }
  return finalizePlan(ordered, { ...input, matchMinutes: mm }, {
    summary: String(raw?.summary || '').slice(0, 600),
    warnings,
  });
}

/** Check a plan covers every fixture exactly the right number of times. */
export function validatePlan(plan, rawInput) {
  const input = cleanInput(rawInput);
  const errors = [];
  const keys = new Set(input.teams.map((t) => t.key));
  const need = new Map();
  const per = input.format === 'double' ? 2 : 1;
  const list = [...keys];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) need.set([list[i], list[j]].sort().join('|'), per);

  const seen = new Map();
  const slotTeams = new Map();
  for (const m of plan.matches || []) {
    if (m.stage === 'final') continue;
    if (!keys.has(m.home) || !keys.has(m.away)) {
      errors.push(`Unknown team in a match (${m.home} vs ${m.away}).`);
      continue;
    }
    if (m.home === m.away) errors.push(`A team was drawn against itself (${m.home}).`);
    const k = [m.home, m.away].sort().join('|');
    seen.set(k, (seen.get(k) || 0) + 1);
    const st = slotTeams.get(m.slot) || new Set();
    if (st.has(m.home) || st.has(m.away)) errors.push(`A team plays twice at the same time in slot ${m.slot}.`);
    st.add(m.home);
    st.add(m.away);
    slotTeams.set(m.slot, st);
  }
  for (const [k, n] of need) {
    const got = seen.get(k) || 0;
    if (got !== n) errors.push(`${k.replace('|', ' vs ')} appears ${got} time(s), expected ${n}.`);
  }
  for (const [k] of seen) if (!need.has(k)) errors.push(`Unexpected fixture ${k.replace('|', ' vs ')}.`);
  if (input.format === 'league_final' && !(plan.matches || []).some((m) => m.stage === 'final')) errors.push('The final is missing.');
  return errors;
}
