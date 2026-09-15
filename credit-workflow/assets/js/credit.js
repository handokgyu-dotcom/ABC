/* ══════════════════════════════════════════════════════════════
   credit.js — 신용거래 심사 페이지
   원본: CREADIT.html 의 <script> 4개를 순서 그대로 합친 것
     ① 채점표 UI  ② 게이지 판독  ③ 추출·등급 매핑  ④ 업로드 UI

   채점 로직(가중치·등급률·70점 컷) · 게이지 판독 · 추출 규칙은 무변경.
   원본이 흘리던 전역 ~28개는 전부 이 IIFE 안으로 들어갔고, ①④를 잇던
   window.__setGrades 브리지는 지역 변수 setGrades 직접 호출로 바뀌었다.
   생성하는 마크업은 components.css 의 공통 클래스를 쓴다.

   ── pdf.js 지연 로드 ──
   원본은 pdf.js(376KB)와 pdf.worker(1.13MB)를 통째로 인라인해 두었다.
   여기서는 신용 페이지에 처음 들어올 때만 App.loadScripts() 로 받는다.

   주의 — GlobalWorkerOptions.workerSrc 는 설정하지 않는다.
   worker 를 일반 <script> 로 올려 globalThis.pdfjsWorker.WorkerMessageHandler
   를 노출시키면 pdf.js 가 이를 감지해 fake worker(메인 스레드) 모드로 돈다.
   이것이 file:// 로 열어도 동작하는 이유다. 진짜 Worker 로 바꾸면
   file:// 에서 CORS 로 깨진다. lib → worker 순서도 그대로 지킨다.
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";

/* ── pdf.js 지연 로드 ──────────────────────────────────────────
   원본은 pdf.js(376KB)와 pdf.worker(1.13MB)를 통째로 인라인해 두었다.
   셸에서는 시작화면·연대보증 페이지에서 1.5MB를 받을 이유가 없으므로,
   신용 페이지에 처음 들어올 때(또는 첫 업로드 때) 받는다.

   주의 — GlobalWorkerOptions.workerSrc 는 설정하지 않는다.
   worker 를 일반 <script> 로 올려 globalThis.pdfjsWorker.WorkerMessageHandler
   를 노출시키면 pdf.js 가 이를 감지해 fake worker(메인 스레드) 모드로 돈다.
   이것이 file:// 로 열어도 동작하는 이유다. 진짜 Worker 로 바꾸면
   file:// 에서 CORS 로 깨진다. lib → worker 순서도 그대로 지킨다. */
var VENDOR = ["assets/vendor/pdf.min.js", "assets/vendor/pdf.worker.min.js"];
var pdfjsReady = null;

function ensurePdfjs(){
  if (!pdfjsReady){
    pdfjsReady = App.loadScripts(VENDOR).catch(function(e){
      pdfjsReady = null;        /* 실패하면 다음 업로드 때 다시 시도할 수 있게 비운다 */
      throw e;
    });
  }
  return pdfjsReady;
}

/* shell.js 가 신용 페이지 진입 시 호출한다. 여기서의 실패는 조용히 넘기고
   실제 업로드 시점의 await ensurePdfjs() 가 사용자에게 보고한다. */
window.__preloadCredit = function(){ ensurePdfjs().catch(function(){}); };

/* ①의 window.__setGrades 를 대신하는 내부 브리지 — ①이 채우고 ④가 호출한다 */
var setGrades = null;


/* ═══════════ ① 채점표 UI (원본 364~513행) ═══════════ */
(function(){
  var RATE = {A:1, B:0.8, C:0.6, D:0.4, E:0.2};
  var ITEMS = [
    {no:1,  nm:"대외기관 신용등급 (평가사·금융기관)", w:10, bands:["A등급이상","BBB대","BB대","B대","CCC이하"]},
    {no:2,  nm:"대표자 지분비율 (실소유자 관계)",     w:10, bands:["50%이상","50%미만","30%미만","10%미만","없음"]},
    {no:3,  nm:"매출액 규모",                          w:5,  bands:["300억이상","200억이상","100억이상","50억이상","50억미만"]},
    {no:4,  nm:"현금흐름등급 (Cash Flow)",             w:10, bands:["CF1","CF2","CF3","CF4","CF5·CF6"]},
    {no:5,  nm:"부채비율",                             w:10, bands:["150%미만","150%이상","200%이상","250%이상","300%이상"]},
    {no:6,  nm:"유동비율",                             w:10, bands:["250%이상","200%이상","150%이상","100%이상","100%미만"]},
    {no:7,  nm:"차입금의존도",                         w:10, bands:["10%미만","10%이상","20%이상","30%이상","40%이상"]},
    {no:8,  nm:"이자보상배율",                         w:10, bands:["2 이상","1.5 이상","1 이상","0.5 이상","0.5 미만"]},
    {no:9,  nm:"매출액증가율",                         w:5,  bands:["30%이상","20%이상","10%이상","5%이상","감소"]},
    {no:10, nm:"당기순이익증가율",                     w:10, bands:["200%이상","150%이상","100%이상","50%이상","감소"]},
    {no:11, nm:"자기자본비율",                         w:10, bands:["70%이상","60%이상","50%이상","40%이상","40%미만"]}
  ];
  var GRADES = ["A","B","C","D","E"];
  var state = ITEMS.map(function(){ return null; });
  var isDemo = false;
  var pendingItems = [];

  var sheet = document.getElementById("sheet");
  var ptsEls = [];

  ITEMS.forEach(function(it, i){
    var row = document.createElement("div");
    row.className = "sheet__row";
    row.innerHTML =
      '<div class="sheet__no">' + it.no + '</div>' +
      '<div class="sheet__item"><div class="sheet__name"></div>' +
        '<div class="sheet__weight">가중치 ' + it.w + '</div></div>' +
      '<div class="segmented" role="group"></div>' +
      '<div class="sheet__pts is-empty">—</div>';
    row.querySelector(".sheet__name").textContent = it.nm;
    var seg = row.querySelector(".segmented");
    GRADES.forEach(function(g, gi){
      var b = document.createElement("button");
      b.type = "button";
      b.id = "g-" + it.no + "-" + g;
      var unused = it.bands[gi] === "미사용";
      b.innerHTML = '<b></b><i></i>';
      b.querySelector("b").textContent = g;
      b.querySelector("i").textContent = it.bands[gi];
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", it.nm + " " + g + "등급 " + it.bands[gi]);
      if (unused) {
        b.disabled = true;
        b.title = "이 항목에서는 사용하지 않는 등급입니다";
      } else {
        b.addEventListener("click", function(){
          state[i] = (state[i] === g) ? null : g;
          isDemo = false;
          render();
        });
      }
      seg.appendChild(b);
    });
    ptsEls.push({row:row, seg:seg, pts:row.querySelector(".sheet__pts")});
    sheet.appendChild(row);
  });

  var total = document.createElement("div");
  total.className = "sheet__row sheet__row--total";
  total.innerHTML = '<div class="sheet__no"></div>' +
    '<div class="sheet__item"><div class="sheet__name">소계</div>' +
      '<div class="sheet__weight">가중치 합 100</div></div><div class="segmented"></div>' +
    '<div class="sheet__pts" id="rowTotal">0.0</div>';
  sheet.appendChild(total);

  var scoreVal = document.getElementById("scoreVal");
  var bar = document.getElementById("bar");
  var verdict = document.getElementById("verdict");
  var rowTotal = document.getElementById("rowTotal");
  var demoFlag = document.getElementById("demoFlag");

  function render(){
    var sum = 0, filled = 0;
    ITEMS.forEach(function(it, i){
      var g = state[i];
      var el = ptsEls[i];
      Array.prototype.forEach.call(el.seg.children, function(b){
        var letter = b.querySelector("b") ? b.querySelector("b").textContent : "";
        b.setAttribute("aria-pressed", String(letter === g));
      });
      if (g){
        var p = it.w * RATE[g];
        sum += p; filled++;
        el.pts.textContent = p.toFixed(1);
        el.pts.className = "sheet__pts";
      } else {
        el.pts.textContent = "—";
        el.pts.className = "sheet__pts is-empty";
      }
    });
    scoreVal.textContent = sum.toFixed(1);
    rowTotal.textContent = sum.toFixed(1);
    bar.style.width = Math.max(0, Math.min(100, sum)) + "%";
    if (filled === 0){
      verdict.textContent = "평가 미입력";
      verdict.className = "verdict";
    } else if (pendingItems.length){
      verdict.textContent = "판정 보류 — NO." + pendingItems.join("·") + " OCR 대기";
      verdict.className = "verdict verdict--hold";
    } else if (sum >= 70){
      verdict.textContent = "신용거래 추진";
      verdict.className = "verdict verdict--ok";
    } else {
      verdict.textContent = "추진 불가 (70점 미만)";
      verdict.className = "verdict verdict--crit";
    }
    if (!loaded) demoFlag.hidden = true;
  }

  var loaded = null;   /* 마지막으로 업로드한 보고서의 산출 결과 */

  function applyMeta(co){
    var name = co || "업로드 보고서";
    var t = document.getElementById("modelTitle");
    if (t) t.textContent = "「재무 (신용)」 평가표 — " + name + " 산출 결과";
    demoFlag.textContent = name + " 보고서 산출";
    demoFlag.hidden = false;
    var fn = document.getElementById("footNote");
    if (fn) fn.textContent = "지금 보이는 점수는 " + name + " 신용분석보고서에서 산출한 값입니다.";
  }

  setGrades = function(g, meta){
    state = ITEMS.map(function(it){ return g[it.no] || null; });
    pendingItems = ITEMS.filter(function(it){ return !g[it.no]; }).map(function(it){ return it.no; });
    isDemo = false;
    loaded = {state: state.slice(), pending: pendingItems.slice(), co: (meta && meta.co) || null};
    applyMeta(loaded.co);
    render();
    demoFlag.hidden = false;
    document.getElementById("sheet").scrollIntoView({behavior:"smooth", block:"start"});
  };

  document.getElementById("btnClear").addEventListener("click", function(){
    state = ITEMS.map(function(){ return null; });
    pendingItems = [];
    loaded = null;
    isDemo = false;
    demoFlag.hidden = true;
    var t = document.getElementById("modelTitle");
    if (t) t.textContent = "「재무 (신용)」 평가표";
    var fn = document.getElementById("footNote");
    if (fn) fn.textContent = "평가표는 비어 있는 상태로 보관합니다. 위쪽에 신용분석보고서를 올리면 그 보고서 기준으로 채워집니다.";
    render();
  });

  render();
})();

/* ═══════════ ② 게이지 판독 (원본 515~787행) ═══════════ */
/* ===== 게이지 그림 판독 =====
   3페이지 신용등급 카드의 기업평가등급·현금흐름등급은 텍스트 레이어가 없어
   화면에 그려진 픽셀을 직접 읽는다. 글자 후보가 A~F·N·R·숫자·부호로 한정돼 있어
   외부 OCR 없이 글자 모양 대조로 판별한다. */
var GAUGE_CHARS = "ABCDEFNR0123456789+-";
var _tpl = null;

/* 종횡비를 유지한 채 N×N 안에 가운데 맞춤으로 넣는다.
   단순히 늘려 넣으면 얇은 '1' 이 꽉 찬 사각형이 되어 '3' 과 구분되지 않는다. */
function _normBitmap(mask, w, h, box, N){
  var out = new Float32Array(N*N);
  var bw = box.x1-box.x0+1, bh = box.y1-box.y0+1;
  var side = Math.max(bw, bh);
  var offX = Math.floor((side - bw)/2), offY = Math.floor((side - bh)/2);
  for (var y=0;y<N;y++){
    for (var x=0;x<N;x++){
      var sx0 = Math.floor(x*side/N) - offX, sx1 = Math.floor((x+1)*side/N) - offX;
      var sy0 = Math.floor(y*side/N) - offY, sy1 = Math.floor((y+1)*side/N) - offY;
      var on = 0, tot = 0;
      for (var sy=sy0; sy<sy1; sy++){
        for (var sx=sx0; sx<sx1; sx++){
          tot++;
          var ax = box.x0 + sx, ay = box.y0 + sy;
          if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) continue;
          if (mask[ay*w+ax]) on++;
        }
      }
      out[y*N+x] = tot ? on/tot : 0;
    }
  }
  return out;
}

var TPL_FONTS = ["bold 64px Arial, sans-serif",
                 "bold 64px 'Malgun Gothic', sans-serif",
                 "bold 64px 'Helvetica Neue', Helvetica, sans-serif",
                 "700 64px 'Noto Sans', 'Liberation Sans', sans-serif",
                 "64px Arial, sans-serif"];
function _templates(){
  if (_tpl) return _tpl;
  _tpl = {};
  var N = 24, S = 96;
  var cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  var cx = cv.getContext("2d");
  for (var fi=0; fi<TPL_FONTS.length; fi++){
  for (var i=0;i<GAUGE_CHARS.length;i++){
    var ch = GAUGE_CHARS[i];
    cx.clearRect(0,0,S,S);
    cx.fillStyle = "#000";
    cx.font = TPL_FONTS[fi];
    cx.textBaseline = "middle"; cx.textAlign = "center";
    cx.fillText(ch, S/2, S/2);
    var im = cx.getImageData(0,0,S,S).data;
    var mask = new Uint8Array(S*S), box = {x0:S,y0:S,x1:-1,y1:-1};
    for (var p=0;p<S*S;p++){
      if (im[p*4+3] > 80){
        mask[p] = 1;
        var x = p % S, y = (p / S) | 0;
        if (x<box.x0) box.x0=x; if (x>box.x1) box.x1=x;
        if (y<box.y0) box.y0=y; if (y>box.y1) box.y1=y;
      }
    }
    if (box.x1 < 0) continue;
    (_tpl[ch] = _tpl[ch] || []).push({bm: _normBitmap(mask, S, S, box, N),
                                      ar: (box.x1-box.x0+1)/(box.y1-box.y0+1)});
  }
  }
  return _tpl;
}

function _score(a, b){
  var inter = 0, uni = 0;
  for (var i=0;i<a.length;i++){
    inter += Math.min(a[i], b[i]);
    uni += Math.max(a[i], b[i]);
  }
  return uni ? inter/uni : 0;
}

/* 문서 자체의 글자로 템플릿을 만든다.
   게이지는 그림이지만, 같은 글자가 '[첨부1] 등급 정의' 페이지에는 텍스트로 있다.
   시스템 글꼴로 만든 템플릿은 PC마다 모양이 달라(예: DejaVu 의 '1' 은 밑받침이 있다)
   오판독이 생기므로, 보고서 안의 같은 서체를 기준으로 삼는다. */
var _docTpl = null;

function _compsOf(mask, w, h, minPx){
  var seen = new Uint8Array(w*h), comps = [];
  var qx = new Int32Array(w*h), qy = new Int32Array(w*h);
  for (var y0=0;y0<h;y0++){
    for (var x0=0;x0<w;x0++){
      var idx = y0*w+x0;
      if (!mask[idx] || seen[idx]) continue;
      var head=0, tail=0; qx[tail]=x0; qy[tail]=y0; tail++; seen[idx]=1;
      var bx0=x0,bx1=x0,by0=y0,by1=y0,n=0;
      while (head < tail){
        var cx=qx[head], cy=qy[head]; head++; n++;
        if (cx<bx0)bx0=cx; if (cx>bx1)bx1=cx;
        if (cy<by0)by0=cy; if (cy>by1)by1=cy;
        for (var dy=-1;dy<=1;dy++) for (var dx=-1;dx<=1;dx++){
          var nx=cx+dx, ny=cy+dy;
          if (nx<0||ny<0||nx>=w||ny>=h) continue;
          var ni=ny*w+nx;
          if (mask[ni] && !seen[ni]){ seen[ni]=1; qx[tail]=nx; qy[tail]=ny; tail++; }
        }
      }
      if (n >= (minPx||10)) comps.push({x0:bx0,x1:bx1,y0:by0,y1:by1,n:n,w:bx1-bx0+1,h:by1-by0+1});
    }
  }
  return comps.sort(function(a,b){ return a.x0-b.x0; });
}

function _maskOf(cv){
  var w=cv.width, h=cv.height;
  var im = cv.getContext("2d").getImageData(0,0,w,h).data;
  var mask = new Uint8Array(w*h);
  for (var i=0;i<w*h;i++){
    var r=im[i*4], g=im[i*4+1], b=im[i*4+2];
    var lum = .299*r + .587*g + .114*b;
    var chroma = Math.max(r,g,b) - Math.min(r,g,b);
    if (lum < 150 && chroma < 60) mask[i] = 1;
  }
  return {mask:mask, w:w, h:h};
}

async function buildDocTemplates(doc){
  if (_docTpl) return _docTpl;
  var NEED = "ABCDEFNR0123456789";
  var tpl = {}, scale = 6;
  /* 글자 조각이 짧게 끊겨 있으므로(예: "CF" + "1"), 알파벳/숫자만으로 된 짧은 조각을
     전부 후보로 삼아 그 조각의 그림에서 글자 모양을 떠낸다. */
  var pages = [22, 15, 3, 18, 11, 19, 4];
  for (var pi=0; pi<pages.length; pi++){
    if (NEED.split("").every(function(c){ return tpl[c]; })) break;
    var pn = pages[pi];
    if (pn > doc.numPages) continue;
    var page = await doc.getPage(pn);
    var tc = await page.getTextContent();
    var targets = [];
    tc.items.forEach(function(it){
      if (!it.str) return;
      var s = it.str.trim();
      if (!/^[A-Z0-9]{1,5}$/.test(s)) return;
      if (!s.split("").some(function(c){ return NEED.indexOf(c) >= 0 && !tpl[c]; })) return;
      targets.push({it: it, txt: s});
    });
    if (!targets.length) continue;
    var vp = page.getViewport({scale: scale});
    var cv = document.createElement("canvas");
    cv.width = vp.width; cv.height = vp.height;
    await page.render({canvasContext: cv.getContext("2d"), viewport: vp}).promise;
    var pageH = page.getViewport({scale:1}).height;
    var M = _maskOf(cv);
    targets.forEach(function(t){
      if (!t.txt.split("").some(function(c){ return NEED.indexOf(c) >= 0 && !tpl[c]; })) return;
      var ih = t.it.height || 10;
      var x0 = Math.max(0, Math.floor((t.it.transform[4] - 0.6) * scale));
      var y0 = Math.max(0, Math.floor((pageH - t.it.transform[5] - ih * 1.15) * scale));
      var cw = Math.min(M.w - x0, Math.ceil((t.it.width + 1.2) * scale));
      var chh = Math.min(M.h - y0, Math.ceil(ih * 1.7 * scale));
      if (cw <= 4 || chh <= 4) return;
      var sub = new Uint8Array(M.w * M.h);
      for (var y=y0; y<y0+chh; y++)
        for (var x=x0; x<x0+cw; x++) sub[y*M.w+x] = M.mask[y*M.w+x];
      var comps = _compsOf(sub, M.w, M.h, 8);
      if (comps.length !== t.txt.length) return;      /* 한 글자씩 정확히 떨어질 때만 쓴다 */
      for (var i=0;i<t.txt.length;i++){
        var ch = t.txt[i], c = comps[i];
        if (tpl[ch] || NEED.indexOf(ch) < 0) continue;
        if (c.h < 8) continue;
        tpl[ch] = {bm: _normBitmap(sub, M.w, M.h, c, 24), ar: c.w / c.h};
      }
    });
  }
  _docTpl = Object.keys(tpl).length ? tpl : null;
  return _docTpl;
}

/* 캔버스에서 어두운 무채색 글자만 골라 좌→우로 읽는다 */
function readGauge(cv, docTpl){
  var N = 24;
  var ctx = cv.getContext("2d");
  var w = cv.width, h = cv.height;
  var im = ctx.getImageData(0,0,w,h).data;
  var mask = new Uint8Array(w*h);
  for (var p=0;p<w*h;p++){
    var r = im[p*4], g = im[p*4+1], b = im[p*4+2];
    var lum = 0.299*r + 0.587*g + 0.114*b;
    var chroma = Math.max(r,g,b) - Math.min(r,g,b);
    if (lum < 130 && chroma < 60) mask[p] = 1;      /* 진한 회색~검정 글자 */
  }
  /* 연결요소 */
  var seen = new Uint8Array(w*h), comps = [];
  var qx = new Int32Array(w*h), qy = new Int32Array(w*h);
  for (var y0=0;y0<h;y0++){
    for (var x0=0;x0<w;x0++){
      var idx = y0*w+x0;
      if (!mask[idx] || seen[idx]) continue;
      var head=0, tail=0; qx[tail]=x0; qy[tail]=y0; tail++; seen[idx]=1;
      var bx0=x0, bx1=x0, by0=y0, by1=y0, n=0;
      while (head < tail){
        var cxp = qx[head], cyp = qy[head]; head++; n++;
        if (cxp<bx0) bx0=cxp; if (cxp>bx1) bx1=cxp;
        if (cyp<by0) by0=cyp; if (cyp>by1) by1=cyp;
        for (var dy=-1;dy<=1;dy++){
          for (var dx=-1;dx<=1;dx++){
            var nx=cxp+dx, ny=cyp+dy;
            if (nx<0||ny<0||nx>=w||ny>=h) continue;
            var ni=ny*w+nx;
            if (mask[ni] && !seen[ni]){ seen[ni]=1; qx[tail]=nx; qy[tail]=ny; tail++; }
          }
        }
      }
      if (n >= 12) comps.push({x0:bx0,x1:bx1,y0:by0,y1:by1,n:n,h:by1-by0+1,w:bx1-bx0+1});
    }
  }
  if (!comps.length) return null;
  /* 가장 큰 글자 높이를 기준으로 본문 줄만 남긴다 (날짜 같은 작은 글자 제외) */
  var maxH = 0;
  comps.forEach(function(c){ if (c.h > maxH) maxH = c.h; });
  var tall = comps.filter(function(c){ return c.h >= maxH*0.45; });
  if (!tall.length) return null;
  var ref = tall.reduce(function(a,c){ return c.h > a.h ? c : a; }, tall[0]);
  var line = tall.filter(function(c){
    var mid = (c.y0+c.y1)/2;
    return mid > ref.y0 - ref.h*0.6 && mid < ref.y1 + ref.h*0.6;
  }).sort(function(a,b){ return a.x0 - b.x0; });

  var T = _templates(), text = "", conf = 1;
  line.forEach(function(c){
    var sub = new Uint8Array(w*h);
    for (var yy=c.y0; yy<=c.y1; yy++)
      for (var xx=c.x0; xx<=c.x1; xx++) sub[yy*w+xx] = mask[yy*w+xx];
    var bm = _normBitmap(sub, w, h, c, N);
    var ar = c.w / c.h;
    var best = null, bestS = -1;
    /* 문서 자체 글자로 만든 템플릿을 먼저 쓰고, 없으면 시스템 글꼴 템플릿을 쓴다 */
    if (docTpl){
      for (var dch in docTpl){
        var ds = _score(bm, docTpl[dch].bm);
        if (ds > bestS){ bestS = ds; best = dch; }
      }
    }
    if (bestS < 0.6){
      for (var ch in T){
        var variants = T[ch];
        for (var vi=0; vi<variants.length; vi++){
          if (Math.abs(Math.log((ar||0.01)/(variants[vi].ar||0.01))) > 0.8) continue;
          var s = _score(bm, variants[vi].bm);
          if (s > bestS){ bestS = s; best = ch; }
        }
      }
    }
    if (best){ text += best; conf = Math.min(conf, bestS); }
  });
  return {text: text, conf: conf, chars: line.length};
}

/* 판독 문자열을 등급으로 정리한다 */
function tidyCF(t){
  if (!t) return null;
  var m = t.toUpperCase().replace(/[^A-Z0-9]/g,"").match(/CF?([1-6])/);
  return m ? "CF" + m[1] : null;
}
function tidyCredit(t){
  if (!t) return null;
  var s = t.toUpperCase().replace(/[^A-Z0-9+\-]/g,"");
  var m = s.match(/^(AAA|AA|A|BBB|BB|B|CCC|CC|C|D|NR|R)([+0\-])?/);
  return m ? {grade: m[1], sign: m[2] || ""} : null;
}


/* ═══════════ ③ 추출 · 등급 매핑 (원본 789~1035행) ═══════════ */
/* ===== PDF 파서 · 판정 로직 (nice_to_credit_score.py 와 동일 규칙) ===== */
var CREDIT = {
  A:["AAA","AA+","AA","AA-","A+","A","A-"],
  B:["BBB+","BBB","BBB-"],
  C:["BB+","BB","BB-"],
  D:["B+","B","B-"],
  E:["CCC+","CCC","CCC-","CC+","CC","CC-","C","D"]
};
var CREDIT_HOLD = ["R","NR"];
var CF = {CF1:"A", CF2:"B", CF3:"C", CF4:"D", CF5:"E", CF6:"E"};
var LADDER = {
  "지분비율":     [[["A",50],["B",30],["C",10],["D",0.0001]], "E"],
  "매출액규모억": [[["A",300],["B",200],["C",100],["D",50]], "E"],
  "부채비율":     [[["E",300],["D",250],["C",200],["B",150]], "A"],
  "유동비율":     [[["A",250],["B",200],["C",150],["D",100]], "E"],
  "차입금의존도": [[["E",40],["D",30],["C",20],["B",10]], "A"],
  "이자보상배율": [[["A",2],["B",1.5],["C",1],["D",0.5]], "E"],
  "매출액증가율": [[["A",30],["B",20],["C",10],["D",5]], "E"],
  "순이익증가율": [[["A",200],["B",150],["C",100],["D",50]], "E"],
  "자기자본비율": [[["A",70],["B",60],["C",50],["D",40]], "E"]
};
var KEYOF = {2:"지분비율",3:"매출액규모억",5:"부채비율",6:"유동비율",7:"차입금의존도",
             8:"이자보상배율",9:"매출액증가율",10:"순이익증가율",11:"자기자본비율"};

function ladderGrade(v, key){
  if (v === null || v === undefined || isNaN(v)) return null;
  var spec = LADDER[key], steps = spec[0], fb = spec[1];
  for (var i=0;i<steps.length;i++){ if (v >= steps[i][1]) return steps[i][0]; }
  return fb;
}
function creditGrade(sym){
  if (!sym) return null;
  var s = String(sym).toUpperCase().replace(/\s/g,"").replace(/[−–—]/g,"-");
  if (CREDIT_HOLD.indexOf(s) >= 0) return null;
  /* BBB0 · BBB+ · BBB- 처럼 부호가 붙어 와도 문자 구간으로 판정한다 */
  var m = s.match(/^(AAA|AA|A|BBB|BB|B|CCC|CC|C|D|NR|R)([+0\-])?$/);
  if (m) s = m[1];
  if (CREDIT_HOLD.indexOf(s) >= 0) return null;
  for (var g in CREDIT){ if (CREDIT[g].indexOf(s) >= 0) return g; }
  return null;
}
function growth(cur, prev){
  if (cur === null || prev === null || prev === 0) return null;
  if (prev < 0) return cur > 0 ? (cur - prev) / Math.abs(prev) * 100 : -100;
  if (cur < 0) return -100;
  return (cur / prev - 1) * 100;
}
/* 사설영역(PUA) 글리프와 NUL 제거 — 이 보고서의 '.' 와 등급부호가 여기에 해당 */
function cleanStr(t){
  var out = "";
  for (var i=0;i<t.length;i++){
    var c = t.charCodeAt(i);
    if ((c >= 0xE000 && c <= 0xF8FF) || c === 0) continue;
    out += t[i];
  }
  return out;
}
function numsOf(line){
  var out = [], toks = line.split(/\s+/);
  for (var i=0;i<toks.length;i++){
    var t = toks[i];
    if (t === "-" || t === "—") out.push(0);
    else if (/^-?[\d,]+$/.test(t)) out.push(parseInt(t.replace(/,/g,""),10));
  }
  return out;
}
/* 이 PDF는 천단위 쉼표와 소수점이 사설영역 글리프여서, 조각을 공백으로 이으면
   9,255 가 "9 255" 로 갈라진다. 조각 사이 x 간격이 벌어진 곳에서만 공백을 넣는다. */
/* 신용등급 카드(3페이지)의 게이지는 텍스트 레이어가 없다. 해당 영역을 캔버스로 그려 반환한다. */
async function gaugeCanvas(doc, label){
  for (var p=1;p<=Math.min(doc.numPages,6);p++){
    var page = await doc.getPage(p);
    var tc = await page.getTextContent();
    var anchor = null;
    tc.items.forEach(function(it){
      if (!it.str) return;
      if (it.str.replace(/\s/g,"") !== label) return;
      var y = it.transform[5];
      var sameRow = tc.items.some(function(o){
        return o.str && o.str.replace(/\s/g,"").indexOf("WATCH") === 0 &&
               Math.abs(o.transform[5] - y) < 4;
      });
      if (sameRow && !anchor) anchor = it;
    });
    if (!anchor) continue;
    var scale = 4;
    var vp = page.getViewport({scale: scale});
    var cv = document.createElement("canvas");
    cv.width = vp.width; cv.height = vp.height;
    await page.render({canvasContext: cv.getContext("2d"), viewport: vp}).promise;
    var pageH = page.getViewport({scale:1}).height;
    var x0 = (anchor.transform[4] - 18) * scale;
    var y0 = (pageH - anchor.transform[5] + 6) * scale;
    var w = 175 * scale, hgt = 92 * scale;
    var crop = document.createElement("canvas");
    crop.width = w; crop.height = hgt;
    crop.getContext("2d").drawImage(cv, x0, y0, w, hgt, 0, 0, w, hgt);
    return crop;
  }
  return null;
}

async function linesFromDoc(doc){
  var lines = [];
  for (var p=1;p<=doc.numPages;p++){
    var page = await doc.getPage(p);
    var tc = await page.getTextContent();
    var rows = {};
    tc.items.forEach(function(it){
      if (!it.str) return;
      var y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({x: it.transform[4], w: it.width || 0, s: it.str});
    });
    Object.keys(rows).map(Number).sort(function(a,b){return b-a;}).forEach(function(y){
      var arr = rows[y].sort(function(a,b){return a.x-b.x;});
      var line = "";
      for (var i=0;i<arr.length;i++){
        if (i > 0){
          var prev = arr[i-1];
          if (arr[i].x - (prev.x + prev.w) > 2) line += " ";
        }
        line += cleanStr(arr[i].s);
      }
      lines.push(line.replace(/\s+/g," ").trim());
    });
  }
  return lines;
}
function extractFromLines(lines){
  /* 재무제표 장(06)부터 읽는다. 앞쪽 '재무비율분석' 표에도 '매출액…' 로 시작하는 행이 있어
     그대로 읽으면 매출액영업이익률(2.71)을 매출액(323.93억)으로 잘못 잡는다. */
  var fs = 0;
  for (var i=0;i<lines.length;i++){
    if (lines[i].indexOf("재무제표") >= 0 && lines[i].indexOf("GAAP") >= 0){ fs = i; break; }
  }
  if (!fs){
    for (var i2=0;i2<lines.length;i2++){
      if (lines[i2].indexOf("재무상태표") === 0){ fs = i2; break; }
    }
  }
  function row(label, need){
    need = need || 3;
    for (var j=fs;j<lines.length;j++){
      var s = lines[j];
      if (s.indexOf(label) !== 0) continue;
      var rest = s.slice(label.length);
      if (rest && !/^[\s\d\-]/.test(rest)) continue;   /* 매출액 vs 매출액영업이익률 */
      var v = numsOf(rest);
      if (v.length >= need*2) return v.filter(function(_,k){return k%2===0;}).slice(0,need);
      if (v.length >= need) return v.slice(0,need);
    }
    return null;
  }
  var d = {};
  [["유동자산","유동자산"],["유동부채","유동부채"],["자산총계","자산총계"],["부채총계","부채총계"],
   ["자본총계","자본총계"],["매출액","매출액"],["영업이익","영업이익(손실)"],
   ["당기순이익","당기순이익"],["이자비용","(이자비용)"],["총차입금","총차입금"]]
   .forEach(function(pair){ d[pair[0]] = row(pair[1]); });

  var co = null;
  for (var k=0;k<Math.min(lines.length,14);k++){
    if (/\(주\)|주식회사|건설|산업/.test(lines[k]) && lines[k].length <= 24 && !/보고서|분석/.test(lines[k])){ co = lines[k]; break; }
  }
  var joined = lines.join("\n");
  var bm = joined.match(/\b\d{3}-\d{2}-\d{5}\b/);
  var dm = joined.match(/결산\s*기준\s*:?\s*(\d{8})/) || joined.match(/(\d{8})\s*$/m);
  var share = null;
  for (var m=0;m<lines.length;m++){
    if (lines[m].indexOf("주주명") === 0){
      var v = numsOf(lines[m+1] || "");
      if (v.length >= 2) share = v[1] / 100;
      break;
    }
  }
  /* NO.1 — 게이지는 이미지지만 '기업평가등급 이력' 표의 첫 행이 같은 등급이다.
     ± 기호는 사설 글리프라 빠지지만, 매핑이 문자 구간(BBB대·BB대…) 단위라 결과가 달라지지 않는다. */
  var rate = null;
  for (var q=0;q<lines.length;q++){
    if (lines[q].indexOf("기업평가등급 이력") === 0){
      for (var r=q+1;r<Math.min(q+10,lines.length);r++){
        /* 국내 평가사 표기는 BBB+ / BBB0 / BBB- 로 부호가 붙는다. 부호는 구간에 영향이 없다. */
        var mm = lines[r].match(/^(AAA|AA|A|BBB|BB|B|CCC|CC|C|D|NR|R)\s*([+0\-])?\s+(\d{8})\s+\d{8}\s*(\S*)/);
        if (mm && (!mm[4] || mm[4].indexOf("모형") === 0)){
          rate = {grade: mm[1], sign: mm[2] || "", date: mm[3]}; break;
        }
      }
      break;
    }
  }
  d.기업평가등급 = rate;

  /* NO.4 — 보고서에 따라 현금흐름등급이 텍스트로 있는 경우가 있다.
     '[첨부1] 등급 정의'의 범례(CF1(우수) …)는 괄호가 뒤따르므로 제외한다. */
  var cfFound = null;
  for (var c1=0;c1<lines.length;c1++){
    var ln = lines[c1];
    if (/등급\s*정의|창출능력/.test(ln)) continue;
    var cm = ln.match(/(?:^|[\s|])(CF[1-6])(?![\(0-9])/);
    if (cm){ cfFound = cm[1]; break; }
  }
  d.현금흐름등급 = cfFound;
  d.대표자지분율 = share; d.회사명 = co; d.사업자번호 = bm ? bm[0] : null;
  d.결산 = dm ? dm[1] : null;
  return d;
}
function buildResult(d, creditSym, cfSym){
  function cur(k,i){ return d[k] ? d[k][i||0] : null; }
  var 자산=cur("자산총계"), 부채=cur("부채총계"), 자본=cur("자본총계");
  var 유동자산=cur("유동자산"), 유동부채=cur("유동부채");
  var 매출=cur("매출액"), 전기매출=cur("매출액",1);
  var 순이익=cur("당기순이익"), 전기순이익=cur("당기순이익",1);
  var 영업이익=cur("영업이익"), 이자비용=cur("이자비용"), 차입금=cur("총차입금")||0;

  var v = {};
  v[2] = d.대표자지분율;
  v[3] = 매출 ? 매출/100 : null;
  v[5] = 자본 ? 부채/자본*100 : null;
  v[6] = 유동부채 ? 유동자산/유동부채*100 : null;
  v[7] = 자산 ? 차입금/자산*100 : null;
  v[8] = 이자비용 ? 영업이익/이자비용 : null;
  v[9] = 전기매출 ? (매출/전기매출-1)*100 : null;
  v[10] = growth(순이익, 전기순이익);
  v[11] = 자산 ? 자본/자산*100 : null;

  var g = {}, note = {};
  for (var no in KEYOF) g[no] = ladderGrade(v[no], KEYOF[no]);
  if (!이자비용){
    if (차입금){ g[8] = null; note[8] = "이자비용 0 · 차입금 " + 차입금.toLocaleString() + "백만 — 확인 필요"; }
    else { g[8] = "A"; v[8] = null; note[8] = "이자비용 0 — 무차입"; }
  }
  var auto = d.기업평가등급;
  var fromGauge = !!creditSym;
  if (!creditSym && auto) creditSym = auto.grade + (auto.sign || "");
  g[1] = creditGrade(creditSym); v[1] = creditSym || null;
  if (g[1] && !fromGauge && auto)
    note[1] = auto.grade + (auto.sign || "") + " — 기업평가등급 이력(" +
              auto.date.replace(/(\d{4})(\d{2})(\d{2})/,"$1-$2-$3") + " 모형등급)";
  if (!cfSym && d.현금흐름등급) cfSym = d.현금흐름등급;
  g[4] = cfSym ? (CF[String(cfSym).toUpperCase()] || null) : null; v[4] = cfSym || null;
  if (g[4] && cfSym) note[4] = cfSym + " — 보고서 텍스트에서 판독";
  if (!g[1]) note[1] = "등급 이력을 찾지 못함 — 확인 필요";
  if (!g[4]) note[4] = "게이지 이미지 — OCR 대기";
  return {values:v, grades:g, notes:note, raw:d};
}


/* ═══════════ ④ 업로드 UI (원본 1037~1178행) ═══════════ */
/* ===== 업로드 UI ===== */
(function(){
  var drop = document.getElementById("drop");
  var input = document.getElementById("pdfInput");
  var stat = document.getElementById("upstat");
  var logEl = document.getElementById("upLog");
  var coEl = document.getElementById("upCo");
  var metaEl = document.getElementById("upMeta");
  var NAMES = {1:"대외기관 신용등급",2:"대표자 지분비율",3:"매출액 규모",4:"현금흐름등급",
    5:"부채비율",6:"유동비율",7:"차입금의존도",8:"이자보상배율",9:"매출액증가율",
    10:"당기순이익증가율",11:"자기자본비율"};
  var UNIT = {2:"%",3:"억",5:"%",6:"%",7:"%",8:"배",9:"%",10:"%",11:"%"};
  var WEIGHT = {1:10,2:10,3:5,4:10,5:10,6:10,7:10,8:10,9:5,10:10,11:10};
  var RATE = {A:1,B:.8,C:.6,D:.4,E:.2};
  var OCR_ITEMS = [4];

  function fmt(no, v){
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    return v.toFixed(no === 8 ? 2 : (no === 3 ? 2 : 2)) + (UNIT[no] || "");
  }
  var last = null, lastName = "";
  function render(res, fileName){
    last = res; lastName = fileName;
    var html = "", fixed = 0, pending = 0;
    for (var no = 1; no <= 11; no++){
      var g = res.grades[no];
      var pts = g ? WEIGHT[no] * RATE[g] : null;
      if (g) fixed += pts; else pending += WEIGHT[no];
      var src = (res.src && res.src[no]) || (OCR_ITEMS.indexOf(no) >= 0 ? "게이지" : "텍스트");
      var val = res.notes[no] ? res.notes[no] : fmt(no, res.values[no]);
      if (no === 1 || no === 4){
        var img = res.gaugeImg && res.gaugeImg[no];
        var pic = img ? '<img class="confirm__img" src="' + img + '" alt="보고서 게이지">' : '';
        if (pic || !g){
          val = '<span class="confirm">' + pic +
                '<span class="' + (g ? 'confirm__ok' : 'confirm__msg') + '">' + val + '</span>' +
                ' <input type="text" class="confirm__input" data-no="' + no +
                '" placeholder="' + (no === 1 ? '다르면 입력' : '다르면 입력') + '" size="9"></span>';
        }
      }
      html += '<div class="uplog__row' + (g ? "" : " is-pending") + '">' +
        '<span class="uplog__k">' + no + '</span>' +
        '<span class="uplog__name">' + NAMES[no] + '</span>' +
        '<span class="uplog__val">' + val + '</span>' +
        '<span class="grade ' + (g ? "grade--" + g.toLowerCase() : "grade--none") + '">' + (g || "대기") + '</span>' +
        '<span class="uplog__src">' + src + (g ? " · " + pts.toFixed(1) + "점" : "") + '</span></div>';
    }
    var verdict = pending > 0
      ? "판정 보류 — 미확정 " + pending.toFixed(1) + "점 (OCR 대기)"
      : (fixed >= 70 ? "신용거래 추진" : "추진 불가 (70점 미만)");
    html += '<div class="uplog__row uplog__row--sum"><span class="uplog__k"></span>' +
      '<span class="uplog__name">소계</span>' +
      '<span class="uplog__val">' + verdict + '</span><span class="grade grade--none">합계</span>' +
      '<span class="uplog__src">' + fixed.toFixed(1) + ' / 100</span></div>';
    logEl.innerHTML = html;
    Array.prototype.forEach.call(logEl.querySelectorAll(".confirm__input"), function(inp){
      inp.addEventListener("change", function(){
        var no = Number(inp.getAttribute("data-no"));
        var val = inp.value.trim();
        if (!val) return;
        var g2 = no === 1 ? creditGrade(val) : (CF[val.toUpperCase()] || null);
        if (!g2){ inp.classList.add("is-bad"); return; }
        inp.classList.remove("is-bad");
        last.grades[no] = g2; last.values[no] = val; last.notes[no] = val + " — 담당자 확인 입력";
        render(last, lastName);
      });
    });
    coEl.textContent = res.raw.회사명 || "(회사명 미확인)";
    metaEl.textContent = [res.raw.사업자번호 || "", fileName].filter(Boolean).join("  ·  ");
    stat.hidden = false;
    if (setGrades) setGrades(res.grades, {co: res.raw.회사명});
  }
  function fail(msg){
    logEl.innerHTML = '<div class="uplog__err">' + msg + '</div>';
    coEl.textContent = "읽기 실패"; metaEl.textContent = "";
    stat.hidden = false;
  }
  async function handle(file){
    drop.classList.add("is-busy");
    coEl.textContent = "읽는 중…"; metaEl.textContent = file.name;
    logEl.innerHTML = ""; stat.hidden = false;
    try {
      await ensurePdfjs();   /* pdf.js 를 아직 안 받았으면 여기서 받는다 */
      var buf = await file.arrayBuffer();
      var doc = await pdfjsLib.getDocument({data: new Uint8Array(buf), isEvalSupported:false}).promise;
      var lines = await linesFromDoc(doc);
      var d = extractFromLines(lines);
      if (!d.자산총계 || !d.매출액) throw new Error("재무제표를 찾지 못했습니다. NICE 기업분석보고서(상세) 형식인지 확인해 주세요.");
      var gauge = {};
      for (var gi=0; gi<2; gi++){
        var lbl = gi === 0 ? "기업평가등급" : "현금흐름등급";
        try {
          var cv = await gaugeCanvas(doc, lbl);
          if (cv){
            var dt = await buildDocTemplates(doc);
            var rd = readGauge(cv, dt);
            /* 판독 신뢰도가 낮으면 값을 쓰지 않고 대기로 남긴다 (기준 50%) */
            var ok = rd && rd.conf >= 0.50;
            gauge[lbl] = {img: cv.toDataURL("image/png"), read: rd, conf: rd && rd.conf,
                          value: ok ? (gi === 0 ? tidyCredit(rd.text) : tidyCF(rd.text)) : null};
          }
        } catch(e){ /* 판독 실패는 대기로 남긴다 */ }
      }
      var gc = gauge["기업평가등급"], gf = gauge["현금흐름등급"];
      var res = buildResult(d,
        (gc && gc.value) ? (gc.value.grade + (gc.value.sign || "")) : null,
        (gf && gf.value) ? gf.value : null);
      function pct(c){ return Math.round((c||0)*100) + "%"; }
      res.src = {};
      if (gc && gc.value){
        res.notes[1] = gc.value.grade + (gc.value.sign||"") + " — 기업평가등급(모형등급) 게이지 판독 · 일치도 " + pct(gc.conf);
        res.src[1] = "게이지";
      }
      if (gf && gf.value) res.src[4] = "게이지";
      if (gf && gf.value) res.notes[4] = gf.value + " — 게이지 판독 (일치도 " + pct(gf.conf) + ")";
      if (gf && !gf.value) res.notes[4] = "게이지 판독 실패 — 그림을 보고 입력하세요";
      res.gaugeImg = {1: gc && gc.img, 4: gf && gf.img};
      res.gaugeRaw = {1: gc && gc.read && gc.read.text, 4: gf && gf.read && gf.read.text};
      render(res, file.name);
    } catch (e){
      fail("이 파일에서 값을 뽑지 못했습니다.<br>" + (e && e.message ? e.message : e));
    }
    drop.classList.remove("is-busy");
  }
  drop.addEventListener("click", function(){ input.click(); });
  drop.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", function(){ if (input.files[0]) handle(input.files[0]); });
  ["dragenter","dragover"].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add("is-over"); });
  });
  ["dragleave","drop"].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.remove("is-over"); });
  });
  drop.addEventListener("drop", function(e){
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handle(f);
  });
  document.getElementById("upReset").addEventListener("click", function(){
    stat.hidden = true; logEl.innerHTML = ""; input.value = "";
  });
})();


})();
