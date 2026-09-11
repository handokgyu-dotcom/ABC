# -*- coding: utf-8 -*-
"""
등기부등본 분석 공통 로직
- 페이지 렌더링
- 페이지 자동 분류 (표제부/갑구/을구, 물건지 구분)
- 을구 근저당권 추출 (Gemini Vision)
- 부기등기 추적 및 선순위 계산
"""
import json
import re
import time
import pymupdf
from PIL import Image
from io import BytesIO

MODEL_NAME = "gemini-3.5-flash-lite"
CLASSIFY_BATCH_SIZE = 15  # 한 번에 분류할 페이지 수


def render_pdf_page(pdf_bytes_or_path, page_idx, dpi=200):
    """PDF 페이지를 PIL 이미지로 렌더링. bytes 또는 파일경로 모두 지원"""
    if isinstance(pdf_bytes_or_path, (bytes, bytearray)):
        doc = pymupdf.open(stream=pdf_bytes_or_path, filetype="pdf")
    else:
        doc = pymupdf.open(pdf_bytes_or_path)

    if not 0 <= page_idx < doc.page_count:
        doc.close()
        raise ValueError(f"Invalid page index {page_idx} (total: {doc.page_count})")

    pix = doc[page_idx].get_pixmap(dpi=dpi)
    png_bytes = pix.tobytes("png")
    total_pages = doc.page_count
    doc.close()

    img = Image.open(BytesIO(png_bytes))
    return img, total_pages


def get_page_count(pdf_bytes_or_path):
    if isinstance(pdf_bytes_or_path, (bytes, bytearray)):
        doc = pymupdf.open(stream=pdf_bytes_or_path, filetype="pdf")
    else:
        doc = pymupdf.open(pdf_bytes_or_path)
    n = doc.page_count
    doc.close()
    return n


def _call_gemini_with_retry(client, content, max_retries=3, log=print):
    """공통 재시도 로직으로 Gemini 호출"""
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=content
            )
            return response.text
        except Exception as e:
            last_error = e
            log(f"[경고] 시도 {attempt}/{max_retries} 실패: {e}")
            if attempt < max_retries:
                time.sleep(attempt * 5)
    raise RuntimeError(f"Gemini 호출 실패 ({max_retries}회 시도): {last_error}")


def classify_pages(client, pdf_bytes_or_path, log=print):
    """
    전체 페이지를 훑으며 각 페이지의 섹션(표제부/갑구/을구)과
    물건지 식별자(고유번호), 주소를 분류한다.
    여러 물건지가 섞인 문서에서 물건지 경계를 찾기 위함.
    """
    total_pages = get_page_count(pdf_bytes_or_path)
    log(f"[분류] 전체 {total_pages}페이지 분류 시작")

    all_classifications = []
    last_unique_number = None
    last_address = None

    for batch_start in range(0, total_pages, CLASSIFY_BATCH_SIZE):
        batch_end = min(batch_start + CLASSIFY_BATCH_SIZE, total_pages)
        batch_pages = list(range(batch_start, batch_end))  # 0-indexed

        images = []
        for p in batch_pages:
            img, _ = render_pdf_page(pdf_bytes_or_path, p, dpi=100)  # 분류용은 저해상도로 충분
            images.append(img)

        log(f"[분류] 페이지 {batch_start+1}~{batch_end} 분석 중...")

        prompt = f"""다음은 등기부등본 PDF의 페이지 {batch_start+1}번부터 {batch_end}번까지입니다.
(하나의 파일에 여러 개의 서로 다른 부동산 등기부등본이 합쳐져 있을 수 있습니다)

**매우 중요**: 한 페이지 안에 표제부/갑구/을구 중 여러 섹션이 함께 들어있는 경우가 많습니다
(예: 페이지 하단에 표제부가 끝나고 갑구가 시작, 그 아래에 을구까지 이어지는 경우).
반드시 각 섹션이 그 페이지에 **조금이라도 보이면 true**로 표시하세요. 하나만 고르지 마세요.

각 페이지에 대해 다음을 판별하세요:
1. page: 페이지 번호 ({batch_start+1}부터 {batch_end}까지, 실제 순서대로)
2. has_pyojebu: 이 페이지에 "표제부" 테이블(건물의 표시)이 보이면 true
3. has_gapgu: 이 페이지에 "갑구" 테이블(소유권에 관한 사항)이 보이면 true
4. has_eulgu: 이 페이지에 "을구" 테이블(소유권 이외의 권리에 관한 사항, 근저당권 정보)이 보이면 true
5. unique_number: 고유번호 (표제부 상단 우측 바코드 옆, 예: "1615-1996-392221"). 이 페이지에 표제부가 없으면 null
6. address: 물건 소재지 주소 (표제부에 있음, 예: "충청남도 천안시 동남구 청수동 183 극동아파트 201동 802호"). 없으면 null
7. area_sqm: "전유부분의 건물의 표시" 표에 있는 해당 호실의 전용면적 (단위: ㎡, 숫자만).
   예: "철근콘크리트구조 84.9754㎡" → 84.9754
   주의: "1동의 건물의 표시"(건물 전체 면적, 여러 층 면적 나열된 것)가 아니라
   반드시 "전유부분의 건물의 표시"에 있는 해당 호실 하나의 면적만 추출. 없으면 null

**중요**: 새로운 부동산 등기부등본이 시작되면 새로운 고유번호가 나타납니다. 이를 기준으로 물건지를 구분할 것입니다.

JSON 배열로만 응답하세요 (다른 설명 없이):
[
  {{"page": {batch_start+1}, "has_pyojebu": true, "has_gapgu": false, "has_eulgu": false, "unique_number": "1615-1996-392221", "address": "충청남도 천안시...", "area_sqm": 84.9754}},
  {{"page": {batch_start+2}, "has_pyojebu": false, "has_gapgu": true, "has_eulgu": true, "unique_number": null, "address": null, "area_sqm": null}}
]"""

        content = [prompt] + images
        result_text = _call_gemini_with_retry(client, content, log=log)

        json_match = re.search(r'\[.*\]', result_text, re.DOTALL)
        if json_match:
            batch_result = json.loads(json_match.group())
            all_classifications.extend(batch_result)
        else:
            log(f"[경고] 배치 {batch_start+1}~{batch_end} JSON 파싱 실패")

    # 정렬 및 정리
    all_classifications.sort(key=lambda x: x.get("page", 0))
    log(f"[분류] 완료: {len(all_classifications)}개 페이지 분류됨")
    return all_classifications


def group_properties(classifications, log=print):
    """
    페이지 분류 결과를 바탕으로 물건지(고유번호)별로 그룹화.
    고유번호가 없는 연속 페이지는 이전 물건지에 속하는 것으로 간주 (부기 페이지).
    """
    log(f"\n[그룹화] 물건지별 페이지 그룹화 시작")

    properties = []  # [{unique_number, address, pages: [...], eulgu_pages: [...]}]
    current_unique = None
    current_address = None

    for item in classifications:
        page = item.get("page")
        has_pyojebu = item.get("has_pyojebu", False)
        has_eulgu = item.get("has_eulgu", False)
        unique_number = item.get("unique_number")
        address = item.get("address")
        area_sqm = item.get("area_sqm")

        # 새 고유번호가 나타나면 새 물건지 시작
        if unique_number and unique_number != current_unique:
            current_unique = unique_number
            current_address = address or current_address
            properties.append({
                "unique_number": current_unique,
                "address": current_address,
                "area_sqm": None,
                "pages": [],
                "eulgu_pages": []
            })
            log(f"  [새 물건지] 고유번호: {current_unique}, 주소: {current_address}")

        if not properties:
            # 첫 페이지부터 고유번호가 없는 경우 대비 (표지/주문서 등)
            properties.append({
                "unique_number": "UNKNOWN",
                "address": None,
                "area_sqm": None,
                "pages": [],
                "eulgu_pages": []
            })

        properties[-1]["pages"].append(page)
        if has_eulgu:
            properties[-1]["eulgu_pages"].append(page)
        if address and not properties[-1]["address"]:
            properties[-1]["address"] = address
        if area_sqm and not properties[-1]["area_sqm"]:
            try:
                properties[-1]["area_sqm"] = float(area_sqm)
            except (ValueError, TypeError):
                pass

    # 을구 페이지가 없는 빈 물건지(표지/주문서 등)는 제외
    properties = [p for p in properties if p["eulgu_pages"]]

    log(f"[그룹화] 완료: {len(properties)}개 물건지 발견 (을구 없는 그룹 제외)")
    for i, prop in enumerate(properties, 1):
        log(f"  물건지 {i}: {prop['address']} (전용면적: {prop.get('area_sqm')}㎡, 을구 페이지: {prop['eulgu_pages']})")

    return properties


EXTRACTION_PROMPT = """다음은 한국 등기부등본의 【을구】(소유권 이외의 권리에 관한 사항) 섹션입니다.

### 1단계: 항목 유형 분류
**기본 근저당권 (독립적 항목):**
- "근저당권설정" (최초 등기)
- "근저당권이전" (채권자 변경)
- "근저당권변경" (금액 변경)

**부기등기 (다른 항목을 수정):**
- "O번근저당권설정등기말소" → O번 항목 취소
- "O번근저당권이전" → O번 항목 수정
→ 부기등기는 채권최고액이 없거나 "-" 처리됨

### 2단계: 정보 추출
1. 순위번호: 1, 2, 3... (단순 숫자만)
2. 채권최고액:
   - 숫자가 있으면 그 숫자 (예: 36400000)
   - "-" 이거나 없으면 0 (부기등기)
   - 취소선이 그어져 있으면 0
3. 상태:
   - 행의 텍스트 위에 빨간색 또는 검은색 취소선이 있으면 "말소"
   - "말소" 텍스트가 있으면 "말소"
   - 그 외 "유효"
4. 등기목적: 정확히 표기된 대로
5. is_subsidiary: "O번근저당권" 텍스트가 있으면 true

### 3단계: JSON 응답 형식 (다른 설명 없이 JSON만 출력)
{
  "mortgages": [
    {"priority": "1", "amount": 36400000, "status": "유효", "purpose": "근저당권설정", "is_subsidiary": false},
    {"priority": "2", "amount": 0, "status": "말소", "purpose": "1번근저당권설정등기말소", "is_subsidiary": true}
  ],
  "validation_notes": "각 항목별 상세 설명"
}

### 부기등기 금액 처리 (중요!)
- "O번근저당권설정등기말소" 부기등기: amount는 0
- "O번근저당권변경" 부기등기: 그 행에 새로운 채권최고액이 적혀있으면 **그 새 금액을 amount에 넣기** (0 아님!)
  예: "4번근저당권변경" 행에 "채권최고액 금48,600,000원"이 적혀있으면 amount: 48600000
- "O번근저당권이전" 부기등기: amount는 0 (채권자만 바뀜, 금액 변경 없음)

### 매우 중요:
- 부기등기(is_subsidiary=true)는 기본 근저당권과 분리
- 취소선 또는 "말소" 텍스트 있으면 반드시 "말소" 표시
- JSON만 출력, 다른 텍스트 없이"""


def extract_eulgu_data_with_gemini(client, pdf_bytes_or_path, page_numbers, log=print):
    """Gemini Vision을 사용해 을구 데이터 추출 (고해상도)"""
    images = []
    for page_num in page_numbers:
        try:
            img, _ = render_pdf_page(pdf_bytes_or_path, page_num - 1, dpi=200)
            images.append(img)
        except Exception as e:
            log(f"[경고] 페이지 {page_num} 처리 불가: {e}")
            continue

    if not images:
        raise RuntimeError("렌더링된 이미지가 없습니다")

    content = [EXTRACTION_PROMPT] + images
    result_text = _call_gemini_with_retry(client, content, log=log)

    json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
    if json_match:
        extracted = json.loads(json_match.group())
        log(f"[추출성공] {len(extracted.get('mortgages', []))}개 근저당권")
        return extracted
    else:
        log(f"[경고] JSON을 찾을 수 없음")
        return {"raw_response": result_text, "error": "JSON parsing failed"}


def track_subsidiary_registrations(mortgages, log=print):
    """부기등기를 추적하여 최종 상태 결정"""
    basic_mortgages = {}
    subsidiary_regs = []

    for m in mortgages:
        priority = str(m.get("priority", "")).strip()
        is_subsidiary = m.get("is_subsidiary", False)

        if is_subsidiary:
            subsidiary_regs.append({
                "priority": priority,
                "type": m.get("purpose", ""),
                "status": m.get("status", ""),
                "amount": m.get("amount", 0),
            })
        else:
            base_num = priority.split('-')[0]
            if base_num not in basic_mortgages:
                basic_mortgages[base_num] = []
            basic_mortgages[base_num].append(m)

    for sub_reg in subsidiary_regs:
        purpose = sub_reg["type"]
        match = re.search(r'(\d+)번', purpose)
        if match:
            target_num = match.group(1)
            if target_num in basic_mortgages:
                basic_mortgages[target_num].append({
                    "priority": f"({sub_reg['priority']})",
                    "amount": sub_reg.get("amount", 0),
                    "status": sub_reg["status"],
                    "purpose": f"부기등기({sub_reg['type']})",
                    "is_change": "변경" in sub_reg["type"],
                    "is_auxiliary": True
                })

    final_mortgages = {}
    for base_num, entries in basic_mortgages.items():
        final_status = "유효"
        final_amount = 0
        final_purpose = ""

        # 기본 항목 먼저 처리
        for entry in entries:
            if not entry.get("is_auxiliary", False):
                final_amount = int(entry.get("amount", 0))
                final_purpose = entry.get("purpose", "")
                if entry.get("status") == "말소":
                    final_status = "말소"

        # 부기등기를 순서대로 적용 (변경은 금액 갱신, 말소는 상태 갱신)
        for entry in entries:
            if entry.get("is_auxiliary"):
                if entry.get("is_change") and int(entry.get("amount", 0)) > 0:
                    final_amount = int(entry.get("amount", 0))
                    final_purpose = entry.get("purpose", final_purpose)
                if entry.get("status") == "말소":
                    final_status = "말소"

        final_mortgages[base_num] = {
            "priority": base_num,
            "amount": final_amount if final_status == "유효" else 0,
            "status": final_status,
            "purpose": final_purpose,
            "entries_count": len(entries)
        }

    return final_mortgages


def calculate_priority_sum(eulgu_data, log=print):
    """유효한 근저당권의 채권최고액 합계 계산"""
    raw_mortgages = eulgu_data.get("mortgages", [])
    final_mortgages = track_subsidiary_registrations(raw_mortgages, log=log)

    valid = []
    total = 0

    for mortgage in final_mortgages.values():
        status = mortgage.get("status", "").strip()
        if status == "유효":
            try:
                amount = int(mortgage.get("amount", 0))
                valid.append(mortgage)
                total += amount
            except (ValueError, TypeError):
                pass

    return {
        "valid_mortgages": valid,
        "total_priority_amount": total,
        "total_mortgages": len(final_mortgages),
        "cancelled_mortgages": len(final_mortgages) - len(valid),
        "all_mortgages": final_mortgages
    }


def process_all_properties(client, pdf_bytes_or_path, log=print):
    """
    문서 전체를 자동 분석: 물건지 개수와 상관없이
    자동으로 감지하여 각각 선순위를 계산.
    """
    classifications = classify_pages(client, pdf_bytes_or_path, log=log)
    properties = group_properties(classifications, log=log)

    results = []
    grand_total = 0

    for i, prop in enumerate(properties, 1):
        log(f"\n{'='*50}")
        log(f"[물건지 {i}/{len(properties)}] {prop['address']}")
        log(f"{'='*50}")

        if not prop["eulgu_pages"]:
            log(f"  [경고] 을구 페이지를 찾지 못했습니다")
            results.append({
                "property_index": i,
                "address": prop["address"],
                "unique_number": prop["unique_number"],
                "area_sqm": prop.get("area_sqm"),
                "eulgu_pages": [],
                "error": "을구 페이지 없음",
                "total_priority_amount": 0
            })
            continue

        eulgu_data = extract_eulgu_data_with_gemini(
            client, pdf_bytes_or_path, prop["eulgu_pages"], log=log
        )
        calc_result = calculate_priority_sum(eulgu_data, log=log)

        grand_total += calc_result["total_priority_amount"]

        results.append({
            "property_index": i,
            "address": prop["address"],
            "unique_number": prop["unique_number"],
            "area_sqm": prop.get("area_sqm"),
            "eulgu_pages": prop["eulgu_pages"],
            "raw_eulgu_data": eulgu_data,
            **calc_result
        })

        log(f"  선순위: {calc_result['total_priority_amount']:,}원")

    return {
        "total_properties": len(properties),
        "properties": results,
        "grand_total_priority": grand_total
    }
