// SQLite data layer. Uses Node's built-in node:sqlite (no native build step,
// no npm install headaches) — needs Node 22.5+.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'onboarding.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  channel TEXT NOT NULL,
  tier TEXT DEFAULT 'Micro',
  existing_customer INTEGER DEFAULT 1,
  owner_name TEXT,
  phone TEXT,
  cnic_number TEXT,
  cnic_dob TEXT,
  cnic_father_name TEXT,
  cnic_address TEXT,
  cnic_address_confidence TEXT,
  cnic_scanned INTEGER DEFAULT 0,
  business_name TEXT,
  business_address TEXT,
  category TEXT,
  gps_lat REAL,
  gps_lng REAL,
  shop_photo INTEGER DEFAULT 0,
  products TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  risk_band TEXT,
  queue_reason TEXT,
  decision_note TEXT,
  decided_by TEXT,
  declared_name TEXT,
  name_match_score REAL,
  name_override INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// Safe migration for anyone with an existing onboarding.sqlite from before
// these columns existed — ALTER TABLE ADD COLUMN, ignoring "already there".
for (const stmt of [
  "ALTER TABLE cases ADD COLUMN declared_name TEXT",
  "ALTER TABLE cases ADD COLUMN name_match_score REAL",
  "ALTER TABLE cases ADD COLUMN name_override INTEGER DEFAULT 0"
]) {
  try { db.exec(stmt); } catch (e) { /* column already exists — fine */ }
}

db.exec(`
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  reference TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id)
);
`);

// Stand-in for the user's real weekly cron pull of FBR's Active Taxpayer
// List into a data warehouse. In production this table is refreshed by that
// job; here it's seeded once with sample rows so the FBR check below is a
// genuine lookup against real logic, just against sample data.
db.exec(`
CREATE TABLE IF NOT EXISTS fbr_atl (
  cnic TEXT PRIMARY KEY,
  active INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL
);
`);

function seedAtlIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM fbr_atl').get();
  if (row.n > 0) return;
  const snapshot = '2026-10-26';
  const insert = db.prepare('INSERT INTO fbr_atl (cnic, active, snapshot_date) VALUES (?, ?, ?)');
  const sample = [
    ['35202-1234567-1', 1],
    ['35202-7654321-9', 1],
    ['42101-9999999-7', 0], // deliberately inactive — demo trigger
    ['61101-4455667-3', 1],
    ['35201-1122334-5', 0]
  ];
  for (const [cnic, active] of sample) insert.run(cnic, active, snapshot);
}
seedAtlIfEmpty();

// Seed a handful of cases already sitting in the ops queue, so the queue
// screen has something to show the first time this runs, without having to
// walk the capture flow five times first.
function seedQueueIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM cases').get();
  if (row.n > 0) return;
  const ts = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO cases
      (id, reference, channel, tier, existing_customer, owner_name, cnic_number, business_name,
       products, status, risk_band, queue_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `);
  const samples = [
    {
      ref: 'MO-261022-100011', channel: 'field-agent', tier: 'Small', existing: 1,
      owner: 'Hassan Yousuf', cnic: '35201-5566778-2', biz: 'Lahore Mobile Mart',
      products: ['Android POS'], risk: 'Medium risk',
      reason: 'Android POS always routes to review — not a straight-through product.'
    },
    {
      ref: 'MO-261023-100022', channel: 'branch', tier: 'Registered', existing: 1,
      owner: 'Saeed Ahmed', cnic: '35202-3344556-7', biz: 'Saeed Electronics (Pvt) Ltd',
      products: ['Android POS', 'E-commerce gateway'], risk: 'Medium risk',
      reason: 'E-commerce gateway always routes to review — not a straight-through product.'
    },
    {
      ref: 'MO-261024-100033', channel: 'self-service', tier: 'Micro', existing: 1,
      owner: 'Nasir Chaudhry', cnic: '35202-7788990-4', biz: 'Chaudhry Fabrics',
      products: ['Raast QR'], risk: 'High risk',
      reason: 'AML / PEP / Sanctions did not pass (Hit — needs review) — needs manual review.'
    },
    {
      ref: 'MO-261025-100044', channel: 'field-agent', tier: 'Micro', existing: 0,
      owner: 'Ayesha Khan', cnic: '42101-1231234-1', biz: 'Khan Pharmacy',
      products: ['Raast QR', 'Soundbox'], risk: 'Low risk',
      reason: 'New-to-bank customer — straight-through rule only covers existing customers.'
    },
    {
      ref: 'MO-261026-100055', channel: 'self-service', tier: 'Small', existing: 1,
      owner: 'Bilal Aslam', cnic: '61101-9988776-5', biz: 'Bilal General Store',
      products: ['SoftPOS'], risk: 'Medium risk',
      reason: 'SoftPOS always routes to review — not a straight-through product.'
    }
  ];
  for (const s of samples) {
    insert.run(
      crypto.randomUUID(), s.ref, s.channel, s.tier, s.existing, s.owner, s.cnic, s.biz,
      JSON.stringify(s.products), s.risk, s.reason, ts, ts
    );
  }
}
seedQueueIfEmpty();

module.exports = { db, DB_PATH };
