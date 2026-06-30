/* ============================================================
   26화계LT 공통 모듈
   - Firebase RTDB 연결 + 서버 시간 동기화
   - Claude API 호출 (서버리스 우선, 로컬 키 폴백)
   - Gemini TTS + Web Speech 음성
   - 효과음(WebAudio), 이미지 압축, 유틸
   ============================================================ */

const FB_URL = 'https://hwagye26-default-rtdb.asia-southeast1.firebasedatabase.app/';
firebase.initializeApp({ databaseURL: FB_URL });
const db = firebase.database();
const TS = () => firebase.database.ServerValue.TIMESTAMP;

// ---- 서버 시간 동기화 (모든 기기가 같은 시계를 쓰도록) ----
let _serverOffset = 0;
db.ref('.info/serverTimeOffset').on('value', s => { _serverOffset = s.val() || 0; });
const now = () => Date.now() + _serverOffset;

// ---- DOM/일반 유틸 ----
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pidOf = name => name.trim().toLowerCase().replace(/[.#$\[\]\/\s]+/g, '_'); // 닉네임 → Firebase 키
const fmtScore = n => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 });

const TEAM_COLORS = ['#ff5252', '#448aff', '#66bb6a', '#ffb300', '#ab47bc', '#26c6da', '#ec407a', '#8d6e63'];

// ---- 점수 공식 ----
// 정각에 흔들어: S(δ) = 1000·e^(-0.003|δ|) · 1/(1+0.0001δ²)  (δ: ms)
function shakeScore(delta) {
  const a = Math.abs(delta);
  return Math.round(1000 * Math.exp(-0.003 * a) / (1 + 0.0001 * delta * delta) * 100) / 100;
}

// ---- 이미지 압축 (카메라 촬영 → base64 JPEG, RTDB 저장용) ----
async function compressImage(file, max = 720, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * sc));
    cv.height = Math.max(1, Math.round(img.height * sc));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  } finally {
    URL.revokeObjectURL(url);
  }
}
const b64Of = dataUrl => dataUrl.split(',')[1];

// ============================================================
// Claude API 호출
// 1순위: /api/claude (Vercel 서버리스, 키는 환경변수)
// 2순위: 로컬 개발용 — localStorage에 저장한 키로 직접 호출
// ============================================================
function currentModel() {
  return localStorage.getItem('hw_model') === 'sonnet'
    ? 'claude-sonnet-4-6'
    : 'claude-haiku-4-5-20251001';
}

async function claudeCall({ system, messages, max_tokens = 1024 }) {
  const body = { model: currentModel(), system, messages, max_tokens };

  // 1) 서버리스 프록시 (/api/claude)
  // 핵심: 서버리스가 JSON 에러를 돌려주면(예: ANTHROPIC_API_KEY 미설정 → 500) 그 에러를
  // 그대로 노출한다. 폴백은 "서버리스 자체가 없는 경우"(정적 서빙 → 비-JSON 404)에만 한다.
  try {
    const r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await r.json();
      if (r.ok && j.content) return j;
      // 서버리스가 응답했지만 에러 → 진짜 원인을 노출 (폴백하지 않음)
      const msg = j.error?.message || j.error || ('HTTP ' + r.status);
      console.error('[claudeCall] /api/claude 오류:', r.status, j);
      throw new Error('Claude API 오류: ' + msg);
    }
    // 비-JSON 응답(정적 호스팅의 404 등) → 서버리스 미배포로 간주, 로컬 키 폴백
    console.warn('[claudeCall] /api/claude 비-JSON 응답(' + r.status + ') → 로컬 키 폴백 시도');
  } catch (e) {
    if (String(e.message || e).includes('Claude API 오류')) throw e; // 서버리스 에러는 전파
    console.warn('[claudeCall] /api/claude 요청 실패 → 로컬 키 폴백:', e);
  }

  // 2) 로컬 개발 폴백 (관리자 설정 ⚙️에서 키 입력 시에만)
  const key = localStorage.getItem('hw_anthropic_key');
  if (!key) {
    const err = 'API 키 없음 — Vercel 환경변수 ANTHROPIC_API_KEY가 설정되지 않았거나 /api/claude가 배포되지 않았습니다. (로컬 테스트는 ⚙️ 설정에서 키 입력)';
    console.error('[claudeCall]', err);
    throw new Error(err);
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) {
    console.error('[claudeCall] 직접 호출 오류:', r.status, j);
    throw new Error('Claude API 오류: ' + (j.error?.message || JSON.stringify(j)));
  }
  return j;
}

const claudeText = resp => (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

// 응답 텍스트에서 JSON 추출 (코드펜스/설명문 섞여도 견딤)
function parseJSON(t) {
  t = String(t).replace(/```json|```/g, '');
  const starts = [t.indexOf('{'), t.indexOf('[')].filter(i => i >= 0);
  const a = Math.min(...starts);
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return JSON.parse(t.slice(a, b + 1));
}

// 이미지 블록 헬퍼 (dataURL → Claude image content block)
const imgBlock = dataUrl => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: b64Of(dataUrl) }
});

// ============================================================
// 음성 — 관리자(TV) 화면에서만 사용
// 즉각 반응: Web Speech / 임팩트: Gemini TTS (실패 시 Web Speech 폴백)
// ============================================================
let voiceOn = localStorage.getItem('hw_voice') !== 'off';
function setVoice(on) {
  voiceOn = on;
  localStorage.setItem('hw_voice', on ? 'on' : 'off');
  if (!on) try { speechSynthesis.cancel(); } catch (e) {}
}

// 즉각 반응용 (지연 없음)
function say(text, rate = 1.05) {
  if (!voiceOn) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = rate;
    speechSynthesis.speak(u);
  } catch (e) {}
}

// Gemini TTS 사용 여부. Web Speech와 동시 재생되는 문제로 현재 비활성화 (Web Speech만 사용).
// true 로 바꾸면 다시 Gemini TTS를 사용한다.
const USE_GEMINI_TTS = false;

// 임팩트용 — 미리 생성해두고 재생 함수를 돌려줌 (두구두구 연출 중 생성)
// 사용법: const play = await ttsMake('레드팀 547점!'); ... play();
async function ttsMake(text, style) {
  const fallback = () => say(text);
  if (!text) return () => {};

  // Gemini TTS 비활성화 시 Web Speech로만 재생 (동시 재생 방지)
  if (!USE_GEMINI_TTS) return fallback;

  // 1) 서버리스 프록시
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, style })
    });
    if (r.ok) {
      const j = await r.json();
      if (j.wav) return makeAudioPlayer('data:audio/wav;base64,' + j.wav, text);
    }
  } catch (e) {}

  // 2) 로컬 개발 폴백 (Gemini 키 직접)
  try {
    const key = localStorage.getItem('hw_gemini_key');
    if (!key) throw 0;
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${style || '신나는 한국어 게임쇼 MC 톤으로, 활기차고 또렷하게 말해줘'}:\n${text}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          }
        })
      }
    );
    const j = await r.json();
    const d = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!d) throw 0;
    return makeAudioPlayer('data:audio/wav;base64,' + pcmToWavB64(d.data), text);
  } catch (e) {
    return fallback; // Gemini 실패 → Web Speech로 자동 대체
  }
}

function makeAudioPlayer(src, fallbackText) {
  return () => {
    if (!voiceOn) return;
    const a = new Audio(src);
    a.play().catch(() => say(fallbackText));
  };
}

// PCM(24kHz 16bit mono) base64 → WAV base64 (브라우저용)
function pcmToWavB64(b64, rate = 24000) {
  const bin = atob(b64);
  const n = bin.length;
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + n, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf[44 + i] = bin.charCodeAt(i);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(s);
}

// ============================================================
// 효과음 (WebAudio)
// ============================================================
let _ac;
const ac = () => (_ac = _ac || new (window.AudioContext || window.webkitAudioContext)());

// 두구두구 드럼롤
function drumroll(ms = 2800) {
  if (!voiceOn) return;
  try {
    const c = ac();
    const end = c.currentTime + ms / 1000;
    for (let t = c.currentTime; t < end; t += 0.07) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = 130 + Math.random() * 50;
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + 0.07);
    }
  } catch (e) {}
}

// 사이렌 (색상 수사대)
function siren(ms = 2000) {
  if (!voiceOn) return;
  try {
    const c = ac();
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth';
    g.gain.value = 0.12;
    const t0 = c.currentTime, n = Math.floor(ms / 600);
    for (let i = 0; i < n; i++) {
      o.frequency.setValueAtTime(600, t0 + i * 0.6);
      o.frequency.linearRampToValueAtTime(900, t0 + i * 0.6 + 0.3);
      o.frequency.linearRampToValueAtTime(600, t0 + i * 0.6 + 0.6);
    }
    g.gain.setValueAtTime(0.12, t0);
    g.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + ms / 1000);
  } catch (e) {}
}

// 띵동 (정답/성공)
function ding() {
  if (!voiceOn) return;
  try {
    const c = ac(), t = c.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.25, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.4);
      o.connect(g); g.connect(c.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.45);
    });
  } catch (e) {}
}

// 붐 (탈락/폭발)
function boom() {
  if (!voiceOn) return;
  try {
    const c = ac(), t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + 0.75);
  } catch (e) {}
}

// ---- 카운트다운 표시용 공통 타이머 (data-dl 속성 가진 요소 자동 갱신) ----
function startTicker() {
  function tick() {
    document.querySelectorAll('[data-dl]').forEach(el => {
      const dl = +el.dataset.dl;
      const remain = (dl - now()) / 1000;
      if (el.dataset.fmt === 't') {
        // T-마이너스 표기 (로켓 발사)
        el.textContent = remain >= 0 ? 'T-' + remain.toFixed(1) : 'T+' + (-remain).toFixed(1);
      } else {
        el.textContent = Math.max(0, Math.ceil(remain));
      }
      if (remain <= 10 && remain > 0) el.classList.add('urgent');
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
