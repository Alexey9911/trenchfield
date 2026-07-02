// Chat moderation, three tiers (SOLBALL architecture + wow-recreate heuristics):
//  1. rate limits / duplicates / IP bans (immediate, per-socket)
//  2. heuristic auto-moderation (repeat spam, gibberish, impersonation)
//  3. background LLM pass (Cerebras primary, Groq fallback) — fail-open
import { banIp, deleteChat, newChatSince } from './db.js';

// ---------- tier 1+2: heuristics ----------

const RESERVED_NICKS = [
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'owner', 'developer', 'dev',
  'official', 'system', 'trenchfield', 'support',
];

export function nickAllowed(nick) {
  const folded = String(nick || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't');
  return !RESERVED_NICKS.some((r) => folded === r || folded.startsWith(r));
}

/** wow-recreate style gibberish detection */
export function isGibberish(msg) {
  const m = String(msg);
  if (/(.)\1{9,}/.test(m)) return true; // 10+ identical chars in a row
  const compact = m.replace(/\s/g, '');
  if (compact.length >= 16 && new Set(compact).size <= 4) return true; // low diversity flood
  for (const token of m.split(/\s+/)) {
    if (token.length >= 16 && !/^https?:/.test(token) && !isCryptoRef(token)) {
      const vowels = (token.match(/[aeiou]/gi) ?? []).length;
      if (vowels / token.length < 0.12) return true; // keyboard mash
    }
  }
  return false;
}

/** wallet addresses / tx hashes / urls are never spam (crypto-aware exemption) */
function isCryptoRef(token) {
  return /^[1-9A-HJ-NP-Za-km-z]{30,50}$/.test(token) || /^(0x)?[0-9a-fA-F]{40,}$/.test(token);
}

const repeatWindow = new Map(); // socketId -> [{msg, at}]

export function isRepeatSpam(socketId, msg) {
  const now = Date.now();
  const list = (repeatWindow.get(socketId) ?? []).filter((e) => now - e.at < 45_000);
  list.push({ msg: msg.toLowerCase().trim(), at: now });
  repeatWindow.set(socketId, list);
  const same = list.filter((e) => e.msg === msg.toLowerCase().trim()).length;
  return same >= 3;
}

/** token bucket: burst 5, then ~1 message per 3 s */
const buckets = new Map();

export function chatRateOk(socketId) {
  const now = Date.now();
  const b = buckets.get(socketId) ?? { tokens: 5, at: now };
  b.tokens = Math.min(5, b.tokens + ((now - b.at) / 1000) * (1 / 3));
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(socketId, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(socketId, b);
  return true;
}

// ---------- tier 3: LLM moderation (SOLBALL prompt, Cerebras gpt-oss-120b) ----------

const SYSTEM_PROMPT = `You are the content moderator for TRENCHFIELD chat. Be VERY lenient: default is KEEP.

Remove + BAN "long" (authority impersonation):
- Nick claims staff (admin, mod, dev, official, etc.) in any spelling/variation
- Text claims authority

Remove + BAN "short" (heavy abuse):
- Slurs / hate speech / homophobic / racial
- Severe threats ("kill yourself", doxxing)
- Sexual / NSFW content

Remove + BAN "none" (spam):
- Flooding / gibberish / scam links
- CA: <contract_address>, "100x", "next gem", token shilling
- FUD ("rug", "rigged bets", "never pay out")

KEEP everything else:
- Opinions, criticism, complaints (even harsh)
- Light insults, trash talk, casual "fuck you"
- Banter, gg, lol

Respond with ONLY JSON: {"actions": [{"id": <id>, "ban": "long"|"short"|"none"}]}`;

const CEREBRAS_KEYS = (process.env.CEREBRAS_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const GROQ_KEYS = (process.env.GROQ_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

export const llmModerationEnabled = CEREBRAS_KEYS.length > 0 || GROQ_KEYS.length > 0;

let keyIndex = 0;

async function callLlm(batch) {
  const providers = [];
  for (const k of CEREBRAS_KEYS) {
    providers.push({
      url: 'https://api.cerebras.ai/v1/chat/completions',
      key: k,
      model: CEREBRAS_MODEL,
      extra: { reasoning_effort: 'low' },
    });
  }
  for (const k of GROQ_KEYS) {
    providers.push({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: k,
      model: GROQ_MODEL,
      extra: {},
    });
  }
  if (providers.length === 0) return null;

  const user = batch.map((m) => `[${m.id}] ${m.nick}: ${m.msg}`).join('\n');
  for (let i = 0; i < providers.length; i++) {
    const p = providers[(keyIndex + i) % providers.length];
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: p.model,
          max_tokens: 400,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          ...p.extra,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { actions: [] };
      keyIndex = (keyIndex + i) % providers.length;
      return JSON.parse(jsonMatch[0]);
    } catch {
      /* rotate provider */
    }
  }
  return null; // fail-open
}

/**
 * Background poller: every 4 s, classify new global messages, delete offenders.
 * onRemoved(ids, bans) lets the caller broadcast removals + apply IP bans.
 */
export function startLlmModeration({ onRemoved, getIpForMessage }) {
  if (!llmModerationEnabled) {
    console.log('[moderation] no CEREBRAS_API_KEYS/GROQ_API_KEYS — LLM tier dormant (heuristics active)');
    return;
  }
  let lastId = 0;
  setInterval(async () => {
    try {
      const batch = await newChatSince(lastId, 25);
      if (batch.length === 0) return;
      lastId = Math.max(...batch.map((m) => Number(m.id)));
      const verdict = await callLlm(batch);
      if (!verdict?.actions) return;
      const removeIds = [];
      for (const a of verdict.actions) {
        if (a.ban === 'long' || a.ban === 'short' || a.ban === 'none') {
          removeIds.push(Number(a.id));
          if (a.ban !== 'none') {
            const ip = getIpForMessage?.(Number(a.id));
            if (ip) await banIp(ip, 60, `chat:${a.ban}`);
          }
        }
      }
      if (removeIds.length > 0) {
        await deleteChat(removeIds);
        onRemoved?.(removeIds);
        console.log(`[moderation] removed ${removeIds.length} message(s)`);
      }
    } catch (err) {
      console.error('[moderation] pass failed:', err.message);
    }
  }, 4000);
  console.log(`[moderation] LLM tier active (${CEREBRAS_KEYS.length} cerebras, ${GROQ_KEYS.length} groq)`);
}
