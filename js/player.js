/* ============================================================
   26화계LT — 플레이어(폰) 앱
   - 닉네임+PIN 로그인 / localStorage 자동 로그인
   - 게임 상태(game 노드)를 구독해서 순수 상태 기반 렌더링
     → 새로고침/재접속해도 진행 중 라운드로 자동 복귀
   ============================================================ */

let me = null;             // { id, name, p: players/{id} 데이터 }
let TEAMS = {};
let G = { type: 'idle' };  // 현재 게임 상태
let R = null;              // 그림 릴레이: 내 팀의 relay 노드
let RES = {};              // 채점 결과 res/{sid}
let RELRES = {};           // 릴레이 결과
let ALIVE = true;          // OX 생존 여부
let AWARDS = null;
let renderKey = '';
let flags = {};            // 제출 완료 등 라운드별 로컬 상태
let attached = { sid: null, off: [] };

const app = document.getElementById('app');

window.addEventListener('load', () => {
  startTicker();
  const saved = JSON.parse(localStorage.getItem('hw_login') || 'null');
  if (saved && saved.name && saved.pin) login(saved.name, saved.pin, true);
  else showLogin();
});

/* ---------------- 로그인 ---------------- */
function showLogin(msg = '') {
  document.body.className = 'player';
  app.innerHTML = `
    <div class="p-main">
      <div class="login-title">🏟️ 26화계LT<small>게임 올림픽에 오신 것을 환영합니다</small></div>
      <div class="login-box card">
        <input id="li-name" placeholder="닉네임" maxlength="12" autocomplete="off">
        <input id="li-pin" placeholder="PIN (숫자 4자리)" inputmode="numeric" maxlength="4" type="password">
        <div class="err">${esc(msg)}</div>
        <button id="li-btn">입장하기</button>
        <div class="muted" style="text-align:center">처음이면 자동 등록 · 재접속이면 같은 닉네임+PIN</div>
      </div>
    </div>`;
  $('#li-btn').onclick = () => login($('#li-name').value, $('#li-pin').value, false);
  $('#li-pin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#li-btn').click(); });
}

async function login(name, pin, silent) {
  name = String(name || '').trim();
  pin = String(pin || '').trim();
  if (name.length < 1) return silent ? showLogin() : showLogin('닉네임을 입력하세요');
  if (!/^\d{4}$/.test(pin)) return silent ? showLogin() : showLogin('PIN은 숫자 4자리입니다');

  const id = pidOf(name);
  try {
    const snap = await db.ref('players/' + id).get();
    if (snap.exists()) {
      // 기존 플레이어 → PIN 검증 후 복원
      if (snap.val().pin !== pin) {
        localStorage.removeItem('hw_login');
        return showLogin(silent ? '저장된 로그인이 만료되었습니다. 다시 로그인하세요' : 'PIN이 틀렸습니다 (이미 등록된 닉네임)');
      }
    } else {
      await db.ref('players/' + id).set({
        name, pin, team: null, score: 0, skipped: false,
        createdAt: TS(), lastSeen: TS()
      });
    }
    localStorage.setItem('hw_login', JSON.stringify({ name, pin }));
    me = { id, name, p: snap.val() || {} };
    startApp();
  } catch (e) {
    showLogin('접속 오류: ' + e.message);
  }
}

function logout() {
  localStorage.removeItem('hw_login');
  location.reload();
}

/* ---------------- 앱 시작: 리스너 + 하트비트 ---------------- */
function startApp() {
  // 접속 상태 표시용 하트비트
  const seen = () => db.ref(`players/${me.id}/lastSeen`).set(TS()).catch(() => {});
  seen();
  setInterval(seen, 10000);
  db.ref(`players/${me.id}/lastSeen`).onDisconnect().set(TS());

  db.ref('players/' + me.id).on('value', s => {
    if (!s.exists()) { logout(); return; } // 관리자가 삭제한 경우
    me.p = s.val();
    render();
  });
  db.ref('teams').on('value', s => { TEAMS = s.val() || {}; render(); });
  db.ref('awards').on('value', s => { AWARDS = s.val(); render(); });
  db.ref('game').on('value', s => {
    G = s.val() || { type: 'idle' };
    ensureGameListeners();
    render();
  });
}

// 게임 세션(sid)별 추가 리스너 (릴레이 팀 노드, 결과, OX 생존)
function ensureGameListeners() {
  if (!G.sid || attached.sid === G.sid) return;
  attached.off.forEach(f => f());
  attached = { sid: G.sid, off: [] };
  R = null; RES = {}; RELRES = {}; ALIVE = true;

  const listen = (path, cb) => {
    const ref = db.ref(path);
    const h = ref.on('value', s => { cb(s); render(); });
    attached.off.push(() => ref.off('value', h));
  };

  listen(`res/${G.sid}`, s => { RES = s.val() || {}; });
  if (G.type === 'relay') {
    const tid = me.p && me.p.team;
    if (tid) listen(`relay/${G.sid}/${tid}`, s => { R = s.val(); });
    listen(`relayRes/${G.sid}`, s => { RELRES = s.val() || {}; });
  }
  if (G.type === 'ox') {
    listen(`alive/${G.sid}/${me.id}`, s => { ALIVE = s.val() !== false; });
  }
}

/* ---------------- 렌더링 (상태 키 기반) ---------------- */
function render() {
  if (!me || !me.p) return;
  const d = G.d || {};
  const k = [G.type, G.phase, G.round, G.sid, d.idx, d.targetAt, d.endsAt,
             R && R.cur, R && R.done, ALIVE, AWARDS && AWARDS.n,
             me.p.team, me.p.skipped, JSON.stringify(Object.keys(RES)), JSON.stringify(Object.keys(RELRES))].join('|');
  if (k === renderKey) return;
  renderKey = k;
  stopColorCam(); // 화면 전환 시 라이브 카메라 정리 (필요하면 색상 play 화면이 다시 켬)

  const theme = { color: 'theme-color', shake: 'theme-shake', relay: 'theme-relay', ox: 'theme-ox', awards: 'theme-awards' }[G.type] || '';
  document.body.className = 'player ' + theme;

  const fn = { color: rColor, shake: rShake, relay: rRelay, ox: rOx, awards: rAwards }[G.type] || rIdle;
  app.innerHTML = headHTML() + '<div class="p-main" id="pm"></div>';
  fn($('#pm'));
}

function headHTML() {
  const t = TEAMS[me.p.team];
  const tag = t ? `<span class="team-tag" style="--tc:${t.color}">${esc(t.name)}</span>` : '<span class="team-tag">미배정</span>';
  return `<div class="p-head">
    <div><span class="who">${esc(me.name)}</span>${tag}</div>
    <div class="my-score">내 점수 <b>${fmtScore(Math.round(me.p.score || 0))}</b></div>
  </div>`;
}

function skippedHTML(pm) {
  pm.innerHTML = `<div class="big-emoji">⏭️</div><h2>이번 게임에서 제외되었습니다</h2>
    <div class="muted">관리자가 건너뛰기를 해제하면 다시 참여할 수 있어요</div>`;
}

/* ---------------- 대기 화면 ---------------- */
function rIdle(pm) {
  pm.innerHTML = `
    <div class="big-emoji">🏟️</div>
    <h2>게임 올림픽<br>대기 중...</h2>
    <div class="muted">${me.p.team ? 'TV 화면을 봐주세요. 곧 경기가 시작됩니다!' : '관리자가 팀을 배정하면 표시됩니다'}</div>
    <button class="ghost small" onclick="logout()">다른 닉네임으로 로그인</button>`;
}

/* ---------------- 게임 1: 색상 헌터 (수사대) ---------------- */
function rColor(pm) {
  if (me.p.skipped) return skippedHTML(pm);
  const d = G.d || {};
  if (G.phase === 'brief') {
    pm.innerHTML = `<div class="big-emoji">🚨</div><h2>긴급 출동!<br>색상 수사대</h2>
      <div class="muted">곧 용의 색상이 공개됩니다. 카메라를 준비하세요!</div>`;
    return;
  }
  if (G.phase === 'play') {
    const fkey = 'c' + G.sid + G.round;
    checkMySub(`sub/${G.sid}/${G.round}/${me.id}`, fkey);
    if (flags[fkey] === true) {
      pm.innerHTML = `<div class="big-emoji">📁</div><h2>증거물 접수 완료</h2>
        <div class="muted">감식반의 분석을 기다리는 중...</div>`;
      return;
    }
    pm.innerHTML = `
      <h2>🚔 용의 색상 수배 중</h2>
      <div class="muted">목표 색 <b style="color:${esc(d.target)}">${esc(d.target)}</b> — 원형 조준경 안에 색을 맞추고 촬영! (가운데 원만 판별됩니다)</div>
      <div class="cam-circle" id="cam-circle" style="border:6px solid ${esc(d.target)}">
        <video id="cam-video" autoplay playsinline muted></video>
        <div class="cam-reticle"></div>
      </div>
      <div class="big-timer" data-dl="${d.endsAt}">60</div>
      <button id="cam-shot" disabled>📷 조준경 색 촬영</button>
      <div class="muted" id="cam-status">카메라 준비 중...</div>`;
    startColorCam(d.target, async (img, avg) => {
      const st = $('#cam-status'); if (st) st.textContent = '📤 전송 중...';
      await db.ref(`sub/${G.sid}/${G.round}/${me.id}`).set({ img, avg: avg || null, at: now() });
      flags[fkey] = true; renderKey = ''; render();
    });
    return;
  }
  if (G.phase === 'judge') {
    pm.innerHTML = `<div class="big-emoji">🔬</div><h2>감식 진행 중...</h2><div class="muted">AI 감식반이 증거물을 분석하고 있습니다</div>`;
    return;
  }
  if (G.phase === 'reveal' || G.phase === 'done') {
    const r = RES[G.round] && RES[G.round][me.id];
    if (!r) { pm.innerHTML = `<div class="big-emoji">🕵️</div><h2>감식 결과 대기</h2><div class="muted">TV 화면을 확인하세요</div>`; return; }
    pm.innerHTML = `<h2>감식 결과</h2>
      <div class="score-pop">${fmtScore(r.score)}점</div>
      <div class="card" style="max-width:340px"><div class="muted">"${esc(r.comment || '')}"</div></div>
      <div class="muted">TV에서 팀 결과를 확인하세요!</div>`;
    return;
  }
  rIdle(pm);
}

/* ---------------- 게임 2: 정각에 흔들어 (관제센터) ---------------- */
let motionBound = false;
function rShake(pm) {
  if (me.p.skipped) return skippedHTML(pm);
  const d = G.d || {};
  if (G.phase === 'arm') {
    const ready = flags['ready' + G.sid + G.round];
    pm.innerHTML = `
      <div class="big-emoji">🚀</div><h2>발사 관제센터</h2>
      <div class="muted">기체(폰)의 가속도 센서를 점검하세요.<br>iOS는 권한 허용이 필요합니다.</div>
      ${ready
        ? '<div class="card" style="color:var(--ok);font-weight:800">✅ 센서 점검 완료 — 발사 대기</div>'
        : '<button id="arm-btn">🛰️ 센서 점검 (탭하세요)</button>'}`;
    if (!ready) $('#arm-btn').onclick = enableMotion;
    return;
  }
  if (G.phase === 'count') {
    const fkey = 'shk' + G.sid + G.round;
    checkMySub(`sub/${G.sid}/${G.round}/${me.id}`, fkey);
    if (flags[fkey] === true) {
      pm.innerHTML = `<div class="big-emoji">📡</div><h2>점화 기록 전송 완료</h2><div class="muted">관제센터의 판정을 기다리세요</div>`;
      return;
    }
    pm.innerHTML = `
      <h2>🚀 점화 카운트다운</h2>
      <div class="big-timer" data-dl="${d.targetAt}" data-fmt="t">T-0.0</div>
      <div class="card"><b>T-0.0 정각</b>에 폰을 힘차게 흔드세요!<br><span class="muted">단 한 번만 기록됩니다 — 너무 빠르거나 늦으면 감점</span></div>`;
    return;
  }
  if (G.phase === 'reveal' || G.phase === 'done') {
    const r = RES[G.round] && RES[G.round][me.id];
    if (!r) { pm.innerHTML = `<div class="big-emoji">🛰️</div><h2>관제 판정 대기</h2><div class="muted">TV를 확인하세요</div>`; return; }
    const ok = r.score >= 500;
    pm.innerHTML = `<h2>${ok ? '🛸 궤도 진입!' : '💥 항로 이탈'}</h2>
      <div class="score-pop">${fmtScore(r.score)}점</div>
      <div class="muted">오차 ${r.miss ? '기록 없음 (미점화)' : (r.delta > 0 ? '+' : '') + r.delta + 'ms'}</div>`;
    return;
  }
  rIdle(pm);
}

async function enableMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const p = await DeviceMotionEvent.requestPermission(); // iOS Safari
      if (p !== 'granted') return alert('센서 권한이 거부되었습니다. 설정에서 허용해주세요.');
    }
    if (!motionBound) { window.addEventListener('devicemotion', onMotion); motionBound = true; }
    await db.ref(`ready/${G.sid}/${me.id}`).set(true);
    flags['ready' + G.sid + G.round] = true;
    renderKey = ''; render();
  } catch (e) {
    alert('센서를 사용할 수 없습니다: ' + e.message);
  }
}

function onMotion(e) {
  if (G.type !== 'shake' || G.phase !== 'count') return;
  const fkey = 'shk' + G.sid + G.round;
  if (flags[fkey] === true || flags[fkey] === 'sending') return;
  const t = G.d && G.d.targetAt;
  if (!t) return;
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const m = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  if (Math.abs(m - 9.81) > 11) { // 흔들기 감지 임계값
    flags[fkey] = 'sending';
    const at = now();
    db.ref(`sub/${G.sid}/${G.round}/${me.id}`).set({ delta: Math.round(at - t), at })
      .then(() => { flags[fkey] = true; renderKey = ''; render(); });
  }
}

/* ---------------- 게임 3: 그림 릴레이 (미술관) ---------------- */
function rRelay(pm) {
  if (me.p.skipped) return skippedHTML(pm);
  if (G.phase === 'gen') {
    pm.innerHTML = `<div class="big-emoji">🖼️</div><h2>고장난 전화기 미술관</h2><div class="muted">큐레이터가 작품 주제를 정하는 중...</div>`;
    return;
  }
  if (G.phase === 'play') {
    if (!me.p.team || !R || !R.order) {
      pm.innerHTML = `<div class="big-emoji">🖼️</div><h2>전시 준비 중...</h2>`;
      return;
    }
    const myIdx = R.order.indexOf(me.id);
    const cur = R.cur || 0;
    const last = R.order.length - 1;
    if (R.done) { pm.innerHTML = `<div class="big-emoji">🏛️</div><h2>우리 팀 작품 출품 완료!</h2><div class="muted">다른 팀을 기다리는 중...</div>`; return; }
    if (myIdx === -1) { pm.innerHTML = `<div class="big-emoji">👀</div><h2>관람객 모드</h2><div class="muted">이번 릴레이에는 순번이 없습니다</div>`; return; }
    if (myIdx < cur) { pm.innerHTML = `<div class="big-emoji">✅</div><h2>내 차례 완료</h2><div class="muted">${cur + 1}번 작가가 작업 중입니다</div>`; return; }
    if (myIdx > cur) {
      pm.innerHTML = `<div class="big-emoji">🪑</div><h2>대기 중</h2>
        <div class="muted">현재 ${cur + 1}번째 ${cur === last ? '(추리)' : '작가'} 차례 · 나는 ${myIdx + 1}번째</div>
        <div class="card">⚠️ 내 차례가 오기 전까지 절대 앞 그림을 훔쳐보지 마세요!</div>`;
      return;
    }
    // 내 차례!
    if (cur < last) {
      // 그리기 차례: 종이에 그리고 → 촬영 업로드
      const src = cur === 0
        ? `<h2>📜 비밀 제시어</h2><div class="card" style="font-size:34px;font-weight:900;color:var(--accent)">${esc(R.prompt)}</div>`
        : `<h2>🖼️ 이전 작가의 작품</h2><img class="relay-prev-img" src="${R.steps[cur - 1] && R.steps[cur - 1].img || ''}" alt="이전 그림">`;
      pm.innerHTML = `${src}
        <div class="big-timer" data-dl="${R.deadline}">40</div>
        <div class="muted">종이에 그린 뒤 사진을 찍어 제출하세요 (그리기 40초)</div>
        ${camHTML('작품 제출')}`;
      bindCam(async img => {
        await db.ref(`relay/${G.sid}/${me.p.team}/steps/${cur}`).set({ pid: me.id, img, at: now() });
      });
    } else {
      // 마지막 주자: 추리
      pm.innerHTML = `<h2>🔎 이 작품의 원작은?</h2>
        <img class="relay-prev-img" src="${R.steps[cur - 1] && R.steps[cur - 1].img || ''}" alt="최종 그림">
        <div class="big-timer" data-dl="${R.deadline}">30</div>
        <input id="guess-in" placeholder="제시어를 추측해보세요" style="width:100%;text-align:center">
        <button id="guess-btn">추리 제출</button>`;
      $('#guess-btn').onclick = async () => {
        const v = $('#guess-in').value.trim();
        if (!v) return;
        $('#guess-btn').disabled = true;
        await db.ref(`relay/${G.sid}/${me.p.team}`).update({ guess: v });
      };
    }
    return;
  }
  if (G.phase === 'judge') {
    pm.innerHTML = `<div class="big-emoji">🧑‍⚖️</div><h2>경매사 감정 중...</h2><div class="muted">AI 큐레이터가 작품을 감정하고 있습니다</div>`;
    return;
  }
  if (G.phase === 'reveal' || G.phase === 'show' || G.phase === 'done') {
    const r = me.p.team && RELRES[me.p.team];
    pm.innerHTML = `<div class="big-emoji">🏛️</div>
      ${r ? `<h2>우리 팀 낙찰가</h2><div class="score-pop">${fmtScore(r.finalScore)}점</div>
             <div class="muted">원작: <b>${esc(r.prompt || '')}</b> · 추리 ${r.correct ? '✅ 적중!' : '❌ 빗나감'}</div>`
          : '<h2>감정 결과 대기</h2>'}
      <div class="muted">TV에서 작품 변천사 전시회를 감상하세요!</div>`;
    return;
  }
  rIdle(pm);
}

/* ---------------- 게임 4: 스피드 OX (생존게임) ---------------- */
function rOx(pm) {
  if (me.p.skipped) return skippedHTML(pm);
  const d = G.d || {};
  if (G.phase === 'gen' || G.phase === 'brief') {
    pm.innerHTML = `<div class="big-emoji">🦑</div><h2>생존 게임</h2><div class="muted">곧 첫 문제가 출제됩니다.<br>틀리면 그 자리에서 탈락입니다.</div>`;
    return;
  }
  if (!ALIVE && G.phase !== 'done') {
    pm.innerHTML = `<div class="dead-screen"><h1>💀 탈락</h1><div>당신은 게임에서 제외되었습니다</div><div class="muted">남은 생존자들을 응원하세요...</div></div>`;
    return;
  }
  if (G.phase === 'q') {
    const fkey = 'ox' + G.sid + d.idx;
    const picked = flags[fkey];
    pm.innerHTML = `
      <div class="muted">문제 ${d.idx + 1} / ${d.total}</div>
      <h2 style="font-size:21px">${esc(d.text)}</h2>
      <div class="big-timer" data-dl="${d.deadline}">10</div>
      <div class="ox-btns">
        <button class="o ${picked === 'O' ? 'picked' : ''}" id="ox-o">O</button>
        <button class="x ${picked === 'X' ? 'picked' : ''}" id="ox-x">X</button>
      </div>
      ${picked ? '<div class="muted">선택 완료! 마감 전까지 변경 가능</div>' : '<div class="muted">시간 안에 선택하지 않으면 탈락!</div>'}`;
    const pick = v => async () => {
      flags[fkey] = v;
      renderKey = ''; render();
      await db.ref(`ans/${G.sid}/${d.idx}/${me.id}`).set(v);
    };
    $('#ox-o').onclick = pick('O');
    $('#ox-x').onclick = pick('X');
    return;
  }
  if (G.phase === 'judged') {
    pm.innerHTML = `<h2>정답: <span style="font-size:54px;color:var(--accent)">${esc(d.answer)}</span></h2>
      <div class="muted">${esc(d.why || '')}</div>
      <div class="card" style="color:var(--ok);font-weight:800">🎉 생존! 다음 문제를 준비하세요</div>`;
    return;
  }
  if (G.phase === 'done') {
    pm.innerHTML = `<div class="big-emoji">${ALIVE ? '🏆' : '💀'}</div>
      <h2>${ALIVE ? '최후의 생존자!' : '아쉽게 탈락'}</h2>
      <div class="muted">TV에서 팀 결과를 확인하세요</div>`;
    return;
  }
  rIdle(pm);
}

/* ---------------- 시상식 ---------------- */
function rAwards(pm) {
  const list = (AWARDS && AWARDS.list) || [];
  const n = (AWARDS && AWARDS.n) || 0;
  const mine = list.slice(0, n).filter(a => a.player === me.name || pidOf(a.player || '') === me.id);
  pm.innerHTML = `
    <div class="big-emoji">🏅</div><h2>시상식 진행 중</h2>
    ${mine.length ? mine.map(a => `<div class="card" style="border-color:var(--accent)">
        <div style="font-size:22px;font-weight:900;color:var(--accent)">🏆 ${esc(a.title)}</div>
        <div class="muted">${esc(a.reason || '')}</div></div>`).join('')
      : '<div class="muted">TV 화면을 주목하세요!</div>'}`;
}

/* ---------------- 색상 수사대: 원형 라이브 카메라 ---------------- */
let colorStream = null;
function stopColorCam() {
  if (colorStream) {
    try { colorStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    colorStream = null;
  }
}

async function startColorCam(targetHex, onCapture) {
  const video = $('#cam-video');
  const btn = $('#cam-shot');
  const st = $('#cam-status');
  if (!video || !btn) return;

  // 라이브 카메라 불가 시 기존 파일 촬영으로 대체
  const useFileFallback = msg => {
    const circle = $('#cam-circle');
    if (circle) circle.innerHTML = `<div style="color:#fff;font-size:13px;padding:18px;text-align:center;line-height:1.5">${esc(msg || '카메라를 열 수 없어요')}<br>아래 버튼으로 촬영하세요</div>`;
    btn.outerHTML = `<label class="cam-btn" style="display:inline-flex">📷 증거물 촬영<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>`;
    bindCam(async img => onCapture(img, null));
  };

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return useFileFallback('이 브라우저는 라이브 카메라를 지원하지 않아요');
  }
  try {
    stopColorCam();
    colorStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    video.srcObject = colorStream;
    await video.play().catch(() => {});
    btn.disabled = false;
    if (st) st.textContent = '원형 조준경을 목표 색 물건에 맞추고 촬영하세요';
    btn.onclick = () => {
      const res = captureColorCircle(video);
      if (!res) { if (st) st.textContent = '촬영 실패 — 다시 시도하세요'; return; }
      btn.disabled = true;
      stopColorCam();
      onCapture(res.img, res.avg);
    };
  } catch (e) {
    console.error('[color cam] getUserMedia 실패', e);
    stopColorCam();
    useFileFallback('카메라 권한이 거부되었거나 사용 중이에요 (' + (e.name || e.message || '') + ')');
  }
}

// 비디오 중앙 원형 영역을 크롭 + 평균색 계산 → 원형 JPEG dataURL
function captureColorCircle(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const side = Math.min(vw, vh) * 0.7;          // 조준경 지름에 해당하는 원본 영역
  const sx = (vw - side) / 2, sy = (vh - side) / 2;
  const out = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = out;
  const ctx = cv.getContext('2d');
  const cx = out / 2, cy = out / 2, rad = out / 2;

  // 1) 중앙 영역을 그려 원 안쪽 픽셀의 평균색 계산
  ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  const data = ctx.getImageData(0, 0, out, out).data;
  let r = 0, g = 0, b = 0, c = 0;
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) {
        const i = (y * out + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
  }
  r = Math.round(r / c); g = Math.round(g / c); b = Math.round(b / c);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  // 2) 원 바깥은 평균색으로 채우고 원 안에만 실제 영상 → 원형 사진 완성
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, out, out);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  ctx.restore();
  return { img: cv.toDataURL('image/jpeg', 0.85), avg: hex };
}

/* ---------------- 헬퍼 ---------------- */
// 카메라 입력 버튼
function camHTML(label) {
  return `<label class="cam-btn">📷 ${esc(label)}<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
    <div class="muted" id="cam-status"></div>`;
}
function bindCam(cb) {
  const c = document.getElementById('cam');
  if (!c) return;
  c.onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const st = $('#cam-status');
    if (st) st.textContent = '📤 사진 압축/전송 중...';
    try {
      const img = await compressImage(f);
      await cb(img);
    } catch (err) {
      if (st) st.textContent = '전송 실패, 다시 시도하세요: ' + err.message;
    }
  };
}

// 재접속 시 내 제출 여부 복원 (한 번만 조회)
function checkMySub(path, fkey) {
  if (flags[fkey] !== undefined) return;
  flags[fkey] = 'pending';
  db.ref(path).get().then(s => {
    flags[fkey] = s.exists();
    renderKey = ''; render();
  }).catch(() => { flags[fkey] = undefined; });
}
