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

  const key = process.env.ANTHROPIC_API_KEY;

  // 헬스체크: 브라우저로 GET /api/claude 하면 환경변수가 읽히는지 확인 (키 값은 노출 안 함)
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      keyPresent: !!key,
      keyLength: key ? key.length : 0,
      hint: key ? 'ANTHROPIC_API_KEY 정상 인식됨' : 'ANTHROPIC_API_KEY 미설정 — Vercel 환경변수를 등록하고 재배포하세요'
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!key) {
    console.error('[api/claude] ANTHROPIC_API_KEY 환경변수 미설정');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다 (Vercel → Settings → Environment Variables 등록 후 재배포)' });
  }

  // Vercel은 application/json 본문을 자동 파싱하지만, 문자열로 올 경우도 대비
  let bodyObj = req.body || {};
  if (typeof bodyObj === 'string') { try { bodyObj = JSON.parse(bodyObj); } catch { bodyObj = {}; } }
  const { model, system, messages, max_tokens } = bodyObj;
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
    if (!r.ok) console.error('[api/claude] Anthropic 오류:', r.status, JSON.stringify(j).slice(0, 300));
    return res.status(r.status).json(j);
  } catch (e) {
    console.error('[api/claude] fetch 실패:', e);
    return res.status(502).json({ error: 'Anthropic 호출 실패: ' + String(e) });
  }
}
