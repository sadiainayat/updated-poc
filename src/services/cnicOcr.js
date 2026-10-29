// CNIC OCR via Amazon Bedrock (a real multimodal LLM call), with a safe
// fallback to a fixed sample reading if Bedrock isn't reachable — so a demo
// never dies on a flaky connection or a missing key.
//
// Two auth modes, picked automatically from what's set in the environment:
//
//   1. Bedrock API key (bearer token) — set AWS_BEARER_TOKEN_BEDROCK (or
//      BEDROCK_API_KEY as an alias). Calls the Bedrock Converse REST
//      endpoint directly over HTTPS with an Authorization: Bearer header —
//      this is AWS's own documented approach for this auth mode, so no
//      extra SDK dependency is needed for it.
//   2. Classic AWS credentials (access key/secret, profile, or role) — used
//      via @aws-sdk/client-bedrock-runtime's normal SigV4 signing, if no
//      bearer token is set.
//
// NEVER put a real key value in this file or anywhere else in the repo —
// set it as a local environment variable only (see README).
//
// Set CNIC_OCR_MODE=stub to force the old hardcoded behaviour (e.g. for a
// demo with no internet).

const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'qwen.qwen3-vl-235b-a22b';
const BEARER_TOKEN = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY || null;
const FORCE_MODE = (process.env.CNIC_OCR_MODE || '').toLowerCase(); // '' | 'stub' | 'bedrock'

const PROMPT_TEXT = 'These are photos of a Pakistani CNIC — the first image given (if any) is the front, the second (if any) is the back. Read the fields and report what you see. If the address is not visible, leave it blank and mark confidence low.';

// A tool (function) schema, rather than free-text parsing, so the model
// hands back structured fields directly where it supports tool use.
const EXTRACT_TOOL = {
  toolSpec: {
    name: 'extract_cnic_fields',
    description: 'Record the fields read off a Pakistani CNIC, front and/or back.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          owner_name: { type: 'string', description: 'Full name as printed on the CNIC.' },
          cnic_number: { type: 'string', description: 'CNIC number, formatted 00000-0000000-0.' },
          cnic_dob: { type: 'string', description: 'Date of birth as printed, e.g. 14-Mar-1986.' },
          cnic_father_name: { type: 'string', description: 'Father’s or husband’s name as printed.' },
          cnic_address: { type: 'string', description: 'Address as printed on the back of the card, if that image was provided and it is legible.' },
          cnic_address_confidence: { type: 'string', enum: ['high', 'low'], description: '"low" if any field was blurry, cropped out, or you are not confident of the reading.' }
        },
        required: ['owner_name', 'cnic_number', 'cnic_dob', 'cnic_father_name', 'cnic_address_confidence']
      }
    }
  }
};

function parseDataUrl(dataUrlOrBase64, fallbackFormat) {
  if (!dataUrlOrBase64) return null;
  const match = /^data:image\/(\w+);base64,(.*)$/.exec(dataUrlOrBase64);
  const format = (match ? match[1] : fallbackFormat) || 'jpeg';
  const base64 = match ? match[2] : dataUrlOrBase64;
  return { format: format === 'jpg' ? 'jpeg' : format, base64 };
}

function buildContent({ frontBase64, backBase64, format }) {
  const front = parseDataUrl(frontBase64, format);
  const back = parseDataUrl(backBase64, format);
  if (!front && !back) throw new Error('No CNIC image provided.');
  const content = [{ text: PROMPT_TEXT }];
  // REST (bearer-token) wire format wants base64 strings; the SDK path
  // below re-wraps these same strings as Buffers for its own marshaling.
  if (front) content.push({ image: { format: front.format, source: { bytes: front.base64 } } });
  if (back) content.push({ image: { format: back.format, source: { bytes: back.base64 } } });
  return content;
}

function fieldsFromToolBlock(block) {
  const f = block.toolUse.input || {};
  return {
    owner_name: f.owner_name || '',
    cnic_number: f.cnic_number || '',
    cnic_dob: f.cnic_dob || '',
    cnic_father_name: f.cnic_father_name || '',
    cnic_address: f.cnic_address || '',
    cnic_address_confidence: f.cnic_address_confidence === 'high' ? 'high' : 'low'
  };
}

function fieldsFromText(text) {
  const match = /\{[\s\S]*\}/.exec(text || '');
  if (!match) throw new Error('Model reply had no JSON to parse: ' + (text || '').slice(0, 200));
  const f = JSON.parse(match[0]);
  return {
    owner_name: f.owner_name || '',
    cnic_number: f.cnic_number || '',
    cnic_dob: f.cnic_dob || '',
    cnic_father_name: f.cnic_father_name || '',
    cnic_address: f.cnic_address || '',
    cnic_address_confidence: f.cnic_address_confidence === 'high' ? 'high' : 'low'
  };
}

function extractFromConverseResponse(output) {
  const blocks = (output && output.message && output.message.content) || [];
  const toolBlock = blocks.find((b) => b.toolUse);
  if (toolBlock) return fieldsFromToolBlock(toolBlock);
  const textBlock = blocks.find((b) => b.text);
  if (textBlock) return fieldsFromText(textBlock.text);
  throw new Error('Model returned no usable content.');
}

// --- Auth mode 1: Bedrock API key (bearer token) over the REST endpoint ---
async function converseViaBearerToken(content, { withTool }) {
  const url = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/converse`;
  const body = { messages: [{ role: 'user', content }] };
  if (withTool) {
    body.toolConfig = { tools: [EXTRACT_TOOL], toolChoice: { tool: { name: 'extract_cnic_fields' } } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER_TOKEN}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bedrock REST call failed (${res.status}): ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return extractFromConverseResponse(data.output);
}

// --- Auth mode 2: classic AWS credentials via the SDK (SigV4) ---
let sdkClientPromise = null;
async function converseViaSdk(content, { withTool }) {
  if (!sdkClientPromise) {
    sdkClientPromise = import('@aws-sdk/client-bedrock-runtime').catch((e) => {
      sdkClientPromise = null;
      throw new Error('@aws-sdk/client-bedrock-runtime is not installed: ' + e.message);
    });
  }
  const { BedrockRuntimeClient, ConverseCommand } = await sdkClientPromise;
  const client = new BedrockRuntimeClient({ region: REGION });

  // The SDK wants raw bytes (a Buffer), not a base64 string, for image blocks.
  const sdkContent = content.map((block) => {
    if (!block.image) return block;
    return { image: { format: block.image.format, source: { bytes: Buffer.from(block.image.source.bytes, 'base64') } } };
  });

  const params = { modelId: MODEL_ID, messages: [{ role: 'user', content: sdkContent }] };
  if (withTool) {
    params.toolConfig = { tools: [EXTRACT_TOOL], toolChoice: { tool: { name: 'extract_cnic_fields' } } };
  }
  const response = await client.send(new ConverseCommand(params));
  return extractFromConverseResponse(response.output);
}

async function scanCnicReal(input) {
  const content = buildContent(input);
  const converse = BEARER_TOKEN ? converseViaBearerToken : converseViaSdk;
  try {
    // Preferred: forced tool call, so we get structured fields directly.
    return await converse(content, { withTool: true });
  } catch (err) {
    // Some models on Bedrock don't support tool use yet — retry asking for
    // plain JSON in the reply instead, so this still works either way.
    const retryContent = [
      { text: PROMPT_TEXT + ' Reply with ONLY a JSON object with these exact keys: owner_name, cnic_number, cnic_dob, cnic_father_name, cnic_address, cnic_address_confidence ("high" or "low"). No other text.' },
      ...content.slice(1)
    ];
    return await converse(retryContent, { withTool: false });
  }
}

function scanCnicStub() {
  return {
    owner_name: 'Muhammad Imran Tariq',
    cnic_number: '35202-1234567-1',
    cnic_dob: '14-Mar-1986',
    cnic_father_name: 'Ghulam Tariq',
    cnic_address: 'House 12, Street 4, Samanabad, Lahore',
    cnic_address_confidence: 'low'
  };
}

async function scanCnic(input) {
  const hasImage = input && (input.frontBase64 || input.backBase64);

  if (FORCE_MODE === 'stub' || !hasImage) {
    return scanCnicStub();
  }

  try {
    const result = await scanCnicReal(input);
    return { ...result, _source: 'bedrock' };
  } catch (err) {
    console.error('Bedrock CNIC extraction failed, falling back to the sample reading:', err.message);
    return { ...scanCnicStub(), _source: 'stub-fallback', _error: err.message };
  }
}

module.exports = { scanCnic };
