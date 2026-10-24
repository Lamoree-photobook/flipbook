// ── PDF.js worker ──────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────────────
let pdf       = null;
let total     = 0;
let spread    = 0;
let PW        = 300;
let PH        = 420;
let dims      = [];          // size of every PDF page (in PDF points)
let pages     = [];          // book pages: { src, part: 'F'|'L'|'R', w, h }
let splitMode = 'auto';      // 'auto' | 'split' | 'single'
let coverAlone = true;       // true = first page is a lone cover
let zoomLevel = 1;
let flipping  = false;
const cache   = new Map();
let bgCtrl    = null;

// ── DOM ────────────────────────────────────────────────────────
const uploadScreen = document.getElementById('upload-screen');
const readerScreen = document.getElementById('reader-screen');
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const bookEl       = document.getElementById('book');
const slotLeft     = document.getElementById('slot-left');
const slotRight    = document.getElementById('slot-right');
const cvL          = document.getElementById('canvas-left');
const cvR          = document.getElementById('canvas-right');
const flipLayer    = document.getElementById('flip-layer');
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
const cornerNext   = document.getElementById('corner-next');
const cornerBack   = document.getElementById('corner-back');
const btnSplit     = document.getElementById('btn-split');

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

// ── Load PDF ───────────────────────────────────────────────────
async function loadPDF(file) {
  cache.clear();
  if (bgCtrl) bgCtrl.abort();
  zoomLevel = 1;

  bookTitle.textContent = file.name.replace(/\.pdf$/i, '');
  progressWrap.style.display = 'flex';
  progressFill.style.width   = '5%';
  progressText.textContent   = 'Opening…';

  const url = URL.createObjectURL(file);
  pdf   = await pdfjsLib.getDocument(url).promise;
  total = pdf.numPages;

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
}

// ── Work out the printed pages ─────────────────────────────────
// A landscape PDF page (e.g. 420x297 or 210x148.5 mm) is a full spread
// = two book pages side by side, so it is cut down the middle.
// A portrait PDF page is a single book page.
function buildPages() {
  pages = [];
  dims.forEach((d, i) => {
    const isWide = d.w > d.h * 1.05;
    const split  = splitMode === 'split' || (splitMode === 'auto' && isWide);
    if (split) {
      pages.push({ src: i + 1, part: 'L', w: d.w / 2, h: d.h });
      pages.push({ src: i + 1, part: 'R', w: d.w / 2, h: d.h });
    } else {
      pages.push({ src: i + 1, part: 'F', w: d.w, h: d.h });
    }
  });
  total = pages.length;
  // A lone portrait first page = front cover shown on its own.
  // If the first PDF page is a spread, show it as a spread.
  coverAlone = pages[0].part === 'F';
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

// ── Draw a spread ──────────────────────────────────────────────
async function drawSpread(si) {
  const [l, r] = spreadToPages(si);
  const isCover = coverAlone && si === 0;
  bookEl.classList.toggle('cover-mode', isCover);

  await Promise.all([paintPage(l, cvL), paintPage(r, cvR)]);

  const ms = maxSpread();
  btnPrev.disabled = si <= 0;
  btnNext.disabled = si >= ms;
  scrubber.value   = si;
  scrubber.max     = ms;

  // Show/hide corner peels
  cornerNext.style.display = (si < ms) ? 'block' : 'none';
  cornerBack.style.display = (si > 0 && !isCover) ? 'block' : 'none';

  const [lp, rp] = spreadToPages(si);
  if (isCover) {
    pageInfo.textContent = `p. 1 / ${total}`;
  } else {
    pageInfo.textContent = `p. ${lp || ''}${rp ? '–' + rp : ''} / ${total}`;
  }
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
//  REALISTIC CORNER-PEEL PAGE FLIP
//  Originates from the bottom-right corner of the right page,
//  arcs up-left like a real magazine page being turned.
// ════════════════════════════════════════════════════════════
async function flip(dir) {
  if (flipping || !pdf) return;
  const newSi = dir === 'next' ? spread + 1 : spread - 1;
  if (newSi < 0 || newSi > maxSpread()) return;
  flipping = true;

  cornerNext.classList.remove('lifting');

  const fwd      = dir === 'next';
  const [cl, cr] = spreadToPages(spread);
  const flyN     = fwd ? cr : cl;          // the page that physically turns
  const [nl, nr] = spreadToPages(newSi);

  // Render all pages we'll need
  const tL = document.createElement('canvas');
  const tR = document.createElement('canvas');
  const fC = document.createElement('canvas');
  await Promise.all([paintPage(nl, tL), paintPage(nr, tR), paintPage(flyN, fC)]);

  // Incoming spread goes underneath immediately
  copyCanvas(tL, cvL);
  copyCanvas(tR, cvR);

  // Flip layer spans the entire book (both pages + spine)
  const dpr      = window.devicePixelRatio || 1;
  const spineW   = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--spine-w')
  ) || 13;
  const totalW   = PW * 2 + spineW;

  flipLayer.style.display = 'block';
  flipLayer.width         = Math.round(totalW * dpr);
  flipLayer.height        = Math.round(PH    * dpr);
  flipLayer.style.width   = totalW + 'px';
  flipLayer.style.height  = PH    + 'px';
  flipLayer.style.top     = '0px';
  flipLayer.style.left    = '0px';

  const fCtx = flipLayer.getContext('2d');
  fCtx.scale(dpr, dpr);

  // Parchment back-of-page colour
  const pageBack  = '#ede4d6';
  const pageBack2 = '#e8ddd0'; // slightly darker for depth

  // Duration: long enough to look deliberate, short enough to feel snappy
  const DURATION = 520;
  const t0       = performance.now();

  // Ease: expo-out — fast lift from corner, smooth settle
  function easeOut(x) {
    return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }

  // For FORWARD flip: the right page (at x = PW+spineW … totalW) folds
  // over from bottom-right toward top-left.
  // We model the fold as a sweeping trapezoid clipped from the right edge.
  // The "fold crease" moves from x=totalW (right edge) to x=PW+spineW (left edge of right page).

  function frame(now) {
    const progress = Math.min((now - t0) / DURATION, 1);
    const ep       = easeOut(progress);

    fCtx.clearRect(0, 0, totalW, PH);

    if (fwd) {
      // RIGHT page is turning left
      // foldX: the crease x-position in book coords, sweeping PW+spineW → totalW as ep 0→1 reversed
      // At ep=0: crease at right edge (totalW), full page visible
      // At ep=1: crease at left edge (PW+spineW), page fully gone
      const rightEdge = totalW;
      const leftEdge  = PW + spineW;
      const creaseX   = rightEdge - (rightEdge - leftEdge) * ep;
      const visW      = creaseX - leftEdge; // visible width of flipping page

      // ── Draw visible portion of the flipping page (squeezed perspective) ──
      if (visW > 1) {
        fCtx.save();
        fCtx.beginPath();
        // Clip: trapezoidal — bottom is narrower than top to simulate curl from corner
        // At low ep: nearly rectangular. At high ep: strongly tapered toward bottom-right.
        const curlFactor = ep * 0.35; // how much the bottom-right corner curls inward
        const topLeft    = leftEdge;
        const topRight   = creaseX;
        const botLeft    = leftEdge + visW * curlFactor * 0.5;
        const botRight   = creaseX  - visW * curlFactor;
        fCtx.moveTo(topLeft, 0);
        fCtx.lineTo(topRight, 0);
        fCtx.lineTo(botRight, PH);
        fCtx.lineTo(botLeft,  PH);
        fCtx.closePath();
        fCtx.clip();

        // Draw the page image, perspective-squeezed horizontally
        const scaleX = visW / PW;
        fCtx.transform(scaleX, 0, 0, 1, leftEdge, 0);
        fCtx.drawImage(fC, 0, 0, PW, PH);
        fCtx.fillStyle = 'rgba(0,0,0,' + (0.15 * ep) + ')';
        fCtx.fillRect(0, 0, PW, PH);

        // Lighting: shadow on the right edge where it bends away
        const gFront = fCtx.createLinearGradient(0, 0, PW, 0);
        gFront.addColorStop(0, 'transparent');
        gFront.addColorStop(0.6, 'transparent');
        gFront.addColorStop(1, `rgba(0,0,0,${0.4 * (1 - visW / PW)})`);
        fCtx.fillStyle = gFront;
        fCtx.fillRect(0, 0, PW, PH);

        fCtx.restore();
      }

     
      // ── Cast shadow of turning page onto the underlying left page ──
      if (ep > 0.05 && visW > 0) {
        const shadowW  = Math.min(50, PW * 0.18) * ep;
        const shadowX0 = leftEdge - shadowW;
        const gShadow  = fCtx.createLinearGradient(shadowX0, 0, leftEdge, 0);
        gShadow.addColorStop(0, 'transparent');
        gShadow.addColorStop(1, `rgba(0,0,0,${0.22 * ep})`);
        fCtx.fillStyle = gShadow;
        fCtx.fillRect(Math.max(0, shadowX0), 0, shadowW + 2, PH);
      }

      // ── Darken spine slightly during flip ──
      fCtx.fillStyle = `rgba(8,5,2,${ep * 0.5})`;
      fCtx.fillRect(PW, 0, spineW, PH);

    } else {
      // PREV: left page (x = 0 … PW) turns right
      // creaseX sweeps from 0 (left edge) to PW (right edge of left page)
      const creaseX = PW * ep;
      const visW    = PW - creaseX;    // visible width of flipping page

      // Flipping page (squeezed)
      if (visW > 1) {
        fCtx.save();
        const curlFactor = ep * 0.35;
        fCtx.beginPath();
        fCtx.moveTo(creaseX, 0);
        fCtx.lineTo(PW, 0);
        fCtx.lineTo(PW - visW * curlFactor * 0.5, PH);
        fCtx.lineTo(creaseX + visW * curlFactor, PH);
        fCtx.closePath();
        fCtx.clip();

        const scaleX = visW / PW;
        fCtx.transform(scaleX, 0, 0, 1, creaseX, 0);
        fCtx.drawImage(fC, 0, 0, PW, PH);
        fCtx.fillStyle = 'rgba(0,0,0,' + (0.15 * ep) + ')';
fCtx.fillRect(0, 0, PW, PH);

        const gFront = fCtx.createLinearGradient(0, 0, PW, 0);
        gFront.addColorStop(0, `rgba(0,0,0,${0.38 * (1 - visW / PW)})`);
        gFront.addColorStop(0.3, 'transparent');
        fCtx.fillStyle = gFront;
        fCtx.fillRect(0, 0, PW, PH);
        fCtx.restore();
      }

      
      fCtx.fillStyle = `rgba(8,5,2,${ep * 0.5})`;
      fCtx.fillRect(PW, 0, spineW, PH);
    }

    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      flipLayer.style.display = 'none';
      flipping = false;
      spread   = newSi;
      drawSpread(spread);
      kickPreload();
    }
  }

  requestAnimationFrame(frame);
}

function copyCanvas(src, dst) {
  dst.width  = src.width;  dst.height  = src.height;
  dst.style.width  = PW + 'px'; dst.style.height = PH + 'px';
  dst.getContext('2d').drawImage(src, 0, 0);
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
    cache.clear();
    recalcSize(null, window.devicePixelRatio || 1);
    drawSpread(spread);
  }, 150);
});

// ── Split mode button (Auto → Split → Single) ─────────────────
const SPLIT_LABELS = {
  auto:   ['Auto',   'Auto: landscape PDF pages are cut in half, portrait pages stay whole'],
  split:  ['Split',  'Every PDF page is cut in half (two book pages each)'],
  single: ['Single', 'No cutting: every PDF page is one book page'],
};
function updateSplitButton() {
  const [label, tip] = SPLIT_LABELS[splitMode];
  btnSplit.textContent = label;
  btnSplit.title = tip;
}
btnSplit.addEventListener('click', async () => {
  if (!pdf || flipping) return;
  const order = ['auto', 'split', 'single'];
  splitMode = order[(order.indexOf(splitMode) + 1) % order.length];
  buildPages();
  updateSplitButton();
  cache.clear();
  spread = 0;
  recalcSize({ width: pages[0].w, height: pages[0].h }, window.devicePixelRatio || 1);
  await drawSpread(0);
  kickPreload();
});

// ── Cover-mode CSS (single page only) ─────────────────────────
const coverStyle = document.createElement('style');
coverStyle.textContent = `
  #book.cover-mode #slot-left,
  #book.cover-mode #spine { display: none; }
  #book.cover-mode #slot-right { border-radius: 3px; }
  #book.cover-mode #corner-back { display: none !important; }
  #btn-split {
    width: auto; min-width: 52px; padding: 0 .8rem; border-radius: 15px;
    font: 400 .62rem 'DM Sans', sans-serif; letter-spacing: .08em;
    text-transform: uppercase;
  }
`;
document.head.appendChild(coverStyle);