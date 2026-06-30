// Vercel Serverless Function — Gemini TTS 프록시
// API 키는 Vercel 환경변수 GEMINI_API_KEY 로 설정 (클라이언트에 노출되지 않음)
// Gemini가 돌려주는 PCM(24kHz 16bit mono)을 WAV로 감싸서 반환

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다' });

  const { text, style } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text 누락' });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${style || '신나는 한국어 게임쇼 MC 톤으로, 활기차고 또렷하게 말해줘'}:\n${text}` }]
          }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          }
        })
      }
    );
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j.error?.message || 'gemini error' });

    const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part) return res.status(502).json({ error: '오디오 데이터 없음' });

    const pcm = Buffer.from(part.inlineData.data, 'base64');
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
    return res.status(200).json({ wav: wav.toString('base64') });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}

function wavHeader(dataLen, rate = 24000) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);       // fmt chunk size
  b.writeUInt16LE(1, 20);        // PCM
  b.writeUInt16LE(1, 22);        // mono
  b.writeUInt32LE(rate, 24);     // sample rate
  b.writeUInt32LE(rate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32);        // block align
  b.writeUInt16LE(16, 34);       // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}
