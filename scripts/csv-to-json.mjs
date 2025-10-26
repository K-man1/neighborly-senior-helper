// csv-to-json.mjs — minimal, always succeeds (no embeddings required)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { parse } from 'csv-parse/sync';

console.log('Ingestion started…');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_IN   = path.resolve(__dirname, '../data/towns.csv');
const JSON_OUT = path.resolve(__dirname, '../data/towns.json');
const INDEX_OUT= path.resolve(__dirname, '../data/index.json');

if (!fs.existsSync(CSV_IN)) {
  console.error('Missing data/towns.csv — create and save your CSV first.');
  process.exit(1);
}

const csv = fs.readFileSync(CSV_IN, 'utf-8');
const rows = parse(csv, { columns: true, skip_empty_lines: true });

// sanitize + enforce public-only rule (URL required)
const items = rows
  .map(r => ({
    town: (r.town||'').trim(),
    category: (r.category||'').trim(),
    name: (r.name||'').trim(),
    address: (r.address||'').trim(),
    phone: (r.phone||'').trim(),
    hours: (r.hours||'').trim(),
    area: (r.area||'').trim().split(',').map(s=>s.trim()).filter(Boolean),
    url: (r.url||'').trim(),
    notes: (r.notes||'').trim()
  }))
  .filter(x => x.town && x.category && x.url);

fs.mkdirSync(path.resolve(__dirname, '../data'), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(items, null, 2));
console.log(`Wrote ${items.length} items to ${JSON_OUT}`);

// Build a placeholder index (vectors null for now)
const index = items.map(it => ({ item: it, vector: null }));
fs.writeFileSync(INDEX_OUT, JSON.stringify(index, null, 2));
console.log(`Wrote ${index.length} vectors to ${INDEX_OUT} (null means no embedding yet)`);
