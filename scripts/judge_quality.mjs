// Quality grader — uses GPT-4o (OpenAI) as a third-party judge of the
// shipped product. Boots the server in-process, fetches the rendered HTML
// of a handful of key surfaces, then asks the model to score each on:
//   • UX clarity        (is the page intuitive at first glance?)
//   • Information density (right amount of detail, no clutter?)
//   • Bilingual quality (AR + EN both first-class?)
//   • Production readiness (would I ship this to a national portal?)
//
// Output is a JSON report with per-surface scores 0–100 + a 1-line review
// + a single overall verdict. We pull the ENTIRE rendered HTML (including
// inline JS that paints from the API responses) so the model sees the
// real page, not just a static snapshot.
//
// Required env: OPENAI_API_KEY (loaded from .env via dotenv).

import 'dotenv/config';
process.env.SANAD_NO_AUTOSTART = 'true';
process.env.SANAD_SKIP_SLA = 'true';
process.env.DEBUG_MODE = 'true';

if (!process.env.OPENAI_API_KEY) {
  console.error('✗ OPENAI_API_KEY missing from .env'); process.exit(1);
}

const { start } = await import('../server.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[judge] server on ${port}`);

const SURFACES = [
  { id: 'home',       url: '/',                       focus: 'public landing page — first 60-second impression' },
  { id: 'catalogue',  url: '/catalogue.html',         focus: 'searchable service catalogue (601 services, hybrid search)' },
  { id: 'apply',      url: '/apply.html?service=1',   focus: 'form-based apply page (file upload, ministry-grade form)' },
  { id: 'request',    url: '/request.html?id=1',      focus: 'citizen-side request tracker with timeline + live polling' },
  { id: 'account',    url: '/account.html',           focus: 'citizen dashboard (auth-gated; expect login redirect)' },
  { id: 'officer',    url: '/officer.html',           focus: 'office dashboard (auth-gated)' },
  { id: 'brochure',   url: '/brochure.html',          focus: 'ministry pitch brochure (AR + EN bilingual)' }
];

async function fetchSurface(s) {
  try {
    const r = await fetch(`${base}${s.url}`, { redirect: 'manual' });
    const text = await r.text();
    // Trim — GPT-4o has a 128k context window but a Saned page is rich enough
    // that a 30k cap keeps the prompt sane and the cost low. Capture HEAD +
    // BODY START + BODY END so the model sees branding, layout intent, and
    // any inline JS contracts that drive UX.
    const trimmed = text.length > 30_000
      ? text.slice(0, 18_000) + '\n\n…[trimmed mid]…\n\n' + text.slice(-12_000)
      : text;
    return { id: s.id, url: s.url, focus: s.focus, status: r.status, html: trimmed };
  } catch (e) {
    return { id: s.id, url: s.url, focus: s.focus, error: e.message };
  }
}

async function judge(payload) {
  const prompt = `You are a senior product/design reviewer evaluating a national-government services platform built for the Sultanate of Oman. The product, "Saned" (ساند), is a marketplace where Omani citizens prepare government-service requests via web or WhatsApp; licensed Sanad offices fulfil them.

You are reviewing the rendered HTML of one surface. Score 0–100 on each axis below, then give a one-line review + an overall verdict.

Axes:
1. ux_clarity — is intent obvious in <10 seconds? Are CTAs unambiguous?
2. info_density — right amount of detail; not bare, not cluttered.
3. bilingual_quality — AR + EN both first-class? RTL layout correct? No untranslated keys?
4. production_ready — would this clear a Ministry-of-Commerce review?

Surface: ${payload.id}
URL: ${payload.url}
Focus: ${payload.focus}
HTTP status: ${payload.status}

HTML:
\`\`\`html
${payload.html}
\`\`\`

Respond ONLY with strict JSON:
{
  "ux_clarity": 0-100,
  "info_density": 0-100,
  "bilingual_quality": 0-100,
  "production_ready": 0-100,
  "overall": 0-100,
  "review": "one-sentence assessment",
  "biggest_strength": "one phrase",
  "biggest_concern": "one phrase or null if none"
}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a strict product reviewer. Respond ONLY with valid JSON. Be honest, not flattering.' },
        { role: 'user',   content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`openai ${r.status}: ${t.slice(0,200)}`);
  }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '{}';
  return JSON.parse(text);
}

try {
  const results = [];
  for (const s of SURFACES) {
    process.stdout.write(`  ${s.id.padEnd(11)} → fetching… `);
    const payload = await fetchSurface(s);
    if (payload.error) {
      console.log(`✗ ${payload.error}`);
      results.push({ ...payload, error: payload.error });
      continue;
    }
    process.stdout.write('grading… ');
    try {
      const grade = await judge(payload);
      results.push({ id: s.id, url: s.url, focus: s.focus, status: payload.status, grade });
      console.log(`${grade.overall}/100 — ${grade.review.slice(0, 80)}${grade.review.length > 80 ? '…' : ''}`);
    } catch (e) {
      console.log(`✗ judge failed: ${e.message}`);
      results.push({ id: s.id, url: s.url, focus: s.focus, error: e.message });
    }
  }

  // Aggregate
  const graded = results.filter(r => r.grade);
  const avg = (k) => Math.round(graded.reduce((a, r) => a + (r.grade[k] || 0), 0) / graded.length);
  const avgScores = {
    ux_clarity:        avg('ux_clarity'),
    info_density:      avg('info_density'),
    bilingual_quality: avg('bilingual_quality'),
    production_ready:  avg('production_ready'),
    overall:           avg('overall')
  };

  console.log('\n──────────────── QUALITY REPORT ────────────────');
  console.log(`Surfaces graded: ${graded.length}/${SURFACES.length}`);
  console.log('Averages:');
  for (const [k, v] of Object.entries(avgScores)) {
    const bar = '█'.repeat(Math.round(v / 5)) + '░'.repeat(20 - Math.round(v / 5));
    console.log(`  ${k.padEnd(20)} ${v.toString().padStart(3)}/100  ${bar}`);
  }
  console.log('\nPer-surface:');
  for (const r of graded) {
    console.log(`  ${r.id.padEnd(11)} ${r.grade.overall.toString().padStart(3)}/100`);
    console.log(`              ${r.grade.review}`);
    console.log(`              + ${r.grade.biggest_strength}`);
    if (r.grade.biggest_concern && r.grade.biggest_concern !== 'null') console.log(`              − ${r.grade.biggest_concern}`);
  }

  // Write JSON to disk so it can be diffed across runs
  const fs = await import('fs');
  const path = await import('path');
  const out = path.join(process.cwd(), 'data', 'quality_report.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ timestamp: new Date().toISOString(), avgScores, results: graded }, null, 2));
  console.log(`\n✓ Full report saved to ${out}`);

  process.exitCode = avgScores.overall >= 75 ? 0 : 1;
} finally {
  server.close();
}
