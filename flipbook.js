// ── PDF.js worker ──────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────────────
let pdf        = null;
let total      = 0;          // number of book pages (after cutting spreads)
let spread     = 0;
let PW         = 300;        // page width  (css px)
let PH         = 420;        // page height (css px)
let dims       = [];         // size of every PDF page (PDF points)
let pages      = [];         // book pages: { src, part: 'F'|'L'|'R', w, h }
let splitMode  = 'auto';     // 'auto' | 'split' | 'single' | 'wrap'
let coverAlone = true;       // true = first book page is a lone front cover
let zoomLevel  = 1;
let flipping   = false;
const cache    = new Map();
let bgCtrl     = null;
let bgUrl      = null;

// Flip length in ms. Keep in sync with `transition` on #book in style.css
const FLIP_MS = 900;

// ── DOM ────────────────────────────────────────────────────────
const uploadScreen = document.getElementById('upload-screen');
const readerScreen = document.getElementById('reader-screen');
const readerBg     = document.getElementById('reader-bg');
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const bookWrap     = document.getElementById('book-wrap');
const bookEl       = document.getElementById('book');
const underL       = document.getElementById('under-l');
const underR       = document.getElementById('under-r');
const slotLeft     = document.getElementById('slot-left');
const slotRight    = document.getElementById('slot-right');
const spineEl      = document.getElementById('spine');
const cvL          = document.getElementById('canvas-left');
const cvR          = document.getElementById('canvas-right');
const castEl       = document.getElementById('cast');
const leaf         = document.getElementById('leaf');
const leafFront    = document.getElementById('leaf-front');
const leafBack     = document.getElementById('leaf-back');
const shadeFront   = document.getElementById('leaf-shade-front');
const shadeBack    = document.getElementById('leaf-shade-back');
const btnPrev      = document.getElementById('btn-prev');
const btnNext      = document.getElementById('btn-next');
const pageInfo     = document.getElementById('page-info');
const scrubber     = document.getElementById('scrubber');
const bookTitle    = document.getElementById('book-title');
const btnNew       = document.getElementById('btn-new');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const btnZoomIn    = document.getElementById('btn-zoom-in');
const btnZoomOut   = document.getElementById('btn-zoom-out');
const btnSplit     = document.getElementById('btn-split');
const btnBg        = document.getElementById('btn-bg');
const btnBgClear   = document.getElementById('btn-bg-clear');
const bgInput      = document.getElementById('bg-input');
const cornerNext   = document.getElementById('corner-next');
const cornerBack   = document.getElementById('corner-back');

// ── File input / drag-drop ─────────────────────────────────────
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadPDF(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type === 'application/pdf') loadPDF(f);
});

// ── Background picture ─────────────────────────────────────────
btnBg.addEventListener('click', () => bgInput.click());

bgInput.addEventListener('change', () => {
  const f = bgInput.files[0];
  bgInput.value = '';
  if (!f || !f.type.startsWith('image/')) return;
  if (bgUrl) URL.revokeObjectURL(bgUrl);
  bgUrl = URL.createObjectURL(f);
  readerBg.style.backgroundImage = `url("${bgUrl}")`;
  readerScreen.classList.add('has-bg');
  btnBgClear.style.display = 'flex';
});

btnBgClear.addEventListener('click', () => {
  readerScreen.classList.remove('has-bg');
  btnBgClear.style.display = 'none';
  if (bgUrl) URL.revokeObjectURL(bgUrl);
  bgUrl = null;
  setTimeout(() => { readerBg.style.backgroundImage = 'none'; }, 450);
});

// ── Load PDF ───────────────────────────────────────────────────
async function loadPDF(file) {
  cache.clear();
  if (bgCtrl) bgCtrl.abort();
  zoomLevel = 1;
  flipping  = false;
  leaf.style.display = 'none';
  castEl.style.background = 'none';

  bookTitle.textContent = file.name.replace(/\.pdf$/i, '');
  progressWrap.style.display = 'flex';
  progressFill.style.width   = '5%';
  progressText.textContent   = 'Opening…';

  const url = URL.createObjectURL(file);
  pdf = await pdfjsLib.getDocument(url).promise;

  const dpr = window.devicePixelRatio || 1;

  // Read the size of every PDF page (cheap, nothing is drawn yet)
  progressText.textContent = 'Measuring pages…';
  dims = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, i) =>
      pdf.getPage(i + 1).then((pg) => {
        const v = pg.getViewport({ scale: 1 });
        return { w: v.width, h: v.height };
      })
    )
  );

  splitMode = 'auto';
  buildPages();
  updateSplitButton();
  recalcSize({ width: pages[0].w, height: pages[0].h }, dpr);

  spread         = 0;
  scrubber.max   = maxSpread();
  scrubber.value = 0;

  uploadScreen.style.display = 'none';
  readerScreen.style.display = 'flex';

  progressFill.style.width = '20%';
  progressText.textContent = 'Rendering…';

  await drawSpread(0);

  progressFill.style.width = '100%';
  progressText.textContent = 'Ready';
  setTimeout(() => { progressWrap.style.display = 'none'; }, 600);

  kickPreload();
}

// ── Recalculate page size for current zoom ─────────────────────
function recalcSize(vpBase, dpr) {
  if (vpBase) recalcSize._vpBase = vpBase;
  const vp = recalcSize._vpBase;
  if (!vp) return;

  const spareW = window.innerWidth  - 180;
  const spareH = window.innerHeight - 170;
  const cssScale = Math.min(spareW / 2 / vp.width, spareH / vp.height) * zoomLevel;

  PW = Math.floor(vp.width  * cssScale);
  PH = Math.floor(vp.height * cssScale);

  slotLeft.style.width   = slotRight.style.width  = PW + 'px';
  slotLeft.style.height  = slotRight.style.height = PH + 'px';

  // Used by the CSS (shadows, flip layer) and the 3D flip
  bookEl.style.setProperty('--pw', PW + 'px');
  bookEl.style.setProperty('--ph', PH + 'px');
  bookEl.style.perspective = (PW * 6) + 'px';
}

// ── Work out the printed pages ─────────────────────────────────
// A landscape PDF page (e.g. 420x297 or 210x148.5 mm) is a full spread
// = two book pages side by side, so it is cut down the middle.
// A portrait PDF page is a single book page.
// 'wrap' mode: the first PDF page is a wrap-around cover (back | front),
// so the FRONT cover goes first and the BACK cover goes last.
function buildPages() {
  pages = [];
  dims.forEach((d, i) => {
    const isWide = d.w > d.h * 1.05;
    const split  = splitMode === 'split' || splitMode === 'wrap' ||
                   (splitMode === 'auto' && isWide);
    const doSplit = split && (splitMode !== 'wrap' || isWide);
    if (doSplit) {
      pages.push({ src: i + 1, part: 'L', w: d.w / 2, h: d.h });
      pages.push({ src: i + 1, part: 'R', w: d.w / 2, h: d.h });
    } else {
      pages.push({ src: i + 1, part: 'F', w: d.w, h: d.h });
    }
  });

  if (splitMode === 'wrap' && pages.length > 1 &&
      pages[0].part === 'L' && pages[1].part === 'R' && pages[0].src === pages[1].src) {
    pages.push(pages.shift());          // back cover (left half) goes to the end
  }

  total = pages.length;
  // First book page on its own = front cover shown closed.
  // If the PDF starts with a normal two-page spread, show it as a spread.
  coverAlone = pages[0].part !== 'L';
}

// ── Spread helpers ─────────────────────────────────────────────
function maxSpread() {
  return coverAlone ? Math.ceil((total - 1) / 2) : Math.ceil(total / 2) - 1;
}

function spreadToPages(si) {
  if (coverAlone) {
    if (si === 0) return [null, 1];
    const l = si * 2;
    const r = si * 2 + 1;
    return [l <= total ? l : null, r <= total ? r : null];
  }
  const l = si * 2 + 1;
  const r = si * 2 + 2;
  return [l <= total ? l : null, r <= total ? r : null];
}

// 'front' = closed book showing the front cover (right page only)
// 'back'  = closed book showing the back cover  (left page only)
// 'open'  = two pages
function stateOf(l, r) {
  if (!l) return 'front';
  if (!r) return 'back';
  return 'open';
}

// ── Page cache ─────────────────────────────────────────────────
function cacheKey(n) {
  return `${n}@${PW}x${PH}@${window.devicePixelRatio || 1}`;
}

async function getPage(n) {
  const key = cacheKey(n);
  if (cache.has(key)) return cache.get(key);

  const info = pages[n - 1];
  const page = await pdf.getPage(info.src);
  const dpr  = window.devicePixelRatio || 1;
  const cw   = Math.round(PW * dpr);
  const ch   = Math.round(PH * dpr);

  // Fit this book page (a full PDF page or one half of it) into PW x PH
  const s  = Math.min(cw / info.w, ch / info.h);
  const vp = page.getViewport({ scale: s });
  const pageW = info.w * s;
  const pageH = info.h * s;
  const x0 = (cw - pageW) / 2;
  const y0 = (ch - pageH) / 2;
  // Right half: slide the PDF page left by one half-width
  const ox = x0 - (info.part === 'R' ? pageW : 0);

  const oc  = document.createElement('canvas');
  oc.width  = cw;
  oc.height = ch;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  // Clip so the other half of the spread never shows
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, pageW, pageH);
  ctx.clip();
  await page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: [1, 0, 0, 1, ox, y0],
  }).promise;
  ctx.restore();

  cache.set(key, oc);
  return oc;
}

async function paintPage(n, cv) {
  const ctx = cv.getContext('2d');
  if (!n || n < 1 || n > total) {
    cv.width  = PW * (window.devicePixelRatio || 1);
    cv.height = PH * (window.devicePixelRatio || 1);
    cv.style.width  = PW + 'px';
    cv.style.height = PH + 'px';
    ctx.fillStyle = '#f6f0e8';
    ctx.fillRect(0, 0, cv.width, cv.height);
    return;
  }
  const src = await getPage(n);
  cv.width  = src.width;
  cv.height = src.height;
  cv.style.width  = PW + 'px';
  cv.style.height = PH + 'px';
  ctx.drawImage(src, 0, 0);
}

function copyCanvas(src, dst) {
  dst.width  = src.width;  dst.height  = src.height;
  dst.style.width  = PW + 'px'; dst.style.height = PH + 'px';
  dst.getContext('2d').drawImage(src, 0, 0);
}

// ── Book state (closed front / open / closed back) ─────────────
// A closed book is centred on screen; opening it slides it back so the
// spine is in the middle. The layout is always 2 pages wide, so we just
// shift it left/right and hide the empty side.
function bookShift(st) {
  return st === 'front' ? -PW / 2 : st === 'back' ? PW / 2 : 0;
}

function shiftBook(st, instant) {
  const tf = `translateX(${bookShift(st)}px)`;
  if (instant) {
    bookEl.style.transition = 'none';
    bookEl.style.transform  = tf;
    void bookEl.offsetWidth;            // apply now, without animating
    bookEl.style.transition = '';
  } else {
    bookEl.style.transform = tf;
  }
}

function setBookClasses(st) {
  bookEl.classList.toggle('is-front', st === 'front');
  bookEl.classList.toggle('is-back',  st === 'back');
  bookEl.classList.toggle('is-open',  st === 'open');
  bookWrap.classList.toggle('closed', st !== 'open');
  spineEl.classList.toggle('off',     st !== 'open');
}

function showSlots(l, r) {
  slotLeft.style.visibility  = underL.style.visibility = l ? 'visible' : 'hidden';
  slotRight.style.visibility = underR.style.visibility = r ? 'visible' : 'hidden';
}

// ── Draw a spread ──────────────────────────────────────────────
async function drawSpread(si, instant = true) {
  const [l, r] = spreadToPages(si);
  await Promise.all([paintPage(l, cvL), paintPage(r, cvR)]);

  const st = stateOf(l, r);
  setBookClasses(st);
  showSlots(l, r);
  shiftBook(st, instant);

  const ms = maxSpread();
  btnPrev.disabled = si <= 0;
  btnNext.disabled = si >= ms;
  scrubber.value   = si;
  scrubber.max     = ms;

  // Corner peels: next on the right page, back on the left page
  cornerNext.style.display = (r && si < ms) ? 'block' : 'none';
  cornerBack.style.display = (l && si > 0)  ? 'block' : 'none';

  if (st === 'front')      pageInfo.textContent = `p. ${r} / ${total}`;
  else if (st === 'back')  pageInfo.textContent = `p. ${l} / ${total}`;
  else                     pageInfo.textContent = `p. ${l}–${r} / ${total}`;
}

// ── Background preloader ───────────────────────────────────────
async function kickPreload() {
  if (bgCtrl) bgCtrl.abort();
  bgCtrl = new AbortController();
  const sig = bgCtrl.signal;

  const order = [];
  const seen  = new Set();
  const add = (n) => {
    if (n >= 1 && n <= total && !seen.has(n)) { seen.add(n); order.push(n); }
  };
  const [pl, pr] = spreadToPages(spread);
  add(pl); add(pr);
  const hi = pr || pl || 1;
  const lo = pl || pr || 1;
  for (let d = 1; d <= total; d++) {
    add(hi + d);
    add(lo - d);
  }

  for (const n of order) {
    if (sig.aborted) return;
    if (!cache.has(cacheKey(n))) await getPage(n).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
  }
}

// ════════════════════════════════════════════════════════════
//  HARDCOVER PAGE TURN
//  A stiff page is hinged on the spine and swings over like a
//  real photobook page: front face = the page you are turning,
//  back face = the page that lands on the other side.
// ════════════════════════════════════════════════════════════
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function flip(dir) {
  if (flipping || !pdf) return;
  const fwd   = dir === 'next';
  const newSi = fwd ? spread + 1 : spread - 1;
  if (newSi < 0 || newSi > maxSpread()) return;
  flipping = true;

  cornerNext.style.display = 'none';
  cornerBack.style.display = 'none';
  cornerNext.classList.remove('lifting');

  const [cl, cr] = spreadToPages(spread);
  const [nl, nr] = spreadToPages(newSi);

  // Draw everything off-screen first so nothing flashes
  const under = document.createElement('canvas');
  await Promise.all([
    paintPage(fwd ? cr : cl, leafFront),   // page being turned
    paintPage(fwd ? nl : nr, leafBack),    // page that lands on the other side
    paintPage(fwd ? nr : nl, under),       // page revealed underneath
  ]);

  // ── All ready: set up in one go ──
  copyCanvas(under, fwd ? cvR : cvL);
  showSlots(fwd ? cl : nl, fwd ? nr : cr);
  spineEl.classList.toggle('off', stateOf(cl, cr) !== 'open');

  const hinge = slotRight.offsetLeft;          // spine position inside the book
  leaf.className        = fwd ? 'fwd' : 'bwd';
  leaf.style.width      = PW + 'px';
  leaf.style.height     = PH + 'px';
  leaf.style.left       = (fwd ? hinge : 0) + 'px';
  leaf.style.transformOrigin = fwd ? 'left center' : 'right center';
  leaf.style.transform  = 'rotateY(0deg)';
  leaf.style.display    = 'block';

  // Book slides to the middle (opening) or to the side (closing)
  shiftBook(stateOf(nl, nr), false);

  const d    = PW * 6;                          // perspective distance
  const shW  = Math.min(150, PW * 0.35);        // width of the cast shadow
  const okL  = fwd ? !!cl : !!nl;               // is there a page to shade?
  const okR  = fwd ? !!nr : !!cr;
  const t0   = performance.now();

  function frame(now) {
    const t  = Math.min((now - t0) / FLIP_MS, 1);
    const e  = easeInOutCubic(t);
    const th = e * Math.PI;
    const s  = Math.sin(th);
    const c  = Math.cos(th);

    leaf.style.transform = `rotateY(${fwd ? -e * 180 : e * 180}deg)`;

    // The page darkens as it turns away from the light
    const sh = (0.45 * s).toFixed(3);
    shadeFront.style.opacity = sh;
    shadeBack.style.opacity  = sh;

    // Shadow the turning page throws onto the page next to it
    const rel  = (fwd ? c : -c) * PW * d / (d - s * PW);
    const edge = hinge + rel;
    const a    = 0.4 * s;
    let bg = 'none';
    if (a > 0.01) {
      if (rel >= 0 && okR) {
        bg = `linear-gradient(to right, rgba(0,0,0,0) ${edge}px, rgba(0,0,0,${a.toFixed(3)}) ${edge}px, rgba(0,0,0,0) ${edge + shW}px)`;
      } else if (rel < 0 && okL) {
        bg = `linear-gradient(to right, rgba(0,0,0,0) ${edge - shW}px, rgba(0,0,0,${a.toFixed(3)}) ${edge}px, rgba(0,0,0,0) ${edge}px)`;
      }
    }
    castEl.style.background = bg;

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      finish();
    }
  }

  async function finish() {
    spread = newSi;
    await drawSpread(newSi, false);   // final pages go under the landed page
    leaf.style.display = 'none';
    castEl.style.background = 'none';
    flipping = false;
    kickPreload();
  }

  requestAnimationFrame(frame);
}

// ── Corner peel interactions ───────────────────────────────────
cornerNext.addEventListener('mouseenter', () => {
  if (!flipping) cornerNext.classList.add('lifting');
});
cornerNext.addEventListener('mouseleave', () => {
  cornerNext.classList.remove('lifting');
});
cornerNext.addEventListener('click', (e) => {
  e.stopPropagation();
  flip('next');
});

cornerBack.addEventListener('click', (e) => {
  e.stopPropagation();
  flip('prev');
});

// ── Zoom ──────────────────────────────────────────────────────
btnZoomIn.addEventListener('click', () => {
  if (zoomLevel >= 2) return;
  zoomLevel = Math.min(2, zoomLevel + 0.2);
  applyZoom();
});
btnZoomOut.addEventListener('click', () => {
  if (zoomLevel <= 0.5) return;
  zoomLevel = Math.max(0.5, zoomLevel - 0.2);
  applyZoom();
});
async function applyZoom() {
  if (flipping) return;
  cache.clear();
  recalcSize(null, window.devicePixelRatio || 1);
  await drawSpread(spread);
  kickPreload();
}

// ── Navigation ────────────────────────────────────────────────
btnNext.addEventListener('click', () => flip('next'));
btnPrev.addEventListener('click', () => flip('prev'));

scrubber.addEventListener('input', async () => {
  if (flipping) return;
  const val = parseInt(scrubber.value);
  if (val !== spread) { spread = val; await drawSpread(spread); kickPreload(); }
});

document.addEventListener('keydown', (e) => {
  if (!pdf) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') flip('next');
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   flip('prev');
  if (e.key === '+' || e.key === '=') btnZoomIn.click();
  if (e.key === '-') btnZoomOut.click();
});

let touchX = 0;
document.addEventListener('touchstart', (e) => {
  touchX = e.touches[0].clientX;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!pdf) return;
  if (Math.abs(e.changedTouches[0].clientX - touchX) > 55)
    flip(e.changedTouches[0].clientX < touchX ? 'next' : 'prev');
});

// ── New PDF ───────────────────────────────────────────────────
btnNew.addEventListener('click', () => {
  if (bgCtrl) bgCtrl.abort();
  pdf = null; cache.clear(); fileInput.value = '';
  readerScreen.style.display = 'none';
  uploadScreen.style.display = 'flex';
});

// ── Resize ───────────────────────────────────────────────────
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (flipping) return;
    cache.clear();
    recalcSize(null, window.devicePixelRatio || 1);
    drawSpread(spread);
  }, 150);
});

// ── Split mode button (Auto → Split → Single → Wrap) ──────────
const SPLIT_LABELS = {
  auto:   ['Auto',   'Auto: landscape PDF pages are cut in half, portrait pages stay whole'],
  split:  ['Split',  'Every PDF page is cut in half (two book pages each)'],
  single: ['Single', 'No cutting: every PDF page is one book page'],
  wrap:   ['Wrap',   'Wrap-around cover: first PDF page is back | front cover. Front cover shows first, back cover last'],
};
function updateSplitButton() {
  const [label, tip] = SPLIT_LABELS[splitMode];
  btnSplit.textContent = label;
  btnSplit.title = tip;
}
btnSplit.addEventListener('click', async () => {
  if (!pdf || flipping) return;
  const order = ['auto', 'split', 'single', 'wrap'];
  splitMode = order[(order.indexOf(splitMode) + 1) % order.length];
  buildPages();
  updateSplitButton();
  cache.clear();
  spread = 0;
  recalcSize({ width: pages[0].w, height: pages[0].h }, window.devicePixelRatio || 1);
  await drawSpread(0);
  kickPreload();
});
