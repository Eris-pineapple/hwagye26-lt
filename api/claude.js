// Vercel Serverless Function — Claude API 프록시
// API 키는 Vercel 환경변수 ANTHROPIC_API_KEY 로 설정 (클라이언트에 노출되지 않음)
const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6'
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다' });

  const { model, system, messages, max_tokens } = req.body || {};
  if (!ALLOWED_MODELS.has(model)) return res.status(400).json({ error: '허용되지 않은 모델: ' + model });
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages 누락' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: Math.min(max_tokens || 1024, 4096)
      })
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}
