/* ══════════════════════════════════════════════════════════════
   utils.js — 두 페이지가 공유하는 유틸

   모듈이 아니라 클래식 스크립트다. file:// 로 열었을 때 ES module 은
   CORS 로 막히기 때문. 그래서 전역 하나(App)에만 붙인다.

   합치기 전에는 같은 일을 두 벌로 하고 있었다:
     숫자 포맷  surety.W()/num()/formatEok()  vs  credit.fmt()/pct()
     DOM 조회   surety.$()                    vs  credit 은 매번 getElementById
     상태 배지  surety.setSt()                vs  credit 은 없음
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";

var DASH = "—";

/* ───────────────────────── DOM ───────────────────────── */

function $(id, root){
  return (root || document).getElementById ? (root || document).getElementById(id)
                                           : (root || document).querySelector("#" + id);
}
function $one(sel, root){ return (root || document).querySelector(sel); }
function $all(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/* 가벼운 하이퍼스크립트. 문자열 innerHTML 연결을 대체해 따옴표 이스케이프
   문제를 원천적으로 없앤다(현장명에 " 를 넣으면 예전 코드는 표가 깨졌다). */
function el(tag, props){
  var node = document.createElement(tag);
  var children = Array.prototype.slice.call(arguments, 2);
  if (props){
    Object.keys(props).forEach(function(k){
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.slice(0,2) === "on" && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? "" : v);
    });
  }
  flatten(children).forEach(function(c){
    if (c == null || c === false) return;
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return node;
}
function flatten(arr){
  return arr.reduce(function(acc, x){
    return acc.concat(Array.isArray(x) ? flatten(x) : x);
  }, []);
}

/* innerHTML 을 써야 하는 자리(표 셀 묶음 등)에서 값만 안전하게 끼운다 */
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ───────────────────────── 숫자 ───────────────────────── */

/* 천 단위 구분. null·NaN 은 — 로 떨어진다. */
function fmtInt(n){
  return (n == null || isNaN(n)) ? DASH : Math.round(n).toLocaleString("ko-KR");
}
/* 소수 자리 고정 */
function fmtFixed(n, digits){
  return (n == null || isNaN(n)) ? DASH : Number(n).toFixed(digits == null ? 1 : digits);
}
/* 억/만원 단위로 읽기 좋게 (예: 450000000 → "4억 5,000만원") */
function fmtEok(n){
  if (!n) return DASH;
  var eok = Math.floor(n / 100000000);
  var man = Math.round((n % 100000000) / 10000);
  var s = "";
  if (eok) s += eok + "억";
  if (man) s += (s ? " " : "") + man.toLocaleString("ko-KR") + "만원";
  if (!eok && !man) s = fmtInt(n) + "원";
  return s;
}
/* 0~1 비율 → 백분율 문자열 */
function fmtPct(ratio){ return Math.round((ratio || 0) * 100) + "%"; }

/* 사용자가 친 문자열에서 숫자만 뽑는다. 빈 값이면 null. */
function parseNum(s){
  var d = String(s == null ? "" : s).replace(/[^0-9.-]/g, "");
  return d === "" ? null : Number(d);
}

/* ───────────────────────── 상태 배지 ───────────────────────── */

/* state: "on" | "run" | "off" | null(지움) */
function setStatus(target, state, text){
  var node = typeof target === "string" ? $(target) : target;
  if (!node) return;
  node.className = "status" + (state ? " status--" + state : "");
  node.textContent = text || "";
}

/* ───────────────────────── 저장 ───────────────────────── */

var storage = {
  get: function(key, fallback){
    try{
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    }catch(e){ return fallback; }
  },
  set: function(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch(e){ return false; }
  },
  remove: function(){
    var keys = Array.prototype.slice.call(arguments);
    try{ keys.forEach(function(k){ localStorage.removeItem(k); }); }catch(e){}
  }
};

/* ───────────────────────── 스크립트 지연 로드 ─────────────────────────
   pdf.js 처럼 무거운 vendor 를 필요할 때만 받는다. 순서대로 직렬 로드한다. */
function loadScripts(srcs){
  return srcs.reduce(function(chain, src){
    return chain.then(function(){
      return new Promise(function(resolve, reject){
        var s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = function(){ reject(new Error(src + " 를 불러오지 못했습니다")); };
        document.head.appendChild(s);
      });
    });
  }, Promise.resolve());
}

window.App = {
  DASH: DASH,
  $: $, $one: $one, $all: $all, el: el, esc: esc,
  fmtInt: fmtInt, fmtFixed: fmtFixed, fmtEok: fmtEok, fmtPct: fmtPct, parseNum: parseNum,
  setStatus: setStatus,
  storage: storage,
  loadScripts: loadScripts
};

})();
