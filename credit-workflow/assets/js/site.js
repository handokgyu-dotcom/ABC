/* ══════════════════════════════════════════════════════════════
   site.js — 현장 현황

   계산은 없고 입력·저장·인쇄만 한다. 한 장짜리 양식으로 뽑는 것이 목적.

   저장 키는 페이지별로 분리했다(예전에는 타설계획과 한 덩어리로
   yeosin.v4 에 같이 들어가 있었다).
   ══════════════════════════════════════════════════════════════ */
(function(){
const BUILD='2026-09-15.1';
const KEY='yeosin.site.v1';
const {$, el, esc, fmtInt: W, fmtEok: formatEok, parseNum: num, setStatus, storage} = App;
const setSt=(id,state,txt)=>setStatus(id,state,txt);

const IDS=['i_sv_name','i_sv_addr','i_sv_from','i_sv_to','i_sv_purpose','i_sv_direct',
 'i_sv_orderer','i_sv_contractor','i_sv_trust','i_sv_paycond','i_sv_totalvol','i_sv_ourvol','i_sv_copour',
 'i_sv_households','i_sv_soldhh','i_sv_soldrate','i_sv_price','i_sv_marketprice',
 'i_sv_subway','i_sv_school','i_sv_office','i_sv_mart','i_sv_hospital','i_sv_ic',
 'i_sv_nearbysale','i_sv_environment','i_sv_footfall','i_sv_etc'];

function save(){
  try{const o={_b:BUILD};IDS.forEach(k=>o[k]=$(k).value);storage.set(KEY,o);}catch(e){}
}
function load(){
  try{const o=storage.get(KEY);if(!o||o._b!==BUILD)return false;
    IDS.forEach(k=>{if(o[k]!=null)$(k).value=o[k]});
    return true;}catch(e){return false}
}
function resetAll(){
  storage.remove(KEY,'yeosin.v4');
  location.reload();
}
load();

/* ── STEP 3 : 현장 현황 (계산 없는 단순 입력 · 저장만) ── */
['i_sv_name','i_sv_addr','i_sv_from','i_sv_to','i_sv_purpose','i_sv_direct',
 'i_sv_orderer','i_sv_contractor','i_sv_trust','i_sv_paycond','i_sv_totalvol','i_sv_ourvol','i_sv_copour',
 'i_sv_households','i_sv_soldhh','i_sv_soldrate','i_sv_price','i_sv_marketprice',
 'i_sv_subway','i_sv_school','i_sv_office','i_sv_mart','i_sv_hospital','i_sv_ic',
 'i_sv_nearbysale','i_sv_environment','i_sv_footfall','i_sv_etc'].forEach(id=>{
  $(id).addEventListener('input',save);
  $(id).addEventListener('change',save);
});
$('btn_reset_sv').addEventListener('click',resetAll);

function buildSVPrintHTML(){
  const v=id=>{const el=$(id);const val=el?el.value:'';return val?val:'&nbsp;'};
  const period=($('i_sv_from').value||$('i_sv_to').value)
    ? (($('i_sv_from').value||'')+' ~ '+($('i_sv_to').value||''))
    : '&nbsp;';
  return ''+
    '<h1>■ 현장 현황 (현재 당사납품현장)</h1>'+
    '<p class="pr-sub">작성일: '+new Date().toISOString().slice(0,10)+'</p>'+
    '<table class="sv-tbl">'+
      // 전체 표를 11칸 기준 그리드로 맞춰서, 그룹마다 칸 수가 달라도 좌우 끝이 가지런히 정렬되게 한다
      '<tr><th colspan="2">현장명(공사유형)</th><th colspan="2">현장위치(주소)</th><th colspan="3">공사기간</th><th colspan="2">현장 목적</th><th colspan="2">직접/도급</th></tr>'+
      '<tr><td colspan="2">'+v('i_sv_name')+'</td><td colspan="2">'+v('i_sv_addr')+'</td><td colspan="3">'+period+'</td><td colspan="2">'+v('i_sv_purpose')+'</td><td colspan="2">'+v('i_sv_direct')+'</td></tr>'+
      '<tr><th colspan="2">발주처</th><th colspan="2">시공사</th><th>신탁사</th><th colspan="2">기성지급조건</th><th>총물량(㎥)</th><th>당사물량(㎥)</th><th colspan="2">공동타설사</th></tr>'+
      '<tr><td colspan="2">'+v('i_sv_orderer')+'</td><td colspan="2">'+v('i_sv_contractor')+'</td><td>'+v('i_sv_trust')+'</td><td colspan="2">'+v('i_sv_paycond')+'</td><td>'+v('i_sv_totalvol')+'</td><td>'+v('i_sv_ourvol')+'</td><td colspan="2">'+v('i_sv_copour')+'</td></tr>'+
      '<tr><th rowspan="2">총세대수</th><th rowspan="2">분양세대수</th><th rowspan="2">분양률</th><th rowspan="2">분양가(평)</th><th rowspan="2">주변시세(평)</th><th colspan="6">인프라</th></tr>'+
      '<tr><th>지하철</th><th>학교</th><th>관공서</th><th>마트</th><th>병원</th><th>IC</th></tr>'+
      '<tr><td>'+v('i_sv_households')+'</td><td>'+v('i_sv_soldhh')+'</td><td>'+v('i_sv_soldrate')+'</td>'+
        '<td>'+v('i_sv_price')+'</td><td>'+v('i_sv_marketprice')+'</td>'+
        '<td>'+v('i_sv_subway')+'</td><td>'+v('i_sv_school')+'</td><td>'+v('i_sv_office')+'</td><td>'+v('i_sv_mart')+'</td><td>'+v('i_sv_hospital')+'</td><td>'+v('i_sv_ic')+'</td></tr>'+
      '<tr><th colspan="3">주변분양현황</th><th colspan="2">주변환경</th><th colspan="2">유동인구비율</th><th colspan="4">기타 의견</th></tr>'+
      '<tr><td colspan="3">'+v('i_sv_nearbysale')+'</td><td colspan="2">'+v('i_sv_environment')+'</td><td colspan="2">'+v('i_sv_footfall')+'</td><td colspan="4" style="text-align:left">'+v('i_sv_etc')+'</td></tr>'+
    '</table>'+
    '<p class="pr-foot">※ 한장으로 현장 상황을 알수 있게 최대한 상세히 작성해 주세요</p>';
}
function printSV(){
  $('ts_print_area').innerHTML=buildSVPrintHTML();
  window.print();
}
$('btn_sv_pdf').addEventListener('click',printSV);

})();
