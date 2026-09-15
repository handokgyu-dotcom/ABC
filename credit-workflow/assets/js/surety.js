/* ══════════════════════════════════════════════════════════════
   surety.js — 연대보증 심사 페이지
   원본: remicon_credit_workflow.html 의 <script>

   계산 로직은 손대지 않았다. 단가표 · 월중여신/신청여신 산출식 ·
   localStorage 키(yeosin.v4) · BUILD 상수 · 인쇄 양식 전부 그대로다.

   바뀐 것은 껍데기뿐:
     · 숫자 포맷/DOM 조회/저장 헬퍼를 utils.js(App)에서 가져다 쓴다
       (전에는 credit.js 와 같은 일을 두 벌로 갖고 있었다)
     · 생성하는 마크업이 components.css 의 공통 클래스를 쓴다
       (.act ghost → .btn, .warnbox → .callout, class="n" → class="num" …)
     · 피크 월중여신 강조를 인라인 style 대신 .ts-derived--peak 클래스로
     · 사용자가 친 현장명/비고와 백엔드가 준 주소를 esc() 로 이스케이프한다
       — 전에는 현장명에 따옴표를 넣으면 value 속성이 깨져 표가 무너졌다
     · 레일/패널 조회를 #page-surety 안으로 한정하고, showPanel() 의
       scrollIntoView 는 페이지가 보일 때만 동작하도록 가드한다
   ══════════════════════════════════════════════════════════════ */
(function(){
const BUILD='2026-09-11.17';
const KEY='yeosin.v4';
/* 숫자 포맷·DOM 조회·저장은 전부 utils.js(App) 소유다. 예전에는 이 파일과
   credit.js 가 같은 일을 두 벌로 갖고 있었다. */
const {$, el, esc, fmtInt: W, fmtEok: formatEok, parseNum: num, setStatus, storage} = App;
/* ── 레미콘 단가표 (100% 기준 · 굵은골재 최대치수 25mm · 서울·경기·인천 · 2026.04.01 적용 · 원/㎥ · VAT별도) ── */
const TS_PRICE_TABLE={
  80:  {'13.5':84560,'15':86330,'16':87840,'18':95880,'21':97800,'24':102230,'27':106020,'30':111390,'33':113940,'35':116260,'38':125000,'40':130840},
  120: {'13.5':85950,'15':87840,'16':89610,'18':97550,'21':100330,'24':105070,'27':109180,'30':114240,'33':116850,'35':119040,'38':127790,'40':133630},
  150: {'13.5':86830,'15':89230,'16':91130,'18':98540,'21':102380,'24':106970,'27':111710,'30':116920,'33':119590,'35':121430,'38':130430,'40':136430},
  180: {'13.5':87970,'15':90750,'16':92390,'18':100040,'21':103640,'24':109020,'27':114070,'30':119440,'33':122190,'35':123660,'38':133610,'40':140250},
  210: {'13.5':88980,'15':91510,'16':93410,'18':101530,'21':105700,'24':111230,'27':116760,'30':122140,'33':124940,'35':126470,'38':137950,'40':145610}
};
const TS_STRENGTHS=['13.5','15','16','18','21','24','27','30','33','35','38','40'];
const TS_SLUMPS=Object.keys(TS_PRICE_TABLE);
$('i_ts_strength').innerHTML=TS_STRENGTHS.map(s=>'<option value="'+s+'"'+(s==='21'?' selected':'')+'>'+s+'</option>').join('');
$('i_ts_slump').innerHTML=TS_SLUMPS.map(s=>'<option value="'+s+'"'+(s==='150'?' selected':'')+'>'+s+'</option>').join('');

/* ── 단계 이동 : 선택한 STEP 패널만 보이고 나머지는 숨긴다 ── */
/* 셸 안에서는 신용 페이지도 같은 문서에 있으므로, 레일/패널 조회를
   이 페이지 컨테이너 안으로 한정한다. */
const PAGE=document.getElementById('page-surety');
const rail=[...PAGE.querySelectorAll('.steps button')];
const panels=[...PAGE.querySelectorAll('#stepPanels > .step-panel')];
function showPanel(id){
  panels.forEach(p=>{p.hidden=(p.id!==id)});
  const el=$(id);
  /* 초기 1회 호출은 셸이 이 페이지를 아직 hidden 으로 둔 상태에서 일어난다.
     숨은 요소로 스크롤하면 엉뚱한 위치로 튀므로 보이는 동안에만 스크롤한다. */
  if(el&&!PAGE.hidden) el.scrollIntoView({behavior:'smooth',block:'start'});
}
rail.forEach(b=>b.addEventListener('click',()=>{
  rail.forEach(x=>x.setAttribute('aria-selected',x===b));
  showPanel(b.dataset.go);
}));
showPanel(rail[0].dataset.go); // 초기 화면: 첫 STEP만 표시
function markDone(i,on){if(rail[i])rail[i].classList.toggle('is-done',!!on)}

const setSt=(id,state,txt)=>setStatus(id,state,txt);
/* ── 로컬 임시저장 (이 브라우저에만) ── */
const IDS=[
 'i_ts_start','i_ts_end','i_ts_days','i_ts_strength','i_ts_slump','i_ts_discount','i_ts_roundunit',
 'i_sv_name','i_sv_addr','i_sv_from','i_sv_to','i_sv_purpose','i_sv_direct',
 'i_sv_orderer','i_sv_contractor','i_sv_trust','i_sv_paycond','i_sv_totalvol','i_sv_ourvol','i_sv_copour',
 'i_sv_households','i_sv_soldhh','i_sv_soldrate','i_sv_price','i_sv_marketprice',
 'i_sv_subway','i_sv_school','i_sv_office','i_sv_mart','i_sv_hospital','i_sv_ic',
 'i_sv_nearbysale','i_sv_environment','i_sv_footfall','i_sv_etc'];
function save(){
  try{const o={};IDS.forEach(k=>o[k]=$(k).value);
    o._ts=[...$('ts_tbl').querySelectorAll('tbody tr')].map(tr=>{
      const d={site:tr.querySelector('.ts-site').value,note:tr.querySelector('.ts-note').value};
      tr.querySelectorAll('.ts-m').forEach(inp=>{d[inp.dataset.ym]=inp.value});
      return d;
    });
    o._b=BUILD;
    storage.set(KEY,o);}catch(e){}
}
function load(){
  try{const o=storage.get(KEY);if(!o)return false;
    if(o._b!==BUILD)return false;
    IDS.forEach(k=>{if(o[k]!=null)$(k).value=o[k]});
    renderTSHead();
    $('ts_tbl').querySelector('tbody').innerHTML='';
    (o._ts||[]).forEach(d=>tsRow(d));
    return true;}catch(e){return false}
}

/* ── 초기 상태: 예시 데이터 ── */
function seed(){
  if(!$('i_ts_start').value){const t=new Date();$('i_ts_start').value=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0');}
  if(!$('i_ts_days').value)$('i_ts_days').value='35';
  renderTSHead();
  $('ts_tbl').querySelector('tbody').innerHTML='';
  const months=getMonthList();
  const ex={site:'전현장'};
  [1800,2100,1950].forEach((v,i)=>{if(months[i])ex[months[i].key]=String(v)}); // 예시 타설량(㎥)
  tsRow(ex);
}
function resetAll(){
  storage.remove('yeosin.v1','yeosin.v3',KEY);
  location.reload();
}

/* ── STEP 1 : 담보가치 자동 평가 (streamlit-app FastAPI 백엔드 호출) ── */
/* 개발 기본값. streamlit-app/api_server.py 를 로컬에서 uvicorn으로 띄운 주소. */
const API_BASE='http://localhost:8000';
let COLLATERAL_RESULT=null;

if($('f_collateral_pdf'))$('f_collateral_pdf').addEventListener('change',e=>{
  const f=e.target.files&&e.target.files[0];
  $('f_collateral_pdf_got').textContent=f?(f.name+' · '+Math.round(f.size/1024)+' KB'):'';
});

function fmtTradeDate(y,m,d){
  if(y&&m&&d)return y+'.'+String(m).padStart(2,'0')+'.'+String(d).padStart(2,'0');
  return '—';
}

function hgnnTradeRows(trades){
  return (trades||[]).slice(0,5).map(t=>{
    const dm=String(t.date||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return '<tr>'+
      '<td>'+(dm?fmtTradeDate(dm[1],dm[2],dm[3]):'—')+'</td>'+
      '<td class="num">'+(t.floor!=null?t.floor+'층':'—')+'</td>'+
      '<td class="num">'+(t.price!=null?W(Math.round(t.price*10000)):'—')+'</td>'+
      '</tr>';
  }).join('');
}

function molitTradeRows(trades){
  return (trades||[]).slice(0,5).map(t=>{
    const amt=parseInt(String(t.dealAmount||'').replace(/,/g,''),10);
    return '<tr>'+
      '<td>'+fmtTradeDate(t.dealYear,t.dealMonth,t.dealDay)+'</td>'+
      '<td class="num">'+(t.floor!=null?t.floor+'층':'—')+'</td>'+
      '<td class="num">'+(t.excluUseAr?Number(t.excluUseAr).toFixed(1)+'㎡':'—')+'</td>'+
      '<td class="num">'+(!isNaN(amt)?W(amt*10000):'—')+'</td>'+
      '</tr>';
  }).join('');
}

function renderTradeDetail(p){
  const hgnnRows=hgnnTradeRows(p.recent_trades);
  const molitRows=molitTradeRows(p.molit_trades);
  return '<div class="trade-detail">'+
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">국토부 실거래가 (최근 3개월)</span>'+(p.molit_price!=null?'평균 '+W(p.molit_price)+' · '+(p.molit_trade_count||0)+'건':'거래 없음')+'</div>'+
    (molitRows?'<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">전용면적</th><th class="num">금액</th></tr></thead><tbody>'+molitRows+'</tbody></table>':'<div class="muted">최근 거래 내역 없음</div>')+
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">호갱노노 최근 실거래</span>'+(p.hogangnono_price!=null?'평균 '+W(p.hogangnono_price):'거래 없음')+'</div>'+
    (hgnnRows?'<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">금액</th></tr></thead><tbody>'+hgnnRows+'</tbody></table>':'<div class="muted">최근 거래 내역 없음</div>')+
    '</div>';
}

function renderCollateralResult(data){
  const tbody=$('collateral_tbl').querySelector('tbody');
  tbody.innerHTML='';
  (data.properties||[]).forEach(p=>{
    const tr=document.createElement('tr');
    const rateTxt=p.hammer_rate!=null?Math.round(p.hammer_rate*100)+'%'+(p.matched_rate_region?' · '+p.matched_rate_region:''):'—';
    tr.innerHTML=
      '<td>'+esc(p.address||'주소 미상')+(p.error?'<div class="muted">'+esc(p.error)+'</div>':'')+'</td>'+
      '<td class="num">'+(p.total_priority_amount!=null?W(p.total_priority_amount):'—')+'</td>'+
      '<td class="num">'+(p.market_price!=null?W(p.market_price):'—')+'</td>'+
      '<td class="num">'+rateTxt+'</td>'+
      '<td class="num">'+(p.collateral_value!=null?W(p.collateral_value):'—')+'</td>';
    tbody.appendChild(tr);

    const dtr=document.createElement('tr');
    const dtd=document.createElement('td');
    dtd.colSpan=5;
    dtd.innerHTML=renderTradeDetail(p);
    dtr.appendChild(dtd);
    tbody.appendChild(dtr);
  });
  $('o_collateral_total').textContent=data.grand_total_collateral!=null?W(data.grand_total_collateral):'—';
}

async function evaluateCollateral(){
  const f=$('f_collateral_pdf').files&&$('f_collateral_pdf').files[0];
  if(!f){setSt('st_collateral','off','PDF를 업로드하십시오');return}

  setSt('st_collateral','run','평가 중… (물건지 감지 · 실거래가 조회)');
  $('btn_collateral_report').disabled=true;
  $('collateral_flag').innerHTML='';

  const fd=new FormData();
  fd.append('pdf',f);
  fd.append('hammer_rate',(Number($('i_collateral_rate').value)||80)/100);

  try{
    const res=await fetch(API_BASE+'/api/collateral/evaluate',{method:'POST',body:fd});
    if(!res.ok)throw new Error(await res.text());
    const data=await res.json();
    COLLATERAL_RESULT=data;
    renderCollateralResult(data);
    setSt('st_collateral','on','평가 완료 · 물건지 '+(data.properties||[]).length+'개');
    $('btn_collateral_report').disabled=false;
    markDone(0,true);
  }catch(err){
    setSt('st_collateral','off','평가 실패');
    $('collateral_flag').innerHTML='<div class="callout callout--warn"><b>담보가치 평가 실패.</b> '+
      (err&&err.message?err.message:'백엔드 API('+API_BASE+') 연결을 확인하십시오')+'</div>';
    markDone(0,false);
  }
}

async function downloadCollateralReport(){
  if(!COLLATERAL_RESULT)return;
  try{
    const res=await fetch(API_BASE+'/api/collateral/report',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(COLLATERAL_RESULT)
    });
    if(!res.ok)throw new Error(await res.text());
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='담보가치_리포트.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }catch(err){
    $('collateral_flag').innerHTML='<div class="callout callout--warn"><b>리포트 생성 실패.</b> '+
      (err&&err.message?err.message:'')+'</div>';
  }
}

if($('btn_collateral_eval'))$('btn_collateral_eval').addEventListener('click',evaluateCollateral);
if($('btn_collateral_report'))$('btn_collateral_report').addEventListener('click',downloadCollateralReport);

if(!load())seed();

/* ── STEP 2 : 타설계획 (월별 칸은 백만원 단위 입력) ──
   타설기간(시작~종료 연월)으로 실제 개월 수만큼 월 컬럼을 동적 생성한다.
   각 월 컬럼은 실제 연월 문자열("YYYY-MM")을 키로 써서, 기간을 나중에 바꿔도
   이미 입력한 값이 해당 달에 그대로 남아있도록 한다(순서 인덱스가 아니라 연월로 매칭). */
function getMonthList(){
  const start=$('i_ts_start').value, end=$('i_ts_end').value;
  const validStart=/^\d{4}-\d{2}$/.test(start||'');
  if(!validStart){
    // 타설기간 미입력: 자리표시자 9칸
    return Array.from({length:9},(_,i)=>({key:'x'+i,label:'00월',days:30}));
  }
  let [sy,sm]=start.split('-').map(Number);
  let count=9;
  if(/^\d{4}-\d{2}$/.test(end||'')){
    const [ey,em]=end.split('-').map(Number);
    const diff=(ey-sy)*12+(em-sm)+1;
    if(diff>=1)count=Math.min(diff,36); // 폭주 방지용 상한
  }
  const list=[]; let y=sy,m=sm;
  for(let i=0;i<count;i++){
    list.push({key:y+'-'+String(m).padStart(2,'0'),label:y+'.'+String(m).padStart(2,'0'),days:new Date(y,m,0).getDate()});
    m++; if(m>12){m=1;y++;}
  }
  return list;
}
function renderTSHead(){
  const months=getMonthList();
  $('ts_thead_row').innerHTML='<th>현장명</th>'+
    months.map(m=>'<th class="num">'+m.label+'</th>').join('')+
    '<th>비고</th><th class="num">합계(㎥)</th><th class="num">매출채권(원)</th><th></th>';
}
function rebuildTSRows(){
  // 기존 행 값을 연월 키로 보존한 채, 바뀐 기간에 맞춰 표를 다시 그린다.
  const old=[...$('ts_tbl').querySelectorAll('tbody tr')].map(tr=>{
    const vals={}; tr.querySelectorAll('.ts-m').forEach(inp=>{vals[inp.dataset.ym]=inp.value});
    return {site:tr.querySelector('.ts-site').value,note:tr.querySelector('.ts-note').value,vals};
  });
  $('ts_tbl').querySelector('tbody').innerHTML='';
  const months=getMonthList();
  old.forEach(r=>{
    const d={site:r.site,note:r.note};
    months.forEach(m=>{if(r.vals[m.key])d[m.key]=r.vals[m.key]});
    tsRow(d);
  });
}
function tsRow(d){
  d=d||{};
  const months=getMonthList();
  const tr=document.createElement('tr');
  const monthTds=months.map(m=>
    '<td class="num">'+
      '<input type="text" class="ts-m input input--num input--tight" data-ym="'+m.key+'" value="'+esc(d[m.key]||'')+'">'+
      '<div class="ts-m-amt ts-derived">—</div>'+
      '<div class="ts-m-loan ts-derived ts-derived--loan">—</div>'+
    '</td>').join('');
  tr.innerHTML='<td><input type="text" class="ts-site input input--tight" value="'+esc(d.site||'')+'" placeholder="현장명">'+
      '<div class="ts-legend"><span>매출채권</span><span class="is-loan">월중여신</span></div></td>'+
    monthTds+
    '<td><input type="text" class="ts-note input input--tight" value="'+esc(d.note||'')+'"></td>'+
    '<td class="num ts-sum">—</td>'+
    '<td class="num ts-amt">—</td>'+
    '<td><button type="button" class="btn btn--sm ts-del">삭제</button></td>';
  tr.querySelector('.ts-del').addEventListener('click',()=>{tr.remove();calcTS();save()});
  tr.querySelectorAll('input').forEach(el=>el.addEventListener('input',()=>{calcTS();save()}));
  $('ts_tbl').querySelector('tbody').appendChild(tr);
  return tr;
}
function calcTS(){
  const months=getMonthList();

  // 기준단가 = 단가표[슬럼프][강도] (100% 단가), 적용단가 = 기준단가 x 할인율
  const slump=$('i_ts_slump').value, strength=$('i_ts_strength').value;
  const basePrice=(TS_PRICE_TABLE[slump]&&TS_PRICE_TABLE[slump][strength])||0;
  $('o_ts_baseprice').value=basePrice?basePrice.toLocaleString('ko-KR'):'';
  const discountRaw=num($('i_ts_discount').value);
  const discount=discountRaw==null?100:discountRaw;
  const price=Math.floor(basePrice*(discount/100)/100)*100; // 백원 단위만 남기고 절사
  $('o_ts_price').value=price?price.toLocaleString('ko-KR'):'';
  const days=num($('i_ts_days').value); // 대금결제조건 경과일수 (월말청구 + N일 현금)

  let globalPeakLoan=0; // 전 현장 통틀어 가장 높은 월중여신 (신청여신 산출 기준)
  [...$('ts_tbl').querySelectorAll('tbody tr')].forEach(tr=>{
    let sum=0;
    const amtByYm={};
    tr.querySelectorAll('.ts-m').forEach(inp=>{
      const v=num(inp.value)||0; // ㎥
      const ym=inp.dataset.ym;
      sum+=v;
      // 월별 매출채권 = 그 달 타설량 x 적용단가 (칸 아래에 바로 표시)
      const monthAmt=v*price;
      amtByYm[ym]=monthAmt;
      const amtEl=inp.parentElement.querySelector('.ts-m-amt');
      if(amtEl)amtEl.textContent=v?W(monthAmt):'—';
    });
    tr.querySelector('.ts-sum').textContent=sum?W(sum):'—';
    tr.querySelector('.ts-amt').textContent=sum?W(sum*price):'—';

    // 월중여신(그 달) = 그 달을 포함해 최근 N개월치 매출채권의 합
    // (달력상 정확한 날짜 계산 대신 "개월 수" 고정폭으로 계산 — 31일짜리 달 때문에
    //  회수일이 다다음달로 밀려 어쩌다 3개월치가 겹치는 등의 캘린더 흔들림을 없앤다.
    //  예) 30일 조건이면 항상 최근 2개월치, 60일이면 항상 최근 3개월치)
    if(days!=null){
      const windowSize=Math.ceil(days/30)+1; // 30일→2개월, 60일→3개월
      const rowLoanByYm={};
      months.forEach((m,i)=>{
        let loanSum=0;
        for(let j=Math.max(0,i-windowSize+1);j<=i;j++){
          loanSum+=amtByYm[months[j].key]||0;
        }
        rowLoanByYm[m.key]=loanSum;
      });
      // 그 현장의 최고 월중여신 달을 진한 빨간색으로 강조
      let peakYm=null,peakVal=0;
      Object.keys(rowLoanByYm).forEach(ym=>{if(rowLoanByYm[ym]>peakVal){peakVal=rowLoanByYm[ym];peakYm=ym}});
      if(peakVal>globalPeakLoan)globalPeakLoan=peakVal;
      months.forEach(m=>{
        const inp=tr.querySelector('.ts-m[data-ym="'+m.key+'"]');
        const loanEl=inp&&inp.parentElement.querySelector('.ts-m-loan');
        if(!loanEl)return;
        const v=rowLoanByYm[m.key];
        loanEl.textContent=v?W(v):'—';
        const isPeak=peakYm&&m.key===peakYm&&peakVal>0;
        loanEl.classList.toggle('ts-derived--peak',!!isPeak);
      });
    } else {
      tr.querySelectorAll('.ts-m-loan').forEach(el=>el.textContent='—');
    }
  });

  // 신청여신 = (전 현장 최고 월중여신 + 선택한 단위)를 천만원 단위로 절사
  // 예: 피크 157,800,000 + 1억원 = 257,800,000 -> 천만원 절사 -> 250,000,000(2억5천)
  const applyUnit=num($('i_ts_roundunit').value)||50000000;
  const applyLoan=globalPeakLoan?Math.floor((globalPeakLoan+applyUnit)/10000000)*10000000:0;
  $('o_ts_apply').textContent=applyLoan?formatEok(applyLoan):'—';

  $('ts_paycond_display').textContent=days!=null?('[대금결제조건 : 월말청구 '+days+'일 현금]'):'[대금결제조건 : 월말청구 OO일 현금]';

  let f='';
  if(days==null)
    f+='<div class="callout callout--warn"><b>여신 경과일수가 입력되지 않았습니다.</b> 대금결제조건의 일수를 입력하십시오.</div>';
  if(!basePrice)
    f+='<div class="callout callout--warn"><b>단가표에서 해당 강도·슬럼프 조합을 찾지 못했습니다.</b> 다른 값을 선택하십시오.</div>';
  $('ts_flag').innerHTML=f;
}
function buildTSPrintHTML(){
  const months=getMonthList();
  const strength=$('i_ts_strength').value, slump=$('i_ts_slump').value;
  const price=$('o_ts_price').value||'—';
  const discount=$('i_ts_discount').value||'100';
  const days=$('i_ts_days').value;
  const unitLabel={'10000000':'천만원','50000000':'5천만원','100000000':'1억원'}[$('i_ts_roundunit').value]||'';
  const today=new Date().toISOString().slice(0,10);

  const monthHead=months.map(m=>'<th>'+m.label+'</th>').join('');
  const rowsHtml=[...$('ts_tbl').querySelectorAll('tbody tr')].map(tr=>{
    const site=tr.querySelector('.ts-site').value||'—';
    const note=tr.querySelector('.ts-note').value||'';
    const sum=tr.querySelector('.ts-sum').textContent;
    const amt=tr.querySelector('.ts-amt').textContent;
    const vols=[],amts=[],loans=[];
    months.forEach(m=>{
      const inp=tr.querySelector('.ts-m[data-ym="'+m.key+'"]');
      const amtEl=inp&&inp.parentElement.querySelector('.ts-m-amt');
      const loanEl=inp&&inp.parentElement.querySelector('.ts-m-loan');
      const loanColor=loanEl&&loanEl.classList.contains('ts-derived--peak')?'#a4241a':'#333';
      vols.push('<td>'+(inp&&inp.value?inp.value+'㎥':'—')+'</td>');
      amts.push('<td>'+(amtEl?amtEl.textContent:'—')+'</td>');
      loans.push('<td style="color:'+loanColor+'">'+(loanEl?loanEl.textContent:'—')+'</td>');
    });
    const sumLabel=sum==='—'?sum:sum+'㎥';
    const amtLabel=amt==='—'?amt:amt+'원';
    return ''+
      '<tr><td class="pr-site" rowspan="3">'+site+'</td><td class="pr-rowlabel">타설량(㎥)</td>'+vols.join('')+
        '<td rowspan="3">'+(note||'—')+'</td><td>'+sumLabel+'</td></tr>'+
      '<tr><td class="pr-rowlabel">매출채권(원)</td>'+amts.join('')+'<td>'+amtLabel+'</td></tr>'+
      '<tr><td class="pr-rowlabel pr-loan">월중여신(원)</td>'+loans.join('')+'<td></td></tr>';
  }).join('');

  return ''+
    '<h1>타설계획 보고서</h1>'+
    '<p class="pr-sub">작성일: '+today+'</p>'+
    '<p class="pr-cond">'+
      '타설기간: '+($('i_ts_start').value||'—')+' ~ '+($('i_ts_end').value||'미지정')+'<br>'+
      '대금결제조건: 월말청구 '+(days||'—')+'일 현금<br>'+
      '단가: 호칭강도 '+strength+'MPa · 슬럼프 '+slump+'mm · 기준단가 '+$('o_ts_baseprice').value+'원 · 할인율 '+discount+'% · 적용단가 '+price+'원'+
    '</p>'+
    '<table><thead><tr>'+
      '<th>현장명</th><th>구분</th>'+monthHead+'<th>비고</th><th>합계</th>'+
    '</tr></thead><tbody>'+rowsHtml+'</tbody></table>'+
    '<p class="pr-total">신청여신 ('+unitLabel+' 절상): '+$('o_ts_apply').textContent+'</p>';
}
function printTS(){
  $('ts_print_area').innerHTML=buildTSPrintHTML();
  window.print();
}
$('btn_ts_pdf').addEventListener('click',printTS);
$('btn_add_ts').addEventListener('click',()=>{tsRow();calcTS();save()});
$('btn_reset_ts').addEventListener('click',resetAll);
['i_ts_start','i_ts_end'].forEach(id=>{
  $(id).addEventListener('input',()=>{renderTSHead();rebuildTSRows();calcTS();save()});
});
['i_ts_days','i_ts_strength','i_ts_slump','i_ts_discount','i_ts_roundunit'].forEach(id=>{
  $(id).addEventListener('input',()=>{calcTS();save()});
  $(id).addEventListener('change',()=>{calcTS();save()});
});
renderTSHead(); calcTS();

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
