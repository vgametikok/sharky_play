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
  return `
    <div class="ov-author" onclick="openProfile('${g.author_id}')">
      <div class="ov-av" style="background:${a.ring||'#7b5cff'}">${a.emoji||'🎮'}</div>
      <div class="ov-author-meta">
        <div class="ov-name">${escHtml(a.name||'Sharky')} ${verified}</div>
        ${when ? `<div class="ov-time">${when}</div>` : ''}
      </div>
    </div>
    <div class="ov-title">${escHtml(g.title)}</div>
    ${desc}
    <div class="ov-badge">${padSVG()} ${escHtml(cat)}</div>
    <div class="ov-score-wrap">
      <div class="ov-score" id="score-${i}">0</div>
      <div class="ov-best">BEST <b id="best-${i}">${best}</b></div>
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
  let cross = false;
  try { cross = new URL(g.src, location.href).origin !== location.origin; } catch(e) { cross = true; }
  if (!cross) { iframe.src = g.src; return; }
  fetch(g.src)
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
    .then(html => { iframe.srcdoc = html; })
    .catch(() => { iframe.src = g.src; }); // fallback (e.g. CORS blocked)
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
      iframe.contentWindow?.postMessage({ type:'init', accent:g.accent, bg:g.bg, scoreLabel:g.score_label }, '*');
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
  document.body.classList.toggle('paused', gamePaused);
  if (gamePaused) updateNextUp();
  renderPauseBtn();
  tg?.HapticFeedback?.impactOccurred('light');
}

// ══ HIDE UI (immersive) ══
function hideIcon(active){
  return active
    ? `<svg width="30" height="30" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4" fill="#fff"/></svg>`
    : `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>`;
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
