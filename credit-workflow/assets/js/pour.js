/* ══════════════════════════════════════════════════════════════
   pour.js — 타설계획

   현장별 월간 타설량으로 매출채권·월중여신·신청여신을 산출한다.
   단가표와 계산식은 분리 전과 완전히 동일하다.

   저장 키는 페이지별로 분리했다(예전에는 현장 현황과 한 덩어리로
   yeosin.v4 에 같이 들어가 있었다).
   ══════════════════════════════════════════════════════════════ */
(function(){
const BUILD='2026-09-15.1';
const KEY='yeosin.pour.v1';
const {$, el, esc, fmtInt: W, fmtEok: formatEok, parseNum: num, setStatus, storage} = App;
const setSt=(id,state,txt)=>setStatus(id,state,txt);

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

/* ── 로컬 임시저장 (이 브라우저에만) ── */
const IDS=['i_ts_start','i_ts_end','i_ts_days','i_ts_strength','i_ts_slump','i_ts_discount','i_ts_roundunit'];
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
  storage.remove(KEY,'yeosin.v1','yeosin.v3','yeosin.v4');
  location.reload();
}

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
    '<th class="ts-note-col">비고</th><th class="num">합계(㎥)</th><th class="num">매출채권(원)</th><th></th>';
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
    '<td class="ts-note-col"><input type="text" class="ts-note input input--tight" value="'+esc(d.note||'')+'"></td>'+
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
/* 초기화: 저장분이 있으면 복원하고, 없으면 예시 한 줄로 시작한다.
   load()/seed() 둘 다 내부에서 renderTSHead() 를 부르므로 여기서는 계산만 돌린다. */
if(!load())seed();
calcTS();
})();
