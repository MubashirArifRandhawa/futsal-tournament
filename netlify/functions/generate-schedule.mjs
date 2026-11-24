// POST /api/generate-schedule
// Asks Gemini (free tier) to plan the fixtures, then checks the answer.
// Times are always recomputed here, and if Gemini is unavailable or returns
// an invalid plan, the built-in round-robin scheduler is used instead, so the
// admin always gets a usable schedule.
//
// Netlify environment variables:
//   GEMINI_API_KEY       required  – free key from https://aistudio.google.com/apikey
//   FIREBASE_PROJECT_ID  recommended – only signed-in admins may call this function
//   GEMINI_MODEL         optional  – comma-separated list, tried in order
import { cleanInput, buildFallbackSchedule, normalizeAiPlan, validatePlan, FORMATS } from '../../public/js/scheduler.js';

const MODELS = (process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.1-flash-lite')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BUDGET_MS = 9000; // stay inside Netlify's default 10 s function limit

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    matchMinutes: { type: 'INTEGER', description: 'Total playing minutes per match (two equal halves). Even number.' },
    summary: { type: 'STRING', description: 'One to three sentences explaining the schedule for the organiser.' },
    matches: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          slot: { type: 'INTEGER', description: 'Time slot number starting at 1. Matches in the same slot run at the same time on different courts.' },
          round: { type: 'INTEGER', description: 'Matchday number starting at 1.' },
          stage: { type: 'STRING', enum: ['league', 'final'] },
          homeTeam: { type: 'STRING', description: 'Team key such as T1. Empty for the final.' },
          awayTeam: { type: 'STRING', description: 'Team key such as T2. Empty for the final.' },
        },
        required: ['slot', 'round', 'stage', 'homeTeam', 'awayTeam'],
      },
    },
  },
  required: ['matches', 'summary'],
};

function prompt(input, previousErrors) {
  const teams = input.teams.map((t) => `${t.key} = ${t.name}`).join('\n');
  const n = input.teams.length;
  const leagueMatches = ((n * (n - 1)) / 2) * (input.format === 'double' ? 2 : 1);
  return `Plan a 5-a-side futsal tournament.

Teams (use the keys T1, T2… in your answer):
${teams}

Format: ${FORMATS[input.format]}
League matches required: ${leagueMatches}${input.format === 'league_final' ? ' plus 1 final (stage "final", empty team keys, in the very last slot)' : ''}
Courts available: ${input.courts} (at most ${input.courts} match(es) per slot; a team can never appear twice in one slot)
Total time available: ${input.totalMinutes} minutes, including ${input.halftimeMinutes} min half-time per match and ${input.breakMinutes} min between slots.
${
  input.matchMinutes
    ? `Match length is fixed at ${input.matchMinutes} minutes.`
    : `Choose matchMinutes: the longest even number of minutes (max 40) so that slots × (matchMinutes + ${input.halftimeMinutes}) + (slots − 1) × ${input.breakMinutes} ≤ ${input.totalMinutes}.`
}

Rules:
- ${input.format === 'double' ? 'Every pair of teams meets exactly twice, once at each team\'s "home".' : 'Every pair of teams meets exactly once.'}
- Spread games so no team plays in two consecutive slots whenever that is possible, and give every team similar rest.
- Balance home and away appearances for each team.
- Group matches into matchdays (rounds) so each team plays at most once per round.
- Number slots 1, 2, 3… in playing order.
${previousErrors?.length ? `\nYour previous answer had these problems, fix them:\n- ${previousErrors.join('\n- ')}` : ''}`;
}

async function callGemini(model, key, text, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const generationConfig = { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA };
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are an expert futsal tournament scheduler. Reply with JSON only, matching the schema exactly.' }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig,
      }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return JSON.parse(out);
  } finally {
    clearTimeout(timer);
  }
}

/** Only signed-in admins may spend the Gemini quota. Firestore itself checks the
 * ID token and the rule `admins/{uid}` readable only by that uid. */
async function checkAdmin(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return { ok: true, skipped: true };
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return { ok: false, error: 'Sign in as an admin first.' };
  let uid;
  try {
    uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).user_id;
  } catch {
    return { ok: false, error: 'Invalid sign-in token.' };
  }
  if (!uid) return { ok: false, error: 'Invalid sign-in token.' };
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return r.ok ? { ok: true } : { ok: false, error: 'This account is not an admin.' };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const started = Date.now();

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const input = cleanInput(body);
  if (input.teams.length < 2) return json({ error: 'Add at least two teams.' }, 400);

  const authz = await checkAdmin(req).catch((e) => ({ ok: false, error: e.message }));
  if (!authz.ok) return json({ error: authz.error }, 401);

  const fallback = (why) => {
    const p = buildFallbackSchedule(input);
    return json({ ...p, source: 'fallback', model: '', warnings: [why, ...p.warnings].filter(Boolean) });
  };

  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallback('GEMINI_API_KEY is not set in Netlify, so the built-in scheduler was used.');

  let errors = [];
  let lastErr = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left < 2500) return fallback(`Gemini ran out of time${lastErr ? ` (${lastErr})` : ''}; the built-in scheduler was used.`);
      try {
        const raw = await callGemini(model, key, prompt(input, errors), left - 500);
        const plan = normalizeAiPlan(raw, input);
        errors = validatePlan(plan, input);
        if (!errors.length) return json({ ...plan, source: 'gemini', model });
        lastErr = `invalid plan: ${errors[0]}`;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? 'timed out' : e.message;
        // quota / unknown model / overloaded → try the next model
        if ([404, 429, 500, 503].includes(e.status) || e.name === 'AbortError') break;
      }
    }
  }
  return fallback(`Gemini could not produce a valid schedule (${lastErr}); the built-in scheduler was used.`);
};

export const config = { path: '/api/generate-schedule' };
