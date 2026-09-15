/* ══════════════════════════════════════════════════════════════
   collateral.js — 연대보증 심사 (담보가치 평가)

   등기부등본 PDF 를 streamlit-app 백엔드에 올려 물건지별 선순위·
   실거래가·담보가치를 받아 표로 보여준다. 계산은 전부 백엔드 몫이고
   이 파일은 표시만 한다.

   원래 remicon 워크플로의 STEP 01 이었다. 타설계획·현장 현황이
   각자 독립 화면으로 갈라지면서 이 페이지에는 이것만 남았다.
   ══════════════════════════════════════════════════════════════ */
(function(){
const {$, el, esc, fmtInt: W, fmtEok: formatEok, parseNum: num, setStatus, storage} = App;
const setSt=(id,state,txt)=>setStatus(id,state,txt);

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
  }catch(err){
    setSt('st_collateral','off','평가 실패');
    $('collateral_flag').innerHTML='<div class="callout callout--warn"><b>담보가치 평가 실패.</b> '+
      (err&&err.message?err.message:'백엔드 API('+API_BASE+') 연결을 확인하십시오')+'</div>';
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
})();
