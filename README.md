# Merchant Onboarding POC

A real, working backend (Node.js + SQLite) for the Allied Bank digital
merchant onboarding flow, with the 6 screens wired to it for real. No build
step, no framework — plain Express + vanilla HTML/JS.

## What's real vs simulated

| Piece | Status |
|---|---|
| CNIC OCR | **Real** — calls Amazon Bedrock (a multimodal LLM) with the uploaded front/back images, via tool-use for structured field extraction. Falls back to a fixed sample reading if the call fails (no credentials, no network, model not enabled) so a demo never breaks. See the Bedrock setup section below. |
| **Name consistency** | **Real logic** — fuzzy-compares the name declared at intake (step 1) against the name the CNIC OCR actually read. Blocks progress in the capture UI on a mismatch unless explicitly overridden, and is checked again server-side at run-checks time either way — see below. |
| FBR Active Taxpayer check | **Real logic**, sample data — looks up the CNIC in a local table that stands in for your real weekly ATL pull. Point it at your actual warehouse table and it's live. |
| Duplicate check | **Real logic** — genuinely queries this app's own case records for a repeated CNIC. |
| NADRA Verisys, AML/PEP/Sanctions, Account-title match, SECP | **Simulated** — these need a paid/institutional/manual integration with no sandbox access. Each has a commented demo trigger in `src/services/checks.js` so you can show both a pass and a fail case to the client. |

### Name consistency, in detail

In Capture step 1 ("Who"), whoever is doing the capture types the merchant's
name *before* the CNIC is even scanned. In step 2, after the CNIC is read,
that declared name is fuzzy-matched (`src/services/nameMatch.js` — a plain
Levenshtein + token-overlap comparison, intentionally simple; swap it for a
transliteration-aware matcher if this goes further) against the name on the
card:

- **Match (score ≥ 0.6):** proceeds normally.
- **Mismatch:** the capture UI shows both names side by side and **blocks
  "Next"** until it's resolved — either go back and fix the typed name, or
  explicitly confirm "same person" (which logs the override and flags the
  case).
- **An override is never free:** even after confirming "same person,"
  the case is routed to the ops queue for manual review rather than being
  eligible for straight-through activation — a resolved mismatch still gets
  a second set of human eyes, not just the field agent's own say-so.
- This is enforced **again server-side** in `run-checks` (as its own
  check, "Name consistency"), so calling the API directly instead of going
  through the UI doesn't bypass it.

### Demo triggers (to show a fail path on purpose)

- Type a different name in step 1 than what's on the uploaded CNIC → Name consistency mismatch, blocks progress.
- Business name containing **"Chaudhry"** → AML/PEP/Sanctions hit.
- CNIC `42101-9999999-7` → FBR inactive taxpayer (type this in instead of scanning, or edit the stub).
- A second case with the same CNIC as an existing one → duplicate check fails.

The ops queue starts out pre-seeded with 5 sample cases so it's not empty on first run.

Note: if Bedrock isn't reachable (missing credentials, no model access, no
network), the scan silently falls back to a fixed sample person (Muhammad
Imran Tariq) so the walkthrough keeps working — the response includes
`ocrSource: "stub-fallback"` and `ocrError` when that happens, and the UI
pops an alert so you know it fell back rather than genuinely reading the
card.

## Setting up Amazon Bedrock

The OCR call lives entirely in `src/services/cnicOcr.js`. It supports two
auth modes, and picks whichever one it finds set.

### The easy way — a `.env` file (recommended, no retyping each session)

1. Copy `.env.example` to a new file named `.env` in the same folder
   (`onboarding-poc/`).
2. Open `.env` in Notepad (or any editor) and fill in your real
   `AWS_BEARER_TOKEN_BEDROCK` value.
3. Just run `npm start` (or `node --env-file-if-exists=.env server.js`) —
   it loads `.env` automatically every time, using Node's own built-in
   support (no extra package, nothing to configure).

`.env` is the one file in this project meant to hold a real secret. **Never
commit it to git, never zip it up and send it to your client, never share
it outside your own machine.** Everything else in this project is safe to
hand off as-is.

### The manual way — set it in the terminal each session

Set the key as an environment variable — never write it into any other
file in this project:

```
set AWS_BEARER_TOKEN_BEDROCK=your-api-key-here      (Windows cmd)
npm start
```

or, in PowerShell:

```
$env:AWS_BEARER_TOKEN_BEDROCK="your-api-key-here"
npm start
```

This only lasts for that one terminal window — you'd set it again next
time you open a new one. The `.env` file above avoids that.

**Security note:** a Bedrock API key is a live credential. Don't commit it
into this project, don't paste it into a chat (if you already have, rotate
or deactivate it from the Bedrock console's API keys page afterward), and
don't hand this project to your client with a real key sitting in `.env`
or your shell — it's only ever read from the environment, never stored
anywhere else.

### Option B — classic AWS credentials (access key/secret, profile, or role)

Used automatically if `AWS_BEARER_TOKEN_BEDROCK` isn't set. Same two ways
to set it — in `.env` (uncomment the two lines in `.env.example`) or in
the terminal:

```
set AWS_ACCESS_KEY_ID=...          (Windows cmd)
set AWS_SECRET_ACCESS_KEY=...
set AWS_REGION=ap-southeast-2
npm start
```

An AWS profile or IAM role picked up by the default credential chain works
too.

### Whichever option you use

- To use a different model or region, also set `BEDROCK_MODEL_ID` /
  `AWS_REGION` the same way. The model needs to actually be enabled for
  your account in that region in the Bedrock console, or calls will fail
  (and fall back to the sample reading below).
- The code tries a forced tool-call first (for a structured response), and
  falls back automatically to asking for plain JSON if the model doesn't
  support tool use.
- **Force the old stub** at any time (e.g. demoing with no internet) by
  setting `CNIC_OCR_MODE=stub` (in `.env` or the terminal).
- If the real call fails for any reason, the response quietly falls back
  to a sample reading (`ocrSource: "stub-fallback"`, with `ocrError`
  explaining why) so a demo never just breaks.

## Running it

**Requires Node.js 22.5 or newer** (uses the built-in `node:sqlite` — no
native modules, no compiler needed).

```
npm install
npm start
```

Then open **http://localhost:3000/** in your browser.

### Windows / PowerShell note

If `npm install` or `npm start` complain about script execution being
disabled, either:
- run `npm.cmd install` / `npm.cmd start` instead, or
- open a plain Command Prompt (`cmd`) instead of PowerShell and run the
  commands there.

## Project layout

```
server.js              entry point
src/db/                SQLite schema + seed data
src/services/          checks engine, routing rules, CNIC OCR (real Bedrock call)
src/routes/            REST API (cases, queue)
public/                the 6 screens (plain HTML/CSS/JS, no build step)
data/                  onboarding.sqlite is created here on first run
.env.example           template for your credentials — copy to .env and fill in
.env                   your real key goes here (you create this; never share it)
```

## API quick reference

- `POST /api/cases` `{ channel }` — start a case
- `GET /api/cases/:id` — full case + its checks
- `PATCH /api/cases/:id/who` `{ owner_name, phone }` — `owner_name` here is the *declared* name; recomputes the name-match score if the CNIC was already scanned
- `POST /api/cases/:id/cnic-scan` `{ frontBase64, backBase64 }` — real Bedrock OCR call (falls back to a stub on failure); returns `nameMismatch` + `nameMatchScore` comparing it against the declared name
- `POST /api/cases/:id/confirm-name-override` — logs an explicit "same person" override after a name mismatch
- `PATCH /api/cases/:id/business` `{ business_name, business_address, category, gps_lat, gps_lng, shop_photo }`
- `PATCH /api/cases/:id/products` `{ products: [...] }` — also returns a live eligibility preview
- `POST /api/cases/:id/submit`
- `POST /api/cases/:id/run-checks` — runs all 7 checks and routes the case
- `GET /api/queue` — cases waiting on a decision
- `POST /api/cases/:id/decision` `{ decision: "approve"|"approve_limits"|"query"|"decline", note }`
- `GET /api/cases/:id/tracking` — merchant-facing status only

## Handing this to your juniors

This maps directly onto the split discussed earlier:
- One person owns `src/services/` + `src/routes/` (the checks/routing logic) and swapping stubs for real integrations as access becomes available.
- The other owns `public/` (the 6 screens) and anything the client wants changed visually.

They don't block each other — the API contract above is the seam between them.
