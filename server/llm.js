// Einmalige KI-Anfragen ohne Streaming: Claude (bevorzugt, kann Bilder und PDFs)
// oder Kopf (lokal, OpenAI-kompatibel) als Rückfall.
import { settings } from './store.js';

/**
 * content: String oder Liste von Claude-Inhaltsblöcken (text, image, document).
 * Gibt den Antworttext zurück.
 */
export async function ask({ system, content, maxTokens = 2000, prefer, needsVision = false }) {
  const s = settings();
  const useClaude = s.anthropicKey && prefer !== 'kopf';
  if (useClaude) {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: s.claudeModel || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`Claude: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (needsVision) throw new Error('Für Bilder und PDFs wird ein Anthropic-API-Key gebraucht (Einstellungen → KI)');
  if (!s.kopfUrl) throw new Error('Keine KI eingerichtet (Claude-Key oder Kopf-Adresse)');
  const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const res = await fetch(s.kopfUrl.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: s.kopfModel || 'head-memory', stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Kopf: ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content || '';
}

/** JSON aus einer KI-Antwort holen (auch wenn sie in ```json … ``` steckt). */
export function parseJson(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text).trim();
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  return JSON.parse(raw.slice(start, end + 1));
}

export const imageBlock = (buf, mediaType) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
export const pdfBlock = (buf) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
