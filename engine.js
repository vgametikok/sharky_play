/* ============================================================
   SHARKY — ИГРОВОЙ ДВИЖОК (engine.js)
   Правила загрузки и отображения игр в ленте: построение карточек,
   загрузка игры в iframe (с фиксом Content-Type через srcdoc),
   обработка ошибок, протокол postMessage, навигация (свайпы),
   пауза/плей и «скрыть интерфейс».

   НЕ редактируй этот файл ради изменений внешнего вида/UI —
   для этого есть index.html. Здесь только «как игра попадает на экран
   и как ей управлять». Подключается в index.html ПЕРЕД основным скриптом.

   Использует глобальные переменные и помощники из index.html
   (GAMES, iframes, currentIdx, AUTHORS, escHtml, getBest и т.д.) —
   они уже определены к моменту, когда эти функции реально вызываются.
   ============================================================ */

function buildHeadHTML(i, g) {
  const a = AUTHORS[g.author_id] || {};
  const verified = a.is_virtual ? verifiedSVG() : '';
  const when = timeAgo(g.created_at);
  const desc = g.description ? `<div class="ov-desc">${escHtml(g.description)}</div>` : '';
  const cat = g.category || 'Аркада';
  const best = getBest(g.id);
  // «играли» = число сессий dwell>=3с (как просмотры на YouTube). Считаем в
  // socialData[g.id].plays (loadPlayCounts). Плашку рисуем ТОЛЬКО когда есть
  // данные (>0); счётчики загружаются до buildDeck, так что значение уже готово.
  const plays = ((typeof socialData !== 'undefined' && socialData[g.id]) ? socialData[g.id].plays : 0) || 0;
  const playsTag = plays > 0
    ? `<span class="ov-tag ov-plays" id="plays-${i}"><span class="ov-live-dot"></span>${fmt(plays)} играли</span>`
    : '';
  return `
    <div class="ov-author" onclick="openProfile('${g.author_id}')">
      <div class="ov-av" style="background:${cssColor(a.ring||'#7b5cff')}">${escHtml(a.emoji||'🎮')}</div>
      <div class="ov-author-meta">
        <div class="ov-name">${escHtml(a.name||'Sharky')} ${verified}</div>
        ${when ? `<div class="ov-time">${when}</div>` : ''}
      </div>
    </div>
    <div class="ov-title">${escHtml(g.title)}</div>
    ${desc}
    <div class="ov-tags">
      <span class="ov-tag">${escHtml(cat)}</span>
      ${playsTag}
    </div>
    <div class="ov-score-wrap">
      <div class="ov-score-label">Счёт</div>
      <div class="ov-score-row">
        <div class="ov-score" id="score-${i}">0</div>
        <div class="ov-best">Рекорд <b id="best-${i}">${best}</b></div>
      </div>
    </div>`;
}

// Стандартный индикатор загрузки игры — три мигающие точки (как на стартовом экране).
// Не зависит от данных игры: раньше показывался emoji, которого у части игр в базе нет,
// и плейсхолдер выглядел как пустой чёрный экран.
function arenaLoadingHTML() {
  return '<div class="arena-loading"><div class="ld-dots"><div class="ld-dot"></div><div class="ld-dot"></div><div class="ld-dot"></div></div></div>';
}

function buildDeck() {
  GAMES.forEach((g, i) => {
    const card = document.createElement('div');
    card.className = `card ${i===0?'active':'below'}`;
    card.style.background = g.bg;
    card.style.setProperty('--card-ac', g.accent);

    const arena = document.createElement('div');
    arena.className = 'arena'; arena.id = `arena-${i}`;
    arena.innerHTML = arenaLoadingHTML();
    card.appendChild(arena);

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = buildHeadHTML(i, g);
    card.appendChild(head);

    const socialCol = document.createElement('div');
    socialCol.className = 'social-col'; socialCol.id = `scol-${i}`;
    socialCol.innerHTML = buildSocialHTML(i, g);
    card.appendChild(socialCol);

    deckEl.appendChild(card);
    cardEls.push(card);
    iframes.push(null);
  });
}

// ══ IFRAME MANAGEMENT ══
// Supabase Storage serves uploaded .html with Content-Type: text/plain, so a plain
// iframe.src would show the game as raw TEXT. For cross-origin sources we fetch the
// HTML and inject it via srcdoc, which always renders as a real page. Same-origin
// games (GitHub Pages, served as text/html) keep using src unchanged.
function loadGameInto(iframe, g) {
  // Cache-busting по версии игры: после обновления (games.version++) игроки
  // получают свежий файл, а не закешированный HTTP-кешем старый.
  const url = g.src + (g.src.includes('?') ? '&' : '?') + 'v=' + (g.version || 1);
  let cross = false;
  try { cross = new URL(g.src, location.href).origin !== location.origin; } catch(e) { cross = true; }
  if (!cross) { iframe.src = url; return; }
  fetch(url)
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
    .then(html => { iframe.srcdoc = html; })
    .catch(() => { iframe.src = url; }); // fallback (e.g. CORS blocked)
}

function preload(idx) {
  for (let i = Math.max(0, idx - BEHIND); i <= Math.min(GAMES.length-1, idx + AHEAD); i++) {
    if (iframes[i]) continue;
    const arena = document.getElementById(`arena-${i}`);
    if (!arena) continue;
    const g = GAMES[i];
    if (!arena.querySelector('.arena-loading')) {
      arena.innerHTML = arenaLoadingHTML();
    }
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    // SECURITY: sandbox WITHOUT allow-same-origin → the game runs in an opaque origin
    // and cannot reach into the parent app (DOM, the Supabase client, the user session,
    // localStorage). Games only talk to the shell via parent.postMessage, which still
    // works across origins, so this does not break the postMessage protocol.
    // Critical for untrusted uploaded/UGC games. Do NOT add allow-same-origin here —
    // combined with allow-scripts it would let a game remove its own sandbox.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('scrolling', 'no');
    let done = false;
    const timer = setTimeout(() => {
      if (done || iframes[i] !== iframe) return;
      done = true;
      showArenaError(i);
    }, 12000);
    iframe.addEventListener('load', () => {
      if (done || iframes[i] !== iframe) return;
      done = true;
      clearTimeout(timer);
      arena.querySelector('.arena-loading')?.remove();
      sessMarkLoaded(i); // аналитика: игра догрузилась → импрешн засчитывается
      iframe.contentWindow?.postMessage({ type:'init', accent:g.accent, bg:g.bg, scoreLabel:g.score_label, save:getSave(g) }, '*');
      if (i === currentIdx && !gamePaused) iframe.contentWindow?.postMessage({ type:'start' }, '*');
      attachSwipe(iframe);
    });
    iframe.addEventListener('error', () => {
      if (done || iframes[i] !== iframe) return;
      done = true;
      clearTimeout(timer);
      showArenaError(i);
    });
    arena.appendChild(iframe); // loader overlays via z-index until load fires
    iframes[i] = iframe;
    loadGameInto(iframe, g);
  }
}

function showArenaError(i) {
  const arena = document.getElementById(`arena-${i}`);
  if (!arena) return;
  iframes[i] = null; // drop the broken/hanging iframe
  arena.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'arena-error';
  box.innerHTML = `<div class="arena-error-ico">🔌</div><div class="arena-error-msg">Игра не загрузилась</div>`;
  const btn = document.createElement('button');
  btn.className = 'arena-retry';
  btn.textContent = 'Повторить';
  btn.addEventListener('click', () => retryGame(i));
  box.appendChild(btn);
  arena.appendChild(box);
}

function retryGame(i) {
  const arena = document.getElementById(`arena-${i}`);
  if (!arena) return;
  iframes[i] = null;
  arena.innerHTML = arenaLoadingHTML();
  tg?.HapticFeedback?.impactOccurred('light');
  preload(i);
}

window.addEventListener('message', e => {
  const { type, value } = e.data || {};
  const idx = iframes.findIndex(f => f?.contentWindow === e.source);
  if (idx === -1) return;
  if (type === 'score') {
    const el = document.getElementById(`score-${idx}`); if(el) el.textContent = value;
    const g = GAMES[idx];
    if (g && Number(value) > getBest(g.id)) {
      setBest(g.id, Number(value));
      const be = document.getElementById(`best-${idx}`); if (be) be.textContent = Number(value);
    }
  }
  if (type === 'save') { const g = GAMES[idx]; if (g && value != null) setSave(g, value); }
  if (type === 'next') goTo(currentIdx + 1);
  if (type === 'ready') { if (idx === currentIdx && !gamePaused) iframes[idx]?.contentWindow?.postMessage({ type:'start' }, '*'); }
});

// ══ NAVIGATION ══
function goTo(idx) {
  const total = GAMES.length;
  if (idx >= total || idx < 0) {
    const target = idx >= total ? 0 : total - 1;
    const snap = idx >= total ? 'below' : 'above';
    cardEls.forEach(c => { c.style.transition='none'; c.className=`card ${snap}`; });
    void cardEls[0].offsetHeight;
    requestAnimationFrame(() => { cardEls.forEach(c => c.style.transition=''); _goTo(target); });
    return;
  }
  _goTo(idx);
}

function _goTo(idx) {
  if (idx !== currentIdx && iframes[currentIdx]) {
    iframes[currentIdx].contentWindow?.postMessage({ type:'pause' }, '*');
  }
  currentIdx = idx;
  // Reset manual pause when moving to a new game
  gamePaused = false;
  document.body.classList.remove('paused');
  renderPauseBtn();
  cardEls.forEach((c,i) => {
    c.classList.remove('above','active','below');
    c.classList.add(i < idx ? 'above' : i === idx ? 'active' : 'below');
  });
  preload(idx);
  sessOnNavigate(idx); // аналитика: закрыть предыдущий вид, открыть новый
  if (iframes[idx]) iframes[idx].contentWindow?.postMessage({ type:'start' }, '*');
  updateNextUp();
  tg?.HapticFeedback?.impactOccurred('light');
}

// ══ NEXT UP (shown only while paused) ══
function updateNextUp() {
  if (!GAMES.length) return;
  const ni = (currentIdx + 1) % GAMES.length;
  const g = GAMES[ni];
  if (!g) return;
  document.getElementById('nu-icon').textContent = g.emoji;
  document.getElementById('nu-icon').style.background = g.bg;
  document.getElementById('nu-title').textContent = g.title;
  document.getElementById('nu-play').onclick = () => goTo(ni);
}

// ══ PAUSE / PLAY ══
function pauseIcon(){ return `<svg width="34" height="34" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="#fff"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="#fff"/></svg>`; }
function playIcon(){ return `<svg width="34" height="34" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="#fff"/></svg>`; }
function renderPauseBtn(){
  const b = document.getElementById('tc-pause');
  if (!b) return;
  b.innerHTML = gamePaused ? playIcon() : pauseIcon();
  b.title = gamePaused ? 'Играть' : 'Пауза';
}
function togglePause(){
  gamePaused = !gamePaused;
  const f = iframes[currentIdx]?.contentWindow;
  if (f) f.postMessage({ type: gamePaused ? 'pause' : 'start' }, '*');
  if (gamePaused) sessPause(); else sessResume(); // аналитика: пауза замораживает таймер вида
  document.body.classList.toggle('paused', gamePaused);
  if (gamePaused) updateNextUp();
  renderPauseBtn();
  tg?.HapticFeedback?.impactOccurred('light');
}

// ══ HIDE UI (immersive) ══
function hideIcon(active){
  // active = immersive (интерфейс скрыт). Скрыто → перечёркнутый глаз;
  // всё видно → обычный открытый глаз.
  return active
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c5 0 9 4.5 10 8a13 13 0 0 1-2.16 3.3M6.06 6.06C3.83 7.62 2.21 9.93 2 12c1 3.5 5 8 10 8a9.4 9.4 0 0 0 4.94-1.4"/><path d="M3 3l18 18"/></svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function renderHideBtn(){
  const b = document.getElementById('tc-hide');
  if (!b) return;
  b.innerHTML = hideIcon(immersive);
  b.title = immersive ? 'Показать интерфейс' : 'Скрыть интерфейс';
}
function toggleImmersive(){
  immersive = !immersive;
  document.body.classList.toggle('immersive', immersive);
  renderHideBtn();
  tg?.HapticFeedback?.impactOccurred('light');
}

// ══ SWIPE / WHEEL — also bound inside each same-origin game iframe so navigation works over the full-screen game ══
let ty = 0, tx = 0, drag = false;
function onTouchStart(e){ ty=e.touches[0].clientY; tx=e.touches[0].clientX; drag=true; }
function onTouchEnd(e){
  if (!drag) return; drag=false;
  if (profileOpen) return;
  const dy=ty-e.changedTouches[0].clientY, dx=Math.abs(tx-e.changedTouches[0].clientX);
  if (Math.abs(dy)>55 && Math.abs(dy)>dx*1.5) { dy>0 ? goTo(currentIdx+1) : goTo(currentIdx-1); }
}
let wlock=false;
function onWheel(e){
  if (wlock||profileOpen) return;
  if (Math.abs(e.deltaY)>40) { wlock=true; setTimeout(()=>wlock=false,600); e.deltaY>0?goTo(currentIdx+1):goTo(currentIdx-1); }
}
function attachSwipe(iframe){
  // Намеренно НЕ навешиваем свайп на документ игры. Раньше это давало листание ленты
  // поверх полноэкранной игры, но из-за этого свайп ПО игре листал ленту и ломал
  // управление (напр. свайп вверх в «Змейке» уводил на следующую игру вместо хода).
  // Теперь игра получает свои жесты сама, а лента листается свайпом по UI приложения
  // (соц-колонка, подвал) — оно лежит вне рамки игры, в родительском документе.
}
document.addEventListener('touchstart', onTouchStart, {passive:true});
document.addEventListener('touchend', onTouchEnd, {passive:true});
document.addEventListener('wheel', onWheel, {passive:true});
document.addEventListener('keydown', e => {
  if (e.key==='ArrowDown') goTo(currentIdx+1);
  if (e.key==='ArrowUp') goTo(currentIdx-1);
  if (e.key===' ') { e.preventDefault(); togglePause(); }
});

// ══════════════════════════════════════════════════════════════════════════
//  АНАЛИТИКА СЕССИЙ (dwell-time) — устойчивый сбор для Telegram Mini App
//  Меряем время, пока карточка игры активна, видима и НЕ на паузе, ПОСЛЕ загрузки.
//  Один «вид» (импрешн) = игра стала активной и догрузилась; сессия = вид с
//  active_ms >= 3000; hook = вид >= 10000 мс.
//
//  СТРАТЕГИЯ ЗАПИСИ устойчива к тому, что в Telegram Web «закрытие» мини-аппа НЕ
//  даёт надёжных pagehide/visibilitychange (вкладка остаётся видимой):
//    1) как только вид догрузился — СРАЗУ вставляем строку в game_stats (active_ms=0);
//    2) каждые 10с и при паузе/уходе — ОБНОВЛЯЕМ active_ms той же строки (по id).
//  Поэтому даже долгая сессия в одной игре без свайпов фиксируется. id строки
//  генерим на клиенте (на game_stats нет select-политики, читать его нельзя).
//  Анонимов (без логина) не пишем. Глобали из index.html: GAMES, currentIdx,
//  gamePaused, currentUser, db, SUPABASE_URL/KEY.
// ══════════════════════════════════════════════════════════════════════════
const _sessLoaded = new Set();  // индексы iframes, у которых сработал load
let _sessView = null;           // текущий вид

function _sessUser(){ return (typeof currentUser !== 'undefined' && currentUser && currentUser.id) ? currentUser : null; }
function _sessCanRun(){
  return !!_sessView && _sessView.loaded && _sessView.idx === currentIdx
    && !gamePaused && document.visibilityState === 'visible';
}
function _sessTotalMs(){
  if (!_sessView) return 0;
  return _sessView.accumMs + (_sessView.running ? (Date.now() - _sessView.t0) : 0);
}
function _sessUuid(){
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}
function sessResume(){
  if (!_sessView || _sessView.running) return;
  if (_sessCanRun()) { _sessView.running = true; _sessView.t0 = Date.now(); }
}
function sessPause(){
  if (!_sessView || !_sessView.running) return;
  _sessView.accumMs += Date.now() - _sessView.t0;
  _sessView.running = false;
  _sessCheckpoint(false);  // фиксируем накопленное при каждой паузе
}
function _sessStart(idx){
  const g = GAMES[idx];
  if (!g) { _sessView = null; return; }
  _sessView = { idx, gameId:g.id, id:null, rowReady:false,
                startIso:new Date().toISOString(), accumMs:0, running:false, t0:0,
                loaded:_sessLoaded.has(idx) };
  if (_sessView.loaded) _sessInsertRow();
  sessResume();
}
// Вставляем строку «вида» сразу при загрузке (active_ms=0); потом только UPDATE.
function _sessInsertRow(){
  const u = _sessUser(), v = _sessView;
  if (!u || !v || v.id || typeof db === 'undefined') return;
  v.id = _sessUuid();
  const row = { id:v.id, game_id:v.gameId, user_id:u.id, session_start:v.startIso,
                session_end:new Date().toISOString(), active_ms:0, active_seconds:0, loaded:true,
                // происхождение показа (слой 1 рекомендаций): чем выбрана лента и на каком слоте.
                feed_source: (typeof FEED_SOURCE !== 'undefined' ? FEED_SOURCE : 'shuffle'),
                feed_position: v.idx };
  try {
    db.from('game_stats').insert(row).then(({ error }) => {
      if (error) { console.warn('sess insert:', error.message); if (v.id===row.id) v.id=null; }
      else if (_sessView === v) v.rowReady = true;
    });
  } catch (e) { console.warn('sess insert ex:', e); }
}
// Обновляем active_ms текущей строки (периодически, при паузе и при уходе).
function _sessCheckpoint(useBeacon){
  const v = _sessView;
  if (!v || !v.id || !v.rowReady) return;
  const ms = Math.max(0, Math.round(_sessTotalMs()));
  const patch = { active_ms: ms, active_seconds: Math.round(ms/1000), session_end: new Date().toISOString() };
  if (useBeacon) { _sessBeacon(v.id, patch); return; }
  try { db.from('game_stats').update(patch).eq('id', v.id).then(({ error }) => {
    if (error) console.warn('sess update:', error.message);
  }); } catch (e) { console.warn('sess update ex:', e); }
}
// Вызывается из preload() когда iframe игры догрузился.
function sessMarkLoaded(idx){
  _sessLoaded.add(idx);
  if (_sessView && _sessView.idx === idx && !_sessView.loaded) {
    _sessView.loaded = true;
    _sessInsertRow();
    sessResume();
  }
}
// Финализируем вид: дописываем active_ms и забываем его.
function _sessFinalize(){
  if (!_sessView) return;
  sessPause();             // accumMs += сегмент + checkpoint
  _sessCheckpoint(false);  // на случай, если таймер не шёл
  _sessView = null;
}
// Вызывается из _goTo() при смене активной игры.
function sessOnNavigate(idx){
  if (_sessView && _sessView.idx === idx) { sessResume(); return; }
  _sessFinalize();
  _sessStart(idx);
}
// Финальный апдейт при закрытии — keepalive-PATCH с токеном сессии.
function _sessBeacon(id, patch){
  try {
    db.auth.getSession().then(({ data }) => {
      const token = (data && data.session && data.session.access_token) || SUPABASE_KEY;
      fetch(`${SUPABASE_URL}/rest/v1/game_stats?id=eq.${id}`, {
        method: 'PATCH', keepalive: true,
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token,
                   'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }).catch(() => {});
  } catch (e) { /* best-effort */ }
}
// Периодический чекпоинт — ОСНОВНОЙ механизм фиксации (надёжнее, чем события
// закрытия, которых в Telegram Web может не быть).
setInterval(() => { if (_sessView && _sessView.running) _sessCheckpoint(false); }, 10000);
// Сворачивание/возврат мини-аппа: пауза/продолжение того же вида (строка уже есть).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sessPause(); else sessResume();
});
window.addEventListener('pagehide', () => { sessPause(); _sessCheckpoint(true); });
