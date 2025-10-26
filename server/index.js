// server/index.js — complete file (drop-in)
// Kind + concise chatbot with safe fallback and model auto-retry.

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Load data ----------
const DATA_JSON  = path.resolve(process.cwd(), '../data/towns.json');
const INDEX_JSON = path.resolve(process.cwd(), '../data/index.json'); // not required for keyword flow

const data  = fs.existsSync(DATA_JSON)  ? JSON.parse(fs.readFileSync(DATA_JSON,  'utf-8')) : [];
const index = fs.existsSync(INDEX_JSON) ? JSON.parse(fs.readFileSync(INDEX_JSON, 'utf-8')) : [];

console.log(`Loaded data items: ${data.length}, index entries: ${index.length}`);

// ---------- Gemini init with auto-retry ----------
let genAI = null;
let chatModel = null;
let currentModelName = process.env.MODEL_NAME || 'gemini-2.0-flash';

function initModel(name) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  chatModel = genAI.getGenerativeModel({ model: name });
  currentModelName = name;
  console.log(`Gemini model set to: ${name}`);
}

try {
  initModel(currentModelName);
} catch (e) {
  console.warn('Gemini init warning:', e?.message || e);
  try { initModel('gemini-2.0-flash'); } catch {}
}

async function generateWithRetry(prompt) {
  if (!chatModel) throw new Error('Gemini model not initialized');
  try {
    const result = await chatModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}]
    });
    return result.response.text();
  } catch (err) {
    const msg = err?.statusText || err?.message || '';
    const isNotFound = /not\s*found|404/i.test(msg);
    if (isNotFound && currentModelName !== 'gemini-2.0-flash') {
      console.warn(`Model ${currentModelName} not found; retrying with gemini-2.0-flash…`);
      initModel('gemini-2.0-flash');
      const result = await chatModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }]}]
      });
      return result.response.text();
    }
    throw err;
  }
}

// ---------- Retrieval (keyword-based) ----------
function keywordRetrieve(question, townPref) {
  const tokens = (question || '').toLowerCase().split(/\s+/).filter(Boolean);
  const tp = (townPref || '').toLowerCase();

  const scored = [];
  for (const d of data) {
    const hay = [d.town, d.category, d.name, d.address, d.notes].filter(Boolean).join(' ').toLowerCase();
    const townOk = !tp || (d.town || '').toLowerCase().includes(tp);
    if (!townOk) continue;

    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score > 0) scored.push({ item: d, score });
  }
  if (!scored.length) {
    const fallback = data.filter(d => !tp || (d.town || '').toLowerCase().includes(tp)).slice(0, 2);
    return fallback.map(it => ({ item: it, score: 1 }));
  }
  return scored.sort((a,b)=>b.score-a.score).slice(0, 2);
}

// ---------- Deterministic paragraph fallback ----------
function writeFallbackParagraph(scored, question, townPref) {
  if (!scored.length) {
    return `I couldn’t find a match${townPref ? ` in ${townPref}` : ''}. Please try a different town or category, or use the links in the sources below.`;
  }
  const it = scored[0].item;
  const parts = [];
  parts.push(`${it.name} serves ${it.town}.`);
  if (it.notes) parts.push(it.notes);
  if (it.hours) parts.push(`Hours: ${it.hours}.`);
  if (it.address) parts.push(`Address: ${it.address}.`);
  parts.push(`Phone: ${it.phone || 'N/A'}.`);
  if (it.url) parts.push(`More info: ${it.url}`);
  return parts.join(' ');
}

// ---------- Guardrails + Prompt ----------
function buildPrompt(question, townPref, scored) {
  const guardrails = `
You are a warm, calm assistant for seniors and caregivers.
Be very kind, simple, and concise — reply with 2–4 short sentences in plain language.
Only use phone numbers, addresses, hours, and links that appear in the "Local Directory" below.
If a detail is missing, say you don't have it and suggest visiting the provided link.
Do not ask to open websites. If the user states an emergency, advise calling 911.
  `.trim();

  const contextLines = scored.map(s => {
    const it = s.item;
    return `- [${it.category}] ${it.name || '(name not provided)'} — Phone: ${it.phone || 'N/A'}; `
      + `${it.address ? `Address: ${it.address}; ` : ''}`
      + `Hours: ${it.hours || 'N/A'}; Area: ${(it.area||[]).join(', ')}; `
      + `${it.url ? `Link: ${it.url}; ` : ''}${it.notes ? `Notes: ${it.notes}` : ''}`;
  }).join('\n');

  return `
${guardrails}

User question: """${question}"""
${townPref ? `Preferred town: ${townPref}` : ''}

Local Directory:
${contextLines || '(no matches)'}
Write a short **paragraph** (not a list). Mention up to 2 relevant services. Avoid repeating the exact same phrasing each time.
`.trim();
}

// ---------- Routes ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, data: data.length, index: index.length, model: currentModelName });
});

app.post('/api/ask', async (req, res) => {
  try {
    const { question, townPref } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Missing question' });
    if (!data.length) return res.status(503).json({ error: 'No data loaded. Run the ingestion script.' });

    const scored = keywordRetrieve(question, townPref);
    const prompt = buildPrompt(question, townPref, scored);

    let answer = null;
    if (chatModel) {
      try {
        answer = await generateWithRetry(prompt);
      } catch (llmErr) {
        console.warn('Gemini generateContent failed; using fallback:', llmErr?.statusText || llmErr?.message || llmErr);
      }
    }
    if (!answer) answer = writeFallbackParagraph(scored, question, townPref);

    res.json({ answer, sources: scored.map(s => s.item) });
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Server ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
