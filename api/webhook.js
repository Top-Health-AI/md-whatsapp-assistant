import { BOT1 } from '../prompt.js';

// One deployment can serve many doctors: config per WhatsApp phone_number_id.
// DOCTORS env var (JSON): { "<phone_number_id>": { "token": "...", "geminiKey": "...", "prompt": "optional override", "exclude": ["2126..."] } }
const doctors = () => JSON.parse(process.env.DOCTORS || '{}');
const GRAPH = 'https://graph.facebook.com/v25.0';
const paused = new Map(); // customer -> timestamp when doctor last typed manually (coexistence echo)
const history = new Map(); // customer -> last turns

async function gemini(key, system, turns) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: turns, generationConfig: { temperature: 0.3, maxOutputTokens: 400 } })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

async function send(phoneId, token, to, text) {
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  if (!r.ok) console.error('send failed', await r.text());
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.VERIFY_TOKEN) return res.status(200).send(q['hub.challenge']);
    return res.status(403).send('forbidden');
  }
  try {
    for (const entry of req.body?.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {}; const phoneId = v.metadata?.phone_number_id; const doc = doctors()[phoneId];
      if (!doc) continue;
      // Doctor typed in the WhatsApp Business app himself -> bot stays quiet in that chat for 24h
      if (ch.field === 'smb_message_echoes') { for (const m of v.message_echoes || []) paused.set(m.to, Date.now()); continue; }
      for (const m of v.messages || []) {
        const from = m.from;
        if ((doc.exclude || []).includes(from)) continue;
        if (Date.now() - (paused.get(from) || 0) < 24 * 3600e3) continue;
        if (m.type !== 'text') { await send(phoneId, doc.token, from, 'Merci pour votre message. Le docteur vous répondra dès que possible.'); continue; }
        const h = history.get(from) || []; h.push({ role: 'user', parts: [{ text: m.text.body }] });
        let reply = await gemini(doc.geminiKey, doc.prompt || BOT1, h.slice(-8));
        const transfer = /\[(TRANSFERT|URGENCE)\]/.test(reply);
        reply = reply.replace(/\[(TRANSFERT|URGENCE)\]/g, '').trim();
        h.push({ role: 'model', parts: [{ text: reply }] }); history.set(from, h.slice(-8));
        await send(phoneId, doc.token, from, reply);
        if (transfer) paused.set(from, Date.now());
      }
    }
  } catch (e) { console.error(e); }
  res.status(200).send('ok');
}
