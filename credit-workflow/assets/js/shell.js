/* ══════════════════════════════════════════════════════════════
   shell.js — 해시 라우팅

   index.html 안에 세 개의 .page 컨테이너(#page-home / #page-credit /
   #page-surety)가 전부 들어 있고, 이 파일이 그중 하나만 보이게 한다.

   해시를 쓰는 이유: 진짜 <a href="#credit"> 이므로 뒤로가기·앞으로가기,
   가운데클릭, 북마크, 새로고침이 전부 공짜로 동작하고, file:// 로 열어도
   서버 없이 그대로 굴러간다. (fetch 기반 라우팅은 file:// 에서 CORS 로 막힌다)
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";

var ROUTES = {
  home:   {page:"page-home",   title:"레미콘 여신심사"},
  credit: {page:"page-credit", title:"신용거래 심사 · 레미콘 여신심사"},
  surety: {page:"page-surety", title:"연대보증 심사 · 레미콘 여신심사"}
};
var DEFAULT = "home";

var pages = {};
Object.keys(ROUTES).forEach(function(key){
  pages[key] = document.getElementById(ROUTES[key].page);
});
var navLinks = [].slice.call(document.querySelectorAll(".site-nav a[data-route]"));

function routeOf(hash){
  var key = String(hash || "").replace(/^#\/?/, "");
  return ROUTES[key] ? key : DEFAULT;
}

var current = null;

function show(key){
  if (key === current) return;

  Object.keys(pages).forEach(function(k){
    if (pages[k]) pages[k].hidden = (k !== key);
  });

  navLinks.forEach(function(a){
    if (a.dataset.route === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  document.title = ROUTES[key].title;

  /* 신용 페이지에 들어오는 순간 pdf.js(1.5MB)를 미리 받아둔다.
     credit.js 가 노출하는 훅이며, 실패는 업로드 시점에 보고된다. */
  if (key === "credit" && typeof window.__preloadCredit === "function") window.__preloadCredit();

  /* 페이지를 바꿀 때는 위에서부터 보여준다. 첫 진입(current===null)에는
     브라우저가 복원한 스크롤 위치를 건드리지 않는다. */
  if (current !== null) window.scrollTo(0, 0);

  current = key;
}

function sync(){ show(routeOf(location.hash)); }

window.addEventListener("hashchange", sync);
sync();

})();
