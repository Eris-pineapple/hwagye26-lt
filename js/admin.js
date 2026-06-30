/* ============================================================
   26화계LT — 관리자(노트북→TV 미러링) 앱
   - 전체 공유 화면: 게임 제어 + 큰 점수판 + 연출 + 음성
   - 게임 진행 마스터 루프(드라이버)가 단 한 곳에서 상태 전이를 담당
   ============================================================ */

let P = {};          // players
let TEAMS = {};
let SCORES = {};
let G = { type: 'idle' };
let VIEW = 'lobby';  // idle일 때 보여줄 화면: lobby | games | awards

// 게임 세션(sid)별 구독 데이터
let SUBS = {};       // sub/{sid}        제출물
let RES = {};        // res/{sid}        채점 결과
let REL = {};        // relay/{sid}      릴레이 진행
let RELRES = {};     // relayRes/{sid}
let ALIVEMAP = {};   // alive/{sid}
let ANS = {};        // ans/{sid}
let READY = {};      // ready/{sid}
let attached = { sid: null, off: [] };

let QS = [];          // OX 문제 (oxq/{sid}에서 복원 가능)
let driving = {};     // 마스터 루프 재진입 방지 플래그
let spoke = {};       // 음성 1회 재생 플래그

const stage = $('#stage');

/* ---------------- 초기화 ---------------- */
window.addEventListener('load', () => {
  startTicker();
  $('#model-sel').value = localStorage.getItem('hw_model') || 'haiku';
  $('#model-sel').onchange = e => localStorage.setItem('hw_model', e.target.value);
  $('#voice-toggle').checked = voiceOn;
  $('#voice-toggle').onchange = e => setVoice(e.target.checked);
  $('#btn-settings').onclick = openSettings;
  $('#nav-lobby').onclick = () => { VIEW = 'lobby'; render(); };
  $('#nav-games').onclick = () => { VIEW = 'games'; render(); };
  $('#nav-awards').onclick = () => { VIEW = 'awards'; render(); };

  db.ref('players').on('value', s => { P = s.val() || {}; render(); });
  db.ref('teams').on('value', s => { TEAMS = s.val() || {}; render(); });
  db.ref('scores').on('value', s => { SCORES = s.val() || {}; render(); });
  db.ref('game').on('value', s => {
    G = s.val() || { type: 'idle' };
    ensureGameListeners();
    render();
  });

  setInterval(masterLoop, 400); // 게임 진행 드라이버
});

function ensureGameListeners() {
  if (!G.sid || attached.sid === G.sid) return;
  attached.off.forEach(f => f());
  attached = { sid: G.sid, off: [] };
  SUBS = {}; RES = {}; REL = {}; RELRES = {}; ALIVEMAP = {}; ANS = {}; READY = {}; QS = [];

  const listen = (path, cb) => {
    const ref = db.ref(path);
    const h = ref.on('value', s => { cb(s); render(); });
    attached.off.push(() => ref.off('value', h));
  };
  listen(`sub/${G.sid}`, s => { SUBS = s.val() || {}; });
  listen(`res/${G.sid}`, s => { RES = s.val() || {}; });
  if (G.type === 'relay') {
    listen(`relay/${G.sid}`, s => { REL = s.val() || {}; });
    listen(`relayRes/${G.sid}`, s => { RELRES = s.val() || {}; });
  }
  if (G.type === 'ox') {
    listen(`alive/${G.sid}`, s => { ALIVEMAP = s.val() || {}; });
    listen(`ans/${G.sid}`, s => { ANS = s.val() || {}; });
    db.ref(`oxq/${G.sid}`).get().then(s => { if (s.exists()) QS = s.val(); }); // 새로고침 복구
  }
  if (G.type === 'shake') listen(`ready/${G.sid}`, s => { READY = s.val() || {}; });
}

/* ---------------- 팀/플레이어 헬퍼 ---------------- */
const activePlayers = () => Object.entries(P).filter(([, p]) => p.team && !p.skipped);
const teamMembers = tid => activePlayers().filter(([, p]) => p.team === tid);
const teamIds = () => Object.keys(TEAMS).sort((a, b) => (TEAMS[a].order || 0) - (TEAMS[b].order || 0));
function teamSizes() {
  const m = {};
  teamIds().forEach(t => { m[t] = teamMembers(t).length; });
  return m;
}
const minTeamSize = () => Math.min(...Object.values(teamSizes()).filter(n => n > 0));
const isOnline = p => p.lastSeen && (now() - p.lastSeen) < 25000;
const tName = tid => (TEAMS[tid] && TEAMS[tid].name) || tid;
const tColor = tid => (TEAMS[tid] && TEAMS[tid].color) || '#888';

async function addScore(tid, pts) { await db.ref('scores/' + tid).transaction(v => Math.round(((v || 0) + pts) * 100) / 100); }
async function addPScore(pid, pts) { await db.ref(`players/${pid}/score`).transaction(v => (v || 0) + pts); }
const pushLog = entry => db.ref('log').push({ ...entry, at: now() });
const setGame = g => db.ref('game').set(g);
const updGame = u => db.ref('game').update(u);
const updD = u => db.ref('game/d').update(u);

/* ============================================================
   렌더링
   ============================================================ */
function render() {
  // 입력 중에는 리렌더로 포커스를 뺏지 않음
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)
      && stage.contains(document.activeElement)) return;
  renderScoreboard();
  const theme = { color: 'theme-color', shake: 'theme-shake', relay: 'theme-relay', ox: 'theme-ox', awards: 'theme-awards' }[G.type] || '';
  document.body.className = 'admin ' + theme;

  if (G.type === 'idle' || !G.type) {
    ({ lobby: rLobby, games: rGames, awards: rAwardsSetup }[VIEW] || rLobby)();
  } else {
    ({ color: aColor, shake: aShake, relay: aRelay, ox: aOx, awards: aAwards }[G.type] || rLobby)();
  }
}

function renderScoreboard() {
  const ids = teamIds();
  const sorted = [...ids].sort((a, b) => (SCORES[b] || 0) - (SCORES[a] || 0));
  $('#scoreboard').innerHTML = `<h3>🏆 LEADERBOARD</h3>` + (sorted.length
    ? sorted.map((t, i) => `
      <div class="sb-row ${i === 0 && (SCORES[t] || 0) > 0 ? 'first' : ''}">
        <span class="dot" style="background:${tColor(t)}"></span>
        <div><div class="tname">${esc(tName(t))}</div>
        <div class="tmembers">${teamMembers(t).map(([, p]) => esc(p.name)).join(', ') || '인원 없음'}</div></div>
        <span class="tscore">${fmtScore(Math.round(SCORES[t] || 0))}</span>
      </div>`).join('')
    : '<div class="muted">팀을 먼저 만들어주세요</div>');
}

/* ---------------- 로비: 팀 구성 / 플레이어 관리 ---------------- */
function rLobby() {
  const ids = teamIds();
  const playerURL = location.href.substring(0, location.href.lastIndexOf('/') + 1);
  stage.innerHTML = `
    <div class="card" style="margin-bottom:16px;display:flex;gap:24px;align-items:center;flex-wrap:wrap">
      <div id="qr-box" style="background:#fff;padding:12px;border-radius:14px;line-height:0;flex:none"></div>
      <div style="flex:1;min-width:240px">
        <h3 style="margin-bottom:8px">📱 플레이어 접속</h3>
        <div class="muted" style="margin-bottom:10px">폰 카메라로 QR을 찍으면 입장 화면으로 이동합니다</div>
        <div style="font-size:20px;font-weight:800;color:var(--accent);word-break:break-all">${esc(playerURL)}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:10px">🎽 팀 구성</h3>
      <div style="display:flex;gap:10px;align-items:center">
        <span class="muted">팀 수</span>
        <input id="team-n" type="number" min="2" max="8" value="${ids.length || 2}" style="width:70px">
        <button class="small" id="team-make">팀 생성/조정</button>
        <span class="muted">팀별 인원수가 달라도 자동 보정됩니다 (예: 5 vs 6)</span>
      </div>
      <div class="team-grid">
        ${ids.map(t => `<div class="team-chip"><span class="dot" style="width:12px;height:12px;border-radius:50%;background:${tColor(t)}"></span>
          <input value="${esc(tName(t))}" onchange="renameTeam('${t}',this.value)">
          <span class="muted">${teamMembers(t).length}명</span></div>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:10px">👥 플레이어 (${Object.keys(P).length}명 접속 기록)</h3>
      <table class="players">
        <tr><th>상태</th><th>닉네임</th><th>팀 배정</th><th>개인점수</th><th>건너뛰기</th><th></th></tr>
        ${Object.entries(P).map(([id, p]) => `
          <tr>
            <td><span class="online-dot ${isOnline(p) ? 'on' : ''}"></span>${isOnline(p) ? '접속중' : '오프라인'}</td>
            <td class="${p.skipped ? 'skipped-name' : ''}" style="font-weight:700">${esc(p.name)}</td>
            <td><select onchange="assignTeam('${id}',this.value)">
              <option value="">미배정</option>
              ${ids.map(t => `<option value="${t}" ${p.team === t ? 'selected' : ''}>${esc(tName(t))}</option>`).join('')}
            </select></td>
            <td>${fmtScore(Math.round(p.score || 0))}</td>
            <td><button class="small ${p.skipped ? 'danger' : 'ghost'}" onclick="toggleSkip('${id}',${!p.skipped})">${p.skipped ? '⏭️ 제외됨' : '건너뛰기'}</button></td>
            <td><button class="small ghost" onclick="delPlayer('${id}','${esc(p.name)}')">삭제</button></td>
          </tr>`).join('')}
      </table>
      ${Object.keys(P).length === 0 ? '<div class="muted" style="padding:10px">플레이어가 폰에서 접속하면 여기에 나타납니다 → 같은 주소의 index.html</div>' : ''}
    </div>

    <div class="card">
      <h3 style="margin-bottom:10px">🎉 개회식 / 관리</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button onclick="openingCeremony()">📣 개회식 (팀 소개)</button>
        <button class="ghost" onclick="VIEW='games';render()">🎮 게임 선택으로</button>
        <button class="ghost danger" onclick="resetScores()">점수 초기화</button>
        <button class="ghost danger" onclick="resetAll()">전체 초기화 (기록 포함)</button>
      </div>
    </div>`;
  $('#team-make').onclick = makeTeams;

  // 플레이어 접속 QR (qrcode.js). innerHTML 재생성마다 새로 그림
  const qbox = $('#qr-box');
  if (qbox) {
    if (window.QRCode) {
      qbox.innerHTML = '';
      new QRCode(qbox, {
        text: playerURL,
        width: 180,
        height: 180,
        colorDark: '#1a1040',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      qbox.innerHTML = '<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#888;font-size:13px;text-align:center">QR 라이브러리를<br>불러오지 못했습니다<br>(위 주소를 직접 입력)</div>';
    }
  }
}

async function makeTeams() {
  const n = Math.max(2, Math.min(8, +$('#team-n').value || 2));
  const cur = teamIds();
  const upd = {};
  for (let i = 0; i < n; i++) {
    const tid = 't' + (i + 1);
    if (!TEAMS[tid]) upd['teams/' + tid] = { name: (i + 1) + '팀', color: TEAM_COLORS[i % TEAM_COLORS.length], order: i };
  }
  for (const t of cur) {
    const idx = +t.slice(1);
    if (idx > n) {
      upd['teams/' + t] = null;
      Object.entries(P).forEach(([id, p]) => { if (p.team === t) upd[`players/${id}/team`] = null; });
    }
  }
  await db.ref().update(upd);
}
window.renameTeam = (tid, v) => db.ref(`teams/${tid}/name`).set(v.trim() || tid);
window.assignTeam = (id, t) => db.ref(`players/${id}/team`).set(t || null);
window.toggleSkip = (id, v) => db.ref(`players/${id}/skipped`).set(v);
window.delPlayer = (id, name) => { if (confirm(`${name} 플레이어를 삭제할까요?`)) db.ref('players/' + id).remove(); };

async function resetScores() {
  if (!confirm('모든 팀/개인 점수를 0으로 초기화할까요?')) return;
  const upd = { scores: null };
  Object.keys(P).forEach(id => upd[`players/${id}/score`] = 0);
  await db.ref().update(upd);
}
async function resetAll() {
  if (!confirm('점수+게임 기록+시상식까지 전부 초기화합니다. 계속할까요?')) return;
  const upd = { scores: null, log: null, awards: null, game: { type: 'idle' }, sub: null, res: null, relay: null, relayRes: null, alive: null, ans: null, ready: null, oxq: null };
  Object.keys(P).forEach(id => upd[`players/${id}/score`] = 0);
  await db.ref().update(upd);
}

async function openingCeremony() {
  const ids = teamIds();
  const intro = `제26회 화계 LT 게임 올림픽 개회를 선언합니다! 출전팀을 소개합니다. ` +
    ids.map(t => `${tName(t)}, ${teamMembers(t).map(([, p]) => p.name).join(', ')}`).join('. ') +
    `. 총 네 개 종목으로 승부를 가립니다. 선수단 모두 정정당당히 싸워주세요!`;
  overlay(`<div class="big-emoji" style="font-size:120px">🎆</div><h2 style="font-size:50px">제26회 화계LT<br>게임 올림픽 개회식</h2>
    ${ids.map(t => `<div class="team-result-row card"><span class="dot" style="width:18px;height:18px;border-radius:50%;background:${tColor(t)}"></span>
      <b style="font-size:24px">${esc(tName(t))}</b><span class="muted">${teamMembers(t).map(([, p]) => esc(p.name)).join(' · ')}</span></div>`).join('')}
    <button onclick="hideOverlay()">닫기</button>`);
  (await ttsMake(intro, '올림픽 개회식 장내 아나운서처럼 웅장하고 신나게'))();
}

/* ---------------- 게임 선택 ---------------- */
function rGames() {
  const ok = teamIds().length >= 2 && teamIds().every(t => teamMembers(t).length > 0);
  stage.innerHTML = `
    ${ok ? '' : '<div class="card" style="border-color:var(--danger);margin-bottom:14px">⚠️ 팀이 2개 이상이고 모든 팀에 인원이 있어야 시작할 수 있습니다 (로비에서 설정)</div>'}
    <div class="game-cards">
      <div class="card game-card"><h3>🚨 긴급 출동! 색상 수사대</h3>
        <div class="desc">도주한 '용의 색상'과 비슷한 물건을 60초 안에 찾아 촬영! AI 감식반이 유사도를 0~1000점으로 채점. <b>팀 평균제</b> (보정 불필요)</div>
        <div class="opts">라운드 <select id="color-rounds"><option>1</option><option selected>2</option><option>3</option></select></div>
        <button onclick="colorStart()" ${ok ? '' : 'disabled'}>출동 개시</button></div>

      <div class="card game-card"><h3>🚀 정각에 흔들어! (발사 관제센터)</h3>
        <div class="desc">T-0 정각에 폰을 흔들어 로켓 점화! 오차(ms)에 따라 S(δ)=1000·e^(-0.003|δ|)/(1+0.0001δ²) 점수. <b>팀 합산제</b> (인원수 비율 보정)</div>
        <div class="opts">라운드 <select id="shake-rounds"><option>1</option><option selected>2</option><option>3</option></select></div>
        <button onclick="shakeStart()" ${ok ? '' : 'disabled'}>발사 시퀀스</button></div>

      <div class="card game-card"><h3>🖼️ 고장난 전화기 미술관 (그림 릴레이)</h3>
        <div class="desc">제시어 → 그림 → 따라 그림 → ... → 마지막 사람이 제시어 추측. 유사도 70% + 정답 보너스 30%. <b>릴레이 단계 수 차이 자동 보정</b></div>
        <div class="opts">난이도 <select id="relay-diff"><option value="쉬움">쉬움</option><option value="보통" selected>보통</option><option value="지옥">지옥</option></select></div>
        <button onclick="relayStart()" ${ok ? '' : 'disabled'}>전시 개막</button></div>

      <div class="card game-card"><h3>🦑 스피드 OX 서바이벌</h3>
        <div class="desc">AI가 즉석 출제하는 OX. 틀리면 즉시 탈락, 갈수록 이상해짐. 최후 생존 인원 비율로 팀 점수. <b>인원수 비율 보정</b></div>
        <div class="opts">문제 수 <select id="ox-n"><option>6</option><option>8</option><option selected>10</option><option>12</option></select></div>
        <button onclick="oxStart()" ${ok ? '' : 'disabled'}>게임 시작</button></div>
    </div>`;
}

/* ============================================================
   연출 헬퍼: 두구두구 → 공개 + TTS
   ============================================================ */
function overlay(html) { const o = $('#overlay'); o.hidden = false; o.innerHTML = html; }
window.hideOverlay = () => { $('#overlay').hidden = true; };

// 두구두구 동안 TTS를 미리 생성 → 공개 순간 재생 (게임 멈춤 없음)
async function dramaticReveal(announceText, ttsStyle, afterFn) {
  overlay(`<div class="drum"><div class="drum-emoji">🥁</div>두구두구두구...</div>`);
  drumroll(2800);
  const playP = ttsMake(announceText, ttsStyle); // 비동기 선생성
  await sleep(2800);
  hideOverlay();
  if (afterFn) await afterFn();
  playP.then(play => play()).catch(() => {});
}

/* ============================================================
   마스터 루프 — 시간/제출 기반 자동 전이
   ============================================================ */
function masterLoop() {
  try {
    if (G.type === 'color' && G.phase === 'play') colorMaybeJudge();
    if (G.type === 'shake' && G.phase === 'count') shakeMaybeJudge();
    if (G.type === 'relay' && G.phase === 'play') relayDrive();
    if (G.type === 'ox') oxDrive();
  } catch (e) { console.warn('loop', e); }
}
const once = (key, fn) => { if (driving[key]) return; driving[key] = true; Promise.resolve(fn()).finally(() => { driving[key] = false; }); };

/* ============================================================
   게임 1 — 색상 수사대
   ============================================================ */
async function colorStart() {
  const totalRounds = +$('#color-rounds').value || 2;
  const sid = 'c' + Date.now().toString(36);
  await setGame({ type: 'color', sid, round: 1, totalRounds, phase: 'brief', d: {} });
  siren(2500);
  (await ttsMake('긴급 출동! 색상 수사대. 잠시 후 용의 색상이 공개됩니다. 전 요원은 카메라를 준비하십시오!', '긴박한 경찰 무전기 톤으로'))();
  setTimeout(() => colorRoundBegin(), 5000);
}

function randNiceColor() {
  const h = Math.floor(Math.random() * 360);
  const s = 45 + Math.floor(Math.random() * 50);
  const l = 35 + Math.floor(Math.random() * 35);
  const f = n => { const k = (n + h / 30) % 12, a = s / 100 * Math.min(l / 100, 1 - l / 100); const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

async function colorRoundBegin() {
  const target = randNiceColor();
  await updGame({ phase: 'play', d: { target, endsAt: now() + 60000 } });
  siren(1500);
  say('용의 색상이 도주 중입니다! 60초 안에 검거하세요!');
  spoke = {};
}

function colorMaybeJudge() {
  const d = G.d || {};
  const subs = SUBS[G.round] || {};
  const act = activePlayers();
  const allIn = act.length > 0 && act.every(([id]) => subs[id]);
  // 10초 경고 (즉각 반응 → Web Speech)
  if (!spoke.w10 && d.endsAt - now() < 10000 && d.endsAt - now() > 8500) { spoke.w10 = true; say('10초 남았습니다!'); }
  if (allIn || now() > d.endsAt + 3000) once('colorJudge', colorJudge);
}

async function colorJudge() {
  await updGame({ phase: 'judge' });
  say('현장 접수 마감. 감식반 분석을 시작합니다.');
  const d = G.d, round = G.round;
  const subs = SUBS[round] || {};
  const act = activePlayers();

  for (const [id, p] of act) {
    const sub = subs[id];
    let result = { score: 0, comment: '증거물 미제출 — 현장 이탈로 처리되었습니다.', miss: true };
    if (sub && sub.img) {
      try {
        const resp = await claudeCall({
          system: `너는 파티게임 '긴급 출동! 색상 수사대'의 AI 감식반장이다. 목표 색상(HEX)과 플레이어가 제출한 사진을 비교한다.
제출 사진은 플레이어가 화면 중앙 원형 조준경으로 특정 지점을 클로즈업해 크롭한 원형 이미지다(바깥은 해당 영역 평균색으로 채워져 있음). 이 원형 영역의 대표 색을 목표 색과 비교해 채점하라.
색상 유사도(색조·채도·명도 종합)를 0~1000점으로 채점: 거의 같은 색이면 900+, 비슷한 계열이면 500~800, 동떨어지면 300 이하.
comment는 형사/무전기 말투의 위트있는 한 줄 (존댓말, 예: "이게 민트색이라고요...? 용감하네요.").
JSON만 출력: {"score": 정수, "found": "조준한 색/물체(짧게)", "comment": "한 줄"}`,
          messages: [{ role: 'user', content: [
            { type: 'text', text: `목표 색상: ${d.target}${sub.avg ? `\n참고: 클라이언트가 계산한 조준 영역 평균색은 ${sub.avg}` : ''}` },
            imgBlock(sub.img)
          ]}],
          max_tokens: 300
        });
        const j = parseJSON(claudeText(resp));
        const sc = Math.round(Number(j.score));
        if (!Number.isFinite(sc)) throw new Error('점수 파싱 실패: ' + claudeText(resp).slice(0, 80));
        result = { score: Math.max(0, Math.min(1000, sc)), found: j.found || '', comment: j.comment || '' };
      } catch (e) {
        console.error('[colorJudge] 채점 실패:', p.name, e);
        result = { score: 0, error: true, comment: '⚠️ 채점 실패 — ' + String(e.message || e).slice(0, 80) };
      }
    }
    await db.ref(`res/${G.sid}/${round}/${id}`).set(result);
    await addPScore(id, result.score);
    pushLog({ g: 'color', round, player: id, name: p.name, team: p.team, score: result.score, note: result.comment });
  }
  await colorReveal(round);
}

async function colorReveal(round) {
  // 팀 평균 (평균제 → 인원 보정 불필요. 미제출 0점 포함, 건너뛴 사람 제외)
  const r = RES[round] || (await db.ref(`res/${G.sid}/${round}`).get()).val() || {};
  const teamAvg = {};
  for (const t of teamIds()) {
    const ms = teamMembers(t);
    teamAvg[t] = ms.length ? Math.round(ms.reduce((s, [id]) => s + ((r[id] && r[id].score) || 0), 0) / ms.length) : 0;
  }
  const ranked = teamIds().sort((a, b) => teamAvg[b] - teamAvg[a]);
  const announce = `감식 결과 발표! ${ranked.map(t => `${tName(t)}, 평균 ${teamAvg[t]}점`).join('. ')}. 이번 라운드 검거왕은 ${tName(ranked[0])}입니다!`;

  await dramaticReveal(announce, '범인을 발표하는 형사반장처럼 극적이고 위트있게', async () => {
    for (const t of ranked) await addScore(t, teamAvg[t]);
    await updGame({ phase: 'reveal', d: { ...G.d, teamAvg } });
  });
}

function aColor() {
  const d = G.d || {};
  if (G.phase === 'brief') {
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🚨</div>
      <div class="wanted-poster"><h3>WANTED</h3><div style="font-size:20px">용의 색상 도주 중...<br>잠시 후 수배 전단 공개</div></div></div>`;
    return;
  }
  if (G.phase === 'play') {
    const subs = SUBS[G.round] || {};
    const act = activePlayers();
    stage.innerHTML = `<div class="stage-center">
      <div class="wanted-poster"><h3>WANTED</h3>
        <div class="a-color-swatch" style="background:${esc(d.target)};margin:10px auto"></div>
        <div style="font-size:24px;font-weight:900;letter-spacing:3px">${esc(d.target)}</div>
        <div>이 색을 60초 내로 검거(촬영)하라!</div></div>
      <div class="mega" data-dl="${d.endsAt}">60</div>
      <div class="muted" style="font-size:18px">증거물 접수: ${Object.keys(subs).length} / ${act.length}
        ${act.map(([id, p]) => `<span style="margin:0 6px;${subs[id] ? 'color:var(--ok)' : 'opacity:.4'}">${subs[id] ? '✅' : '⬜'}${esc(p.name)}</span>`).join('')}</div>
      <button class="ghost" onclick="once('colorJudge', colorJudge)">⏱️ 즉시 감식 시작</button>
    </div>`;
    return;
  }
  if (G.phase === 'judge') {
    const done = Object.keys(RES[G.round] || {}).length;
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🔬</div><h2>감식반 분석 중...</h2>
      <div class="muted" style="font-size:20px">${done} / ${activePlayers().length} 건 분석 완료</div></div>`;
    return;
  }
  if (G.phase === 'reveal') {
    const r = RES[G.round] || {};
    const subs = SUBS[G.round] || {};
    const avg = d.teamAvg || {};
    const ranked = teamIds().sort((a, b) => (avg[b] || 0) - (avg[a] || 0));
    const all = activePlayers().map(([id, p]) => ({ id, p, res: r[id] || { score: 0 } })).sort((a, b) => b.res.score - a.res.score);
    const worst = all[all.length - 1];
    stage.innerHTML = `
      <h2 style="margin-bottom:14px">🔍 감식 결과 — ${G.round} / ${G.totalRounds} 라운드</h2>
      ${ranked.map((t, i) => `<div class="team-result-row card">
        <span style="font-size:26px">${['🥇', '🥈', '🥉'][i] || '🏃'}</span>
        <span class="dot" style="width:16px;height:16px;border-radius:50%;background:${tColor(t)}"></span>
        <b style="font-size:22px">${esc(tName(t))}</b><span class="muted">팀 평균</span>
        <span class="trs">+${avg[t] || 0}</span></div>`).join('')}
      <div class="result-grid">
        ${all.map(x => `<div class="card result-card ${x.res.error ? 'worst' : (x === worst && all.length > 1 ? 'worst' : '')}">
          ${subs[x.id] ? `<img src="${subs[x.id].img}">` : '<div style="height:120px;display:flex;align-items:center;justify-content:center">📵</div>'}
          <div style="font-weight:800">${esc(x.p.name)}</div>
          <div class="rs">${x.res.error ? '⚠️' : x.res.score}</div>
          <div class="rc">"${esc(x.res.comment || '')}"</div></div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        ${worst && subs[worst.id] ? `<button class="danger" onclick="pillory('${worst.id}')">🚨 오인 체포 박제 공개</button>` : ''}
        ${G.round < G.totalRounds
          ? `<button onclick="nextColorRound()">다음 라운드 ▶</button>`
          : `<button onclick="endGame()">수사 종료 → 로비</button>`}
      </div>`;
    return;
  }
  stage.innerHTML = '<div class="stage-center"><h2>...</h2></div>';
}

window.pillory = async id => {
  const r = (RES[G.round] || {})[id] || {};
  const sub = (SUBS[G.round] || {})[id];
  const p = P[id] || {};
  overlay(`<div class="pillory"><h2>🚨 금주의 오인 체포 🚨</h2>
    ${sub ? `<img src="${sub.img}">` : ''}
    <h2 style="color:#fff">${esc(p.name)} — ${r.score || 0}점</h2>
    <div style="font-size:22px">"${esc(r.comment || '')}"</div>
    <button onclick="hideOverlay()" style="margin-top:14px">내리기</button></div>`);
  boom();
  (await ttsMake(`${p.name} 요원, ${r.score}점. ${r.comment || ''}`, '어이없어하는 형사반장처럼 위트있게'))();
};
window.nextColorRound = async () => {
  await updGame({ round: G.round + 1, phase: 'brief', d: {} });
  setTimeout(() => colorRoundBegin(), 3000);
};
window.endGame = () => { VIEW = 'games'; setGame({ type: 'idle' }); };

/* ============================================================
   게임 2 — 정각에 흔들어 (발사 관제센터)
   ============================================================ */
async function shakeStart() {
  const totalRounds = +$('#shake-rounds').value || 2;
  const sid = 's' + Date.now().toString(36);
  await setGame({ type: 'shake', sid, round: 1, totalRounds, phase: 'arm', d: {} });
  (await ttsMake('여기는 발사 관제센터. 전 승무원은 기체 센서를 점검하라. 점화 타이밍을 정확히 맞춰야 궤도에 진입할 수 있다.', '나사 관제센터 교신처럼 차분하고 긴장감 있게'))();
}

window.shakeLaunch = async () => {
  const targetAt = now() + 13000;
  await updGame({ phase: 'count', d: { targetAt } });
  spoke = {};
  // 카운트다운 음성 — 즉각 반응이므로 Web Speech
  for (let s = 10; s >= 1; s--) setTimeout(() => say(String(s), 1.2), targetAt - now() - s * 1000);
  setTimeout(() => say('발사!', 1.1), targetAt - now());
};

function shakeMaybeJudge() {
  const d = G.d || {};
  if (d.targetAt && now() > d.targetAt + 6000) once('shakeJudge', shakeJudge);
}

async function shakeJudge() {
  const round = G.round;
  const subs = SUBS[round] || {};
  const act = activePlayers();
  const sizes = teamSizes();
  const minSz = minTeamSize();

  const teamSum = {};
  teamIds().forEach(t => teamSum[t] = 0);
  for (const [id, p] of act) {
    const sub = subs[id];
    let r;
    if (sub && typeof sub.delta === 'number') {
      r = { delta: sub.delta, score: shakeScore(sub.delta) };
    } else {
      r = { score: 0, miss: true };
    }
    await db.ref(`res/${G.sid}/${round}/${id}`).set(r);
    await addPScore(id, r.score);
    teamSum[p.team] += r.score;
    pushLog({ g: 'shake', round, player: id, name: p.name, team: p.team, score: r.score, note: r.miss ? '미점화' : `오차 ${r.delta}ms` });
  }
  // 합산제 → 인원수 비율 보정 (적은 팀 기준 환산)
  const adj = {};
  teamIds().forEach(t => {
    adj[t] = sizes[t] ? Math.round(teamSum[t] * (minSz / sizes[t]) * 100) / 100 : 0;
  });
  const ranked = teamIds().sort((a, b) => adj[b] - adj[a]);
  const best = Object.entries(subs).filter(([, s]) => typeof s.delta === 'number').sort((a, b) => Math.abs(a[1].delta) - Math.abs(b[1].delta))[0];
  const announce = `관제센터 판정! ${ranked.map(t => `${tName(t)}, 보정 합산 ${adj[t]}점`).join('. ')}.` +
    (best ? ` 최고 정밀 점화는 ${P[best[0]] ? P[best[0]].name : ''}, 오차 ${Math.abs(best[1].delta)}밀리초!` : '');

  await dramaticReveal(announce, '로켓 발사 성공을 알리는 관제센터 아나운서처럼 벅차고 신나게', async () => {
    for (const t of ranked) await addScore(t, adj[t]);
    await updGame({ phase: 'reveal', d: { ...G.d, adj, sizes, minSz } });
  });
}

function aShake() {
  const d = G.d || {};
  if (G.phase === 'arm') {
    const act = activePlayers();
    const ready = READY || {};
    stage.innerHTML = `<div class="stage-center">
      <div class="console-panel">
        <div class="line">// MISSION CONTROL — ROUND ${G.round}/${G.totalRounds}</div>
        <div class="line">// 전 승무원 센서 점검 대기 중...</div>
        ${act.map(([id, p]) => `<div class="line">${ready[id] ? '🟢' : '⚪'} ${esc(p.name)} ${ready[id] ? 'SENSOR OK' : 'STANDBY'}</div>`).join('')}
      </div>
      <div class="muted">모든 인원이 준비되지 않아도 발사할 수 있습니다 (미점검 인원은 0점 위험)</div>
      <button onclick="shakeLaunch()">🚀 발사 시퀀스 개시 (T-13초)</button>
    </div>`;
    return;
  }
  if (G.phase === 'count') {
    const subs = SUBS[G.round] || {};
    stage.innerHTML = `<div class="stage-center">
      <div class="rocket">🚀</div>
      <div class="mega" data-dl="${d.targetAt}" data-fmt="t">T-13.0</div>
      <div class="console-panel"><div class="line">// T-0 정각에 기체를 흔들어 점화하라</div>
      <div class="line">// 점화 기록: ${Object.keys(subs).length} / ${activePlayers().length}</div></div>
    </div>`;
    return;
  }
  if (G.phase === 'reveal') {
    const r = RES[G.round] || {};
    const adj = d.adj || {};
    const ranked = teamIds().sort((a, b) => (adj[b] || 0) - (adj[a] || 0));
    const rows = activePlayers().map(([id, p]) => ({ id, p, r: r[id] || { score: 0, miss: true } })).sort((a, b) => b.r.score - a.r.score);
    stage.innerHTML = `
      <h2 style="margin-bottom:14px">🛰️ 궤도 진입 판정 — ${G.round}/${G.totalRounds} 라운드</h2>
      ${ranked.map((t, i) => `<div class="team-result-row card">
        <span style="font-size:26px">${i === 0 ? '🛸' : '💥'}</span>
        <span class="dot" style="width:16px;height:16px;border-radius:50%;background:${tColor(t)}"></span>
        <b style="font-size:22px">${esc(tName(t))}</b>
        <span class="muted">합산 × ${d.minSz}/${(d.sizes || {})[t] || '?'}명 보정</span>
        <span class="trs">+${fmtScore(adj[t])}</span></div>`).join('')}
      <div class="result-grid">
        ${rows.map(x => `<div class="card result-card">
          <div style="font-size:34px">${x.r.miss ? '🧨' : x.r.score >= 500 ? '🚀' : '💥'}</div>
          <div style="font-weight:800">${esc(x.p.name)}</div>
          <div class="rs">${fmtScore(x.r.score)}</div>
          <div class="rc">${x.r.miss ? '미점화' : `오차 ${x.r.delta > 0 ? '+' : ''}${x.r.delta}ms`}</div></div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        ${G.round < G.totalRounds
          ? `<button onclick="nextShakeRound()">다음 발사 ▶</button>`
          : `<button onclick="endGame()">임무 종료 → 로비</button>`}
      </div>`;
    return;
  }
  stage.innerHTML = '<div class="stage-center"><h2>...</h2></div>';
}
window.nextShakeRound = () => updGame({ round: G.round + 1, phase: 'arm', d: {} });

/* ============================================================
   게임 3 — 그림 릴레이 (고장난 전화기 미술관)
   ============================================================ */
const DRAW_MS = 55000;  // 그리기 40초 + 촬영/업로드 여유 15초
const GUESS_MS = 35000;

async function relayStart() {
  const diff = $('#relay-diff').value;
  const bad = teamIds().filter(t => teamMembers(t).length < 2);
  if (bad.length) return alert('모든 팀에 최소 2명이 필요합니다: ' + bad.map(tName).join(', '));
  const sid = 'r' + Date.now().toString(36);
  await setGame({ type: 'relay', sid, phase: 'gen', round: 1, totalRounds: 1, d: { diff } });

  let word = '우산 쓴 문어';
  try {
    const resp = await claudeCall({
      system: `파티게임 '고장난 전화기 미술관'(그림 릴레이) 제시어 출제자.
난이도: ${diff}. 쉬움=한 단어 사물/동물, 보통=행동·상황이 있는 짧은 구, 지옥=황당하고 추상적인 조합.
40초 안에 종이에 그릴 수 있어야 함. 한국어. JSON만: {"word":"제시어"}`,
      messages: [{ role: 'user', content: '제시어 1개 생성' }],
      max_tokens: 100
    });
    word = parseJSON(claudeText(resp)).word;
  } catch (e) { alert('제시어 생성 실패, 기본 제시어 사용: ' + e.message); }

  // 팀별 릴레이 노드 생성 (순서는 셔플)
  const upd = {};
  for (const t of teamIds()) {
    const order = shuffle(teamMembers(t).map(([id]) => id));
    upd[`relay/${sid}/${t}`] = { order, prompt: word, cur: 0, deadline: now() + DRAW_MS, steps: {}, done: false };
  }
  await db.ref().update(upd);
  await updGame({ phase: 'play', d: { diff, word } });
  (await ttsMake('고장난 전화기 미술관 개관! 첫 번째 작가들은 비밀 제시어를 확인하고 40초 안에 작품을 완성하세요!', '고상한 미술관 큐레이터가 들뜬 목소리로'))();
}

function relayDrive() {
  once('relayDrive', async () => {
    let allDone = true;
    for (const [tid, r] of Object.entries(REL)) {
      if (!r || !r.order) continue;
      if (r.done) continue;
      allDone = false;
      const last = r.order.length - 1;
      const cur = r.cur || 0;
      if (cur < last) {
        // 그리기 단계
        if (r.steps && r.steps[cur]) {
          const nc = cur + 1;
          await db.ref(`relay/${G.sid}/${tid}`).update({ cur: nc, deadline: now() + (nc === last ? GUESS_MS : DRAW_MS) });
        } else if (now() > (r.deadline || 0) + 5000) {
          // 시간 초과 → 해당 주자 건너뛰기 (접속 끊김 대응)
          await db.ref(`relay/${G.sid}/${tid}/steps/${cur}`).set({ pid: r.order[cur], skip: true, at: now() });
        }
      } else {
        // 추리 단계
        if (typeof r.guess === 'string') {
          await db.ref(`relay/${G.sid}/${tid}/done`).set(true);
        } else if (now() > (r.deadline || 0) + 5000) {
          await db.ref(`relay/${G.sid}/${tid}`).update({ guess: '', done: true });
        }
      }
    }
    if (allDone && Object.keys(REL).length && !driving.relayJudge) once('relayJudge', relayJudge);
  });
}

window.relaySkipStep = async tid => {
  const r = REL[tid];
  if (!r || r.done) return;
  const last = r.order.length - 1, cur = r.cur || 0;
  if (cur < last) await db.ref(`relay/${G.sid}/${tid}/steps/${cur}`).set({ pid: r.order[cur], skip: true, at: now() });
  else await db.ref(`relay/${G.sid}/${tid}`).update({ guess: '', done: true });
};

async function relayJudge() {
  await updGame({ phase: 'judge' });
  say('전 작품 출품 완료. 경매사 감정을 시작합니다.');
  const drawCounts = Object.fromEntries(Object.entries(REL).map(([t, r]) => [t, r.order.length - 1]));
  const minDraw = Math.min(...Object.values(drawCounts));

  for (const [tid, r] of Object.entries(REL)) {
    // 추리자가 본 마지막 그림 (skip된 단계는 거슬러 올라가 탐색)
    let finalImg = null, finalIdx = -1;
    for (let i = r.order.length - 2; i >= 0; i--) {
      if (r.steps && r.steps[i] && r.steps[i].img) { finalImg = r.steps[i].img; finalIdx = i; break; }
    }
    let j = { sim: 0, correct: false, comment: '출품작이 없어 감정 불가...' };
    if (finalImg) {
      try {
        const resp = await claudeCall({
          system: `너는 '고장난 전화기 미술관'의 경매사 겸 AI 감정사다.
원본 제시어와 최종 그림의 유사도를 0~1000으로 감정하고, 마지막 주자의 추측이 제시어와 의미상 같으면 정답 처리하라.
comment는 경매사 말투의 위트있는 한 줄 (예: "이 작품, 원작자가 보면 기절하겠군요!").
JSON만: {"sim": 정수0~1000, "correct": true/false, "comment": "한 줄"}`,
          messages: [{ role: 'user', content: [
            { type: 'text', text: `원본 제시어: "${r.prompt}"\n마지막 주자의 추측: "${r.guess || '(무응답)'}"` },
            imgBlock(finalImg)
          ]}],
          max_tokens: 300
        });
        j = parseJSON(claudeText(resp));
        if (!Number.isFinite(Number(j.sim))) throw new Error('감정 결과 파싱 실패: ' + claudeText(resp).slice(0, 80));
      } catch (e) {
        console.error('[relayJudge] 감정 실패:', tName(tid), e);
        j = { sim: 0, correct: false, error: true, comment: '⚠️ 감정 실패 — ' + String(e.message || e).slice(0, 80) };
      }
    }
    // 유사도 70% + 정답 보너스 30% → 릴레이 단계 수 비율 보정 (실패/무출품 시 0점)
    const sim = Math.max(0, Math.min(1000, Number(j.sim) || 0));
    const raw = Math.round(sim * 0.7 + (j.correct ? 300 : 0));
    const finalScore = Math.min(1000, Math.round(raw * (drawCounts[tid] / minDraw)));
    await db.ref(`relayRes/${G.sid}/${tid}`).set({
      prompt: r.prompt, sim, correct: !!j.correct, comment: j.comment || '', error: !!j.error,
      raw, finalScore, drawSteps: drawCounts[tid], minDraw, finalIdx, guess: r.guess || ''
    });
    const guesser = r.order[r.order.length - 1];
    if (j.correct && P[guesser]) await addPScore(guesser, 300);
    pushLog({ g: 'relay', team: tid, player: guesser, name: (P[guesser] || {}).name || '', score: finalScore, note: `제시어 "${r.prompt}" → 추측 "${r.guess || '무응답'}" ${j.correct ? '정답' : '오답'}, 유사도 ${j.sim}` });
  }

  const rr = (await db.ref(`relayRes/${G.sid}`).get()).val() || {};
  const ranked = teamIds().sort((a, b) => ((rr[b] || {}).finalScore || 0) - ((rr[a] || {}).finalScore || 0));
  const announce = `경매 결과 발표! 원작은 바로... ${(G.d || {}).word}! ` +
    ranked.map(t => `${tName(t)}, 낙찰가 ${(rr[t] || {}).finalScore || 0}점`).join('. ');

  await dramaticReveal(announce, '미술품 경매사가 낙찰봉을 두드리듯 극적으로', async () => {
    for (const t of ranked) await addScore(t, (rr[t] || {}).finalScore || 0);
    await updGame({ phase: 'reveal' });
  });
}

window.relayShow = (tid, step) => updGame({ phase: 'show', d: { ...G.d, tid, step } });

function aRelay() {
  const d = G.d || {};
  if (G.phase === 'gen') {
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🖼️</div><h2>큐레이터가 작품 주제를<br>선정하는 중...</h2></div>`;
    return;
  }
  if (G.phase === 'play') {
    stage.innerHTML = `<h2 style="margin-bottom:8px">🖼️ 고장난 전화기 미술관 — 작품 제작 중</h2>
      <div class="muted" style="margin-bottom:14px">제시어는 비밀! 각 팀 마지막 주자가 추리합니다. (단계 수 차이는 점수 자동 보정)</div>
      <div class="relay-board">
        ${teamIds().map(tid => {
          const r = REL[tid];
          if (!r || !r.order) return '';
          const last = r.order.length - 1, cur = r.cur || 0;
          return `<div class="card relay-team">
            <span class="dot" style="width:14px;height:14px;border-radius:50%;background:${tColor(tid)}"></span>
            <b style="min-width:80px">${esc(tName(tid))}</b>
            ${r.order.map((pid, i) => {
              const st = r.steps && r.steps[i];
              const cls = r.done || i < cur ? 'done' : i === cur ? 'current' : '';
              const inner = i === last
                ? (r.done ? '🔎<br>' + esc((r.guess || '무응답').slice(0, 8)) : '🔎<br>추리')
                : st ? (st.skip ? '⏭️' : `<img src="${st.img}">`) : esc((P[pid] || {}).name || '?');
              return `<div class="relay-step ${cls}" title="${esc((P[pid] || {}).name || '')}">${inner}</div>${i < last ? '→' : ''}`;
            }).join('')}
            ${r.done ? '<span style="color:var(--ok);font-weight:800">출품 완료</span>'
              : `<span class="muted" data-dl="${r.deadline}"></span>초
                 <button class="small ghost" onclick="relaySkipStep('${tid}')">⏭️ 현재 주자 건너뛰기</button>`}
          </div>`;
        }).join('')}
      </div>`;
    return;
  }
  if (G.phase === 'judge') {
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🧑‍⚖️</div><h2>경매사 감정 중...</h2>
      <div class="muted">${Object.keys(RELRES).length} / ${teamIds().length} 팀 감정 완료</div></div>`;
    return;
  }
  if (G.phase === 'reveal') {
    const ranked = teamIds().sort((a, b) => ((RELRES[b] || {}).finalScore || 0) - ((RELRES[a] || {}).finalScore || 0));
    stage.innerHTML = `
      <h2 style="margin-bottom:6px">🔨 낙찰 결과 — 원작: 「${esc(d.word || '')}」</h2>
      ${ranked.map((t, i) => {
        const rr = RELRES[t] || {};
        return `<div class="team-result-row card">
          <span style="font-size:26px">${['🥇', '🥈', '🥉'][i] || '🖼️'}</span>
          <span class="dot" style="width:16px;height:16px;border-radius:50%;background:${tColor(t)}"></span>
          <div><b style="font-size:22px">${esc(tName(t))}</b>
            <div class="muted">유사도 ${rr.sim || 0} × 70% ${rr.correct ? '+ 정답 300' : '(추측 "' + esc(rr.guess || '무응답') + '" 오답)'}
            · 단계보정 ×${rr.drawSteps || '?'}/${rr.minDraw || '?'} — "${esc(rr.comment || '')}"</div></div>
          <span class="trs">+${rr.finalScore || 0}</span></div>`;
      }).join('')}
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        ${teamIds().map(t => `<button class="ghost" onclick="relayShow('${t}', -1)">🎞️ ${esc(tName(t))} 변천사 전시</button>`).join('')}
        <button onclick="endGame()">폐관 → 로비</button>
      </div>`;
    return;
  }
  if (G.phase === 'show') {
    // 작품 변천사 슬라이드쇼: -1=원작(제시어) → 0..n-2 그림들 → 마지막=추리 공개
    const tid = d.tid, step = d.step;
    const r = REL[tid] || {};
    const rr = RELRES[tid] || {};
    const lastDraw = (r.order || []).length - 2;
    let inner, caption;
    if (step === -1) {
      inner = `<div style="font-size:54px;font-weight:900;padding:50px">「${esc(r.prompt || '')}」</div>`;
      caption = '제1관 — 원작 (제시어)';
    } else if (step <= lastDraw) {
      const st = (r.steps || {})[step];
      inner = st && st.img ? `<img src="${st.img}">` : `<div style="padding:50px;font-size:30px">⏭️ 유실된 작품 (건너뜀)</div>`;
      caption = `${step + 1}번째 작가 — ${esc((P[(r.order || [])[step]] || {}).name || '?')}`;
    } else {
      inner = `<div style="padding:40px"><div style="font-size:24px;color:#555">마지막 주자의 추리</div>
        <div style="font-size:48px;font-weight:900;color:#222">"${esc(rr.guess || r.guess || '무응답')}"</div>
        <div style="font-size:30px;margin-top:10px">${rr.correct ? '✅ 정답!' : `❌ 원작은 「${esc(r.prompt || '')}」`}</div></div>`;
      caption = '최종 감정 — ' + esc(rr.comment || '');
    }
    stage.innerHTML = `<div class="stage-center">
      <h2>🎞️ ${esc(tName(tid))} — 작품 변천사 전시회</h2>
      <div class="art-frame">${inner}</div>
      <div class="art-caption">${caption}</div>
      <div style="display:flex;gap:10px">
        <button class="ghost" onclick="relayShow('${tid}', ${step - 1})" ${step <= -1 ? 'disabled' : ''}>◀ 이전</button>
        <button onclick="relayShow('${tid}', ${step + 1})" ${step > lastDraw ? 'disabled' : ''}>다음 ▶</button>
        <button class="ghost" onclick="updGame({phase:'reveal'})">결과로 돌아가기</button>
      </div></div>`;
    return;
  }
  stage.innerHTML = '<div class="stage-center"><h2>...</h2></div>';
}

/* ============================================================
   게임 4 — 스피드 OX 서바이벌
   ============================================================ */
const OX_MS = 12000;

async function oxStart() {
  const n = +$('#ox-n').value || 10;
  const sid = 'o' + Date.now().toString(36);
  await setGame({ type: 'ox', sid, phase: 'gen', round: 1, totalRounds: n, d: {} });

  try {
    const resp = await claudeCall({
      system: `'생존 게임'(오징어게임 풍 OX 서바이벌) 출제자. ${n}문제를 JSON 배열로 출제하라.
규칙: 1~3번은 평이한 상식 OX, 중반은 넌센스/착각 유도, 후반은 황당하고 이상한 문제(밸런스 게임 스타일이라도 O/X 정답이 명확해야 함).
모든 문제는 정답이 논란 없이 O 또는 X로 확정되어야 한다. O/X 정답을 골고루 섞을 것. 한국어.
형식: [{"q":"문제","a":"O","why":"한 줄 해설"}, ...] JSON만 출력.`,
      messages: [{ role: 'user', content: `${n}문제 출제` }],
      max_tokens: 2000
    });
    QS = parseJSON(claudeText(resp));
  } catch (e) {
    alert('문제 생성 실패: ' + e.message);
    return endGame();
  }
  await db.ref(`oxq/${sid}`).set(QS); // 새로고침 대비 보관
  // 전원 생존 초기화 + 팀별 초기 인원 기록
  const upd = {};
  const initCount = {};
  activePlayers().forEach(([id, p]) => {
    upd[`alive/${sid}/${id}`] = true;
    initCount[p.team] = (initCount[p.team] || 0) + 1;
  });
  await db.ref().update(upd);
  await updGame({ phase: 'brief', d: { initCount } });
  boom();
  (await ttsMake(`지금부터 생존 게임을 시작합니다. 총 ${n}문제. 틀리면 그 자리에서 탈락합니다. 부디... 살아남으시길.`, '오징어게임 안내방송처럼 차분하고 섬뜩하게'))();
  setTimeout(() => oxNext(0), 5000);
}

async function oxNext(idx) {
  if (!QS[idx]) return oxFinish();
  spoke = {};
  await updGame({ phase: 'q', d: { ...G.d, idx, text: QS[idx].q, deadline: now() + OX_MS, total: QS.length, until: null } });
  say(`문제 ${idx + 1}번!`);
}

function oxDrive() {
  const d = G.d || {};
  if (G.phase === 'q') {
    if (!spoke.w5 && d.deadline - now() < 5000 && d.deadline - now() > 3500) { spoke.w5 = true; say('5초!'); }
    if (now() > d.deadline + 1200) once('oxJudge', () => oxJudge(d.idx));
  }
  if (G.phase === 'judged' && d.until && now() > d.until) {
    once('oxAdv', async () => {
      const aliveN = Object.values(ALIVEMAP).filter(v => v).length;
      if (d.idx + 1 >= QS.length || aliveN === 0) await oxFinish();
      else await oxNext(d.idx + 1);
    });
  }
}

async function oxJudge(idx) {
  const q = QS[idx];
  if (!q) return;
  const answers = ANS[idx] || {};
  const dead = [];
  const upd = {};
  for (const [id, alive] of Object.entries(ALIVEMAP)) {
    if (!alive) continue;
    if (P[id] && P[id].skipped) continue; // 게임 도중 건너뛰기 처리된 사람은 판정 제외
    if (answers[id] !== q.a) {
      upd[`alive/${G.sid}/${id}`] = false;
      dead.push((P[id] || {}).name || id);
    } else {
      await addPScore(id, 50); // 생존 보너스 (개인 기록용)
    }
  }
  if (Object.keys(upd).length) await db.ref().update(upd);
  const aliveN = Object.values({ ...ALIVEMAP, ...Object.fromEntries(Object.entries(upd).map(([k, v]) => [k.split('/').pop(), v])) }).filter(v => v).length;
  await updGame({ phase: 'judged', d: { ...G.d, idx, answer: q.a, why: q.why, dead, aliveN, until: now() + 5000 } });
  if (dead.length) { boom(); say(`탈락자 발생! ${dead.join(', ')} 탈락!`); }
  else { ding(); say('전원 생존!'); }
}

async function oxFinish() {
  const initCount = (G.d || {}).initCount || {};
  const surv = {};
  teamIds().forEach(t => surv[t] = 0);
  for (const [id, alive] of Object.entries(ALIVEMAP)) {
    if (alive && P[id] && P[id].team) surv[P[id].team] = (surv[P[id].team] || 0) + 1;
  }
  // 생존 비율 → 1000점 만점 (인원수 비율 보정 내장)
  const pts = {};
  teamIds().forEach(t => {
    pts[t] = initCount[t] ? Math.round(1000 * surv[t] / initCount[t]) : 0;
  });
  const ranked = teamIds().sort((a, b) => pts[b] - pts[a]);
  for (const t of teamIds()) {
    pushLog({ g: 'ox', team: t, name: tName(t), score: pts[t], note: `생존 ${surv[t]}/${initCount[t] || 0}명` });
  }
  // 끝까지 생존한 개인 보너스
  for (const [id, alive] of Object.entries(ALIVEMAP)) if (alive) await addPScore(id, 300);

  const announce = `생존 게임 종료! ${ranked.map(t => `${tName(t)}, 생존율 점수 ${pts[t]}점`).join('. ')}. 최후의 승자는 ${tName(ranked[0])}!`;
  await dramaticReveal(announce, '서바이벌 게임 진행자처럼 긴장감 있게, 마지막은 환호하며', async () => {
    for (const t of ranked) await addScore(t, pts[t]);
    await updGame({ phase: 'done', d: { ...G.d, surv, pts } });
  });
}

function aOx() {
  const d = G.d || {};
  const aliveN = Object.values(ALIVEMAP).filter(v => v).length;
  const total = Object.keys(ALIVEMAP).length;
  const counter = `<div class="survivor-counter">생존자 <b>${aliveN}</b> / ${total}</div>`;
  if (G.phase === 'gen') {
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🦑</div><h2>문제 제작 중...</h2><div class="muted">AI가 점점 이상해지는 문제를 만들고 있습니다</div></div>`;
    return;
  }
  if (G.phase === 'brief') {
    stage.innerHTML = `<div class="stage-center"><div class="big-emoji">🦑</div><h2>생존 게임</h2>${counter}<div class="muted">틀리면 즉시 탈락. 첫 문제가 곧 공개됩니다...</div></div>`;
    return;
  }
  if (G.phase === 'q') {
    const answered = Object.keys(ANS[d.idx] || {}).length;
    stage.innerHTML = `<div class="stage-center">
      <div class="muted" style="font-size:20px">문제 ${d.idx + 1} / ${d.total}</div>
      <div class="ox-question">${esc(d.text)}</div>
      <div class="mega" data-dl="${d.deadline}">12</div>
      ${counter}
      <div class="muted">응답 ${answered}명 · 무응답도 탈락!</div>
    </div>`;
    return;
  }
  if (G.phase === 'judged') {
    const hasDead = (d.dead || []).length > 0;
    stage.innerHTML = `<div class="stage-center ${hasDead ? 'flash-red' : ''}">
      <h2>정답: <span style="font-size:90px;color:var(--accent)">${esc(d.answer)}</span></h2>
      <div class="muted" style="font-size:19px">${esc(d.why || '')}</div>
      ${hasDead
        ? `<div class="card" style="border-color:var(--danger)"><h2 style="color:var(--danger)">☠️ 탈락자 발생</h2>
           <div style="font-size:24px;margin-top:8px">${d.dead.map(esc).join(' · ')}</div></div>`
        : '<h2 style="color:var(--ok)">🎉 전원 생존!</h2>'}
      <div class="survivor-counter">생존자 <b>${d.aliveN}</b>명</div>
    </div>`;
    return;
  }
  if (G.phase === 'done') {
    const pts = d.pts || {}, surv = d.surv || {}, init = d.initCount || {};
    const ranked = teamIds().sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
    stage.innerHTML = `
      <h2 style="margin-bottom:14px">🦑 생존 게임 최종 결과</h2>
      ${ranked.map((t, i) => `<div class="team-result-row card">
        <span style="font-size:26px">${i === 0 ? '👑' : '☠️'}</span>
        <span class="dot" style="width:16px;height:16px;border-radius:50%;background:${tColor(t)}"></span>
        <b style="font-size:22px">${esc(tName(t))}</b>
        <span class="muted">생존 ${surv[t] || 0} / ${init[t] || 0}명 (비율 보정)</span>
        <span class="trs">+${pts[t] || 0}</span></div>`).join('')}
      <button onclick="endGame()" style="margin-top:14px">게임 종료 → 로비</button>`;
    return;
  }
  stage.innerHTML = '<div class="stage-center"><h2>...</h2></div>';
}

/* ============================================================
   시상식 (메달 수여식 + MVP/굴욕상)
   ============================================================ */
function rAwardsSetup() {
  stage.innerHTML = `<div class="stage-center">
    <div class="big-emoji">🏅</div><h2>메달 수여식</h2>
    <div class="muted">모든 종목이 끝났다면, AI가 전체 게임 기록을 보고<br>MVP상·굴욕상 등 즉석 시상 내역을 생성합니다.</div>
    <button onclick="awardsStart()">🎺 시상식 시작</button>
  </div>`;
}

window.awardsStart = async () => {
  stage.innerHTML = `<div class="stage-center"><div class="big-emoji">📜</div><h2>심사위원단 회의 중...</h2></div>`;
  const logSnap = await db.ref('log').get();
  const logs = Object.values(logSnap.val() || {});
  if (!logs.length) { alert('게임 기록이 없습니다. 게임을 먼저 진행하세요!'); VIEW = 'games'; return render(); }

  const playerSummary = Object.values(P).map(p => `${p.name}(${tName(p.team)}, 누적 ${Math.round(p.score || 0)}점)`).join(', ');
  let list = [];
  try {
    const resp = await claudeCall({
      system: `'게임 올림픽' 시상식 심사위원장. 아래 게임 기록을 보고 재밌는 상 5~6개를 즉석에서 만들어라.
반드시 실제 기록에 근거할 것. 구성: MVP상 1개 + 굴욕상 1개 이상 + 창의적인 상들 (예: "0.01초의 사나이", "최악의 그림상", "오인 체포 전문가").
comment는 게임쇼 MC 톤의 시상 멘트 한 줄.
JSON 배열만: [{"title":"상 이름","player":"닉네임","reason":"수상 근거 한 줄","comment":"시상 멘트"}]`,
      messages: [{ role: 'user', content: `플레이어: ${playerSummary}\n\n게임 기록(g: color=색상헌터/shake=흔들기/relay=그림릴레이/ox=OX):\n${JSON.stringify(logs).slice(0, 12000)}` }],
      max_tokens: 1500
    });
    list = parseJSON(claudeText(resp));
  } catch (e) {
    alert('시상 내역 생성 실패: ' + e.message);
    VIEW = 'awards'; return render();
  }
  await db.ref('awards').set({ list, n: 0 });
  await setGame({ type: 'awards', phase: 'ceremony', sid: 'a' + Date.now().toString(36) });
};

let AWD = null;
db.ref('awards').on('value', s => { AWD = s.val(); render(); });

function aAwards() {
  const list = (AWD && AWD.list) || [];
  const n = (AWD && AWD.n) || 0;
  const ranked = teamIds().sort((a, b) => (SCORES[b] || 0) - (SCORES[a] || 0));
  stage.innerHTML = `<div class="stage-center">
    <h2>🏅 제26회 화계LT 메달 수여식</h2>
    <div style="display:flex;gap:18px;align-items:flex-end">
      ${ranked.slice(0, 3).map((t, i) => `
        <div class="card" style="text-align:center;padding:${[26, 18, 12][i]}px 30px;order:${[2, 1, 3][i]}">
          <div style="font-size:${[64, 48, 40][i]}px">${['🥇', '🥈', '🥉'][i]}</div>
          <b style="font-size:${[26, 20, 18][i]}px;color:${tColor(t)}">${esc(tName(t))}</b>
          <div class="muted">${fmtScore(Math.round(SCORES[t] || 0))}점</div>
        </div>`).join('')}
    </div>
    <div style="width:100%;max-width:760px">
      ${list.slice(0, n).map(a => `<div class="card team-result-row">🏆 <b>${esc(a.title)}</b>
        <span style="color:var(--accent);font-weight:900">${esc(a.player)}</span>
        <span class="muted">${esc(a.reason || '')}</span></div>`).join('')}
    </div>
    ${n < list.length
      ? `<button onclick="revealAward()">🎺 다음 시상 (${n + 1}/${list.length})</button>`
      : `<h2 style="color:var(--accent)">🎆 폐회를 선언합니다! 🎆</h2><button class="ghost" onclick="endGame()">로비로</button>`}
  </div>`;
}

window.revealAward = async () => {
  const list = (AWD && AWD.list) || [];
  const n = (AWD && AWD.n) || 0;
  const a = list[n];
  if (!a) return;
  const announce = `${a.title}! 수상자는... ${a.player}! ${a.comment || a.reason || ''}`;
  overlay(`<div class="drum"><div class="drum-emoji">🥁</div>${esc(a.title)}<br>수상자는 과연...?</div>`);
  drumroll(3000);
  const playP = ttsMake(announce, '시상식 MC처럼 뜸을 들이다 폭발적으로 환호하며');
  await sleep(3000);
  overlay(`<div class="award-card card">
    <div class="a-title">🏆 ${esc(a.title)}</div>
    <div class="a-winner">${esc(a.player)}</div>
    <div class="a-reason">${esc(a.reason || '')}</div>
    <div style="margin-top:10px;font-size:18px">"${esc(a.comment || '')}"</div>
    <button onclick="hideOverlay()" style="margin-top:18px">다음으로</button>
  </div>`);
  ding();
  playP.then(p => p());
  await db.ref('awards/n').set(n + 1);
};

/* ---------------- 설정 (로컬 개발용 API 키) ---------------- */
function openSettings() {
  const ak = localStorage.getItem('hw_anthropic_key') || '';
  const gk = localStorage.getItem('hw_gemini_key') || '';
  overlay(`<div class="card" style="max-width:560px;text-align:left">
    <h3>⚙️ 설정</h3>
    <p class="muted" style="margin:10px 0">Vercel 배포 시에는 환경변수(ANTHROPIC_API_KEY, GEMINI_API_KEY)가 사용되며 아래 입력은 필요 없습니다.<br>
    <b>로컬 정적 실행</b>(서버리스 없음)일 때만 임시로 키를 입력하세요. 이 브라우저에만 저장됩니다.</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="set-ak" placeholder="Anthropic API Key (로컬 테스트용)" value="${esc(ak)}">
      <input id="set-gk" placeholder="Gemini API Key (로컬 테스트용)" value="${esc(gk)}">
      <div style="display:flex;gap:10px">
        <button onclick="saveSettings()">저장</button>
        <button class="ghost" onclick="hideOverlay()">닫기</button>
      </div>
    </div></div>`);
}
window.saveSettings = () => {
  const ak = $('#set-ak').value.trim(), gk = $('#set-gk').value.trim();
  ak ? localStorage.setItem('hw_anthropic_key', ak) : localStorage.removeItem('hw_anthropic_key');
  gk ? localStorage.setItem('hw_gemini_key', gk) : localStorage.removeItem('hw_gemini_key');
  hideOverlay();
};

// 게임 카드 버튼에서 호출할 수 있도록 전역 노출
window.colorStart = colorStart;
window.shakeStart = shakeStart;
window.relayStart = relayStart;
window.oxStart = oxStart;
window.once = once;
window.colorJudge = colorJudge;
window.updGame = updGame;
