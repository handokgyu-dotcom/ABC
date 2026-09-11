# -*- coding: utf-8 -*-
"""
등기부등본 -> 담보가치 자동 계산 통합 파이프라인

1. 등기부등본 업로드 -> 물건지 자동 감지 (몇 개든)
2. 각 물건지의 선순위(유효 근저당권 합계) 계산 (Gemini Vision)
3. 각 물건지 주소로 최근 실거래가 자동 조회 (호갱노노)
4. 담보가치 = 실거래가 x 낙찰가율 - 선순위
"""
import sys
import os
import re
import json
import time
from pathlib import Path

import registry_core as core
import hogangnono_lookup as hgnn
import rtms_lookup as rtms


def extract_building_dong(address):
    """
    등기부 주소에서 '동(棟)' 번호를 추출한다 (예: "...극동아파트 201동 802호" -> "201").

    행정동(예: "청수동")은 숫자 없이 한글로만 끝나므로, 숫자 뒤에 바로 "동"이 붙는
    패턴만 매칭하면 건물 동 번호만 정확히 골라낼 수 있다.
    """
    if not address:
        return None
    m = re.search(r"(\d+)\s*동(?:\s|$)", address)
    return m.group(1) if m else None

# 참고: 이 모듈은 CLI(`python full_pipeline.py ...`)와 API 서버(api_server.py) 양쪽에서
# import 되므로, import 시점에 프로세스를 종료시키거나(sys.exit) 전역 API 클라이언트를
# 만드는 부수효과를 두지 않는다. genai.Client는 호출자(streamlit_app.py / api_server.py)가
# 각자의 API 키로 매 요청마다 생성해 process_full_pipeline() 내부의 core.process_all_properties()에
# 전달하지 않고, 아래처럼 이 모듈이 직접 필요로 하는 곳(없음)에서만 사용한다.

# 기본 낙찰가율 (기준표에 매칭되는 지역이 없을 때 사용)
DEFAULT_HAMMER_RATE = 0.80


def load_rate_table(file_bytes_or_path, filename_hint=""):
    """
    낙찰가율 기준표 업로드 파일(csv/xlsx)을 파싱.

    기대하는 컬럼 (이름은 유연하게 매칭):
    - 지역 (시/군/구 등 주소에 포함될 키워드)
    - 낙찰가율 (0.8 또는 80 형태 모두 허용)

    Returns:
        [{"region": "천안시 동남구", "rate": 0.8}, ...]  (구체적인 지역이 먼저 오도록 정렬)
    """
    import pandas as pd
    import io as _io

    if isinstance(file_bytes_or_path, (bytes, bytearray)):
        buf = _io.BytesIO(file_bytes_or_path)
        if filename_hint.lower().endswith(".csv"):
            df = pd.read_csv(buf)
        else:
            df = pd.read_excel(buf)
    else:
        path = str(file_bytes_or_path)
        if path.lower().endswith(".csv"):
            df = pd.read_csv(path)
        else:
            df = pd.read_excel(path)

    # 컬럼명 유연 매칭
    region_col = None
    rate_col = None
    for col in df.columns:
        col_str = str(col).strip()
        if region_col is None and any(k in col_str for k in ["지역", "시군구", "주소", "지자체"]):
            region_col = col
        if rate_col is None and any(k in col_str for k in ["낙찰가율", "낙찰율", "요율", "비율"]):
            rate_col = col

    if region_col is None or rate_col is None:
        # 못 찾으면 첫 두 컬럼을 순서대로 지역/낙찰가율로 가정
        cols = list(df.columns)
        region_col = region_col or cols[0]
        rate_col = rate_col or cols[1]

    table = []
    for _, row in df.iterrows():
        region = str(row[region_col]).strip()
        rate_raw = row[rate_col]
        try:
            rate = float(rate_raw)
        except (ValueError, TypeError):
            continue
        if rate > 1:  # 80 형태로 입력된 경우 0.8로 변환
            rate = rate / 100
        if region and region.lower() != "nan":
            table.append({"region": region, "rate": rate})

    # 더 구체적인(긴) 지역명이 먼저 매칭되도록 길이 내림차순 정렬
    table.sort(key=lambda x: len(x["region"]), reverse=True)
    return table


def load_court_rate_table(file_bytes_or_path, filename_hint="", property_type="아파트"):
    """
    법원 관할구역별 + 부동산 유형별 낙찰가율표 파싱
    (예: "2024년 지역별 경매 낙찰가률" 형식 - 구분/관할법원/지역/아파트/단독/... 컬럼)

    '지역' 컬럼은 다음과 같은 다양한 표기를 포함:
    - 단순 콤마 목록: "종로, 중구, 강남, 서초"
    - 괄호 포함: "대구(남구,북구,동구,수성,중구)경산,영천,칠곡,청도"

    Args:
        property_type: 요율을 가져올 부동산 유형 컬럼명 (기본 "아파트")

    Returns:
        [{"region": "천안", "rate": 0.8, "court": "천안지원"}, ...]
        (구체적인 키워드가 먼저 오도록 길이 내림차순 정렬)
    """
    import pandas as pd
    import io as _io
    import re

    if isinstance(file_bytes_or_path, (bytes, bytearray)):
        buf = _io.BytesIO(file_bytes_or_path)
        if filename_hint.lower().endswith(".csv"):
            df = pd.read_csv(buf, header=None)
        else:
            df = pd.read_excel(buf, header=None)
    else:
        path = str(file_bytes_or_path)
        if path.lower().endswith(".csv"):
            df = pd.read_csv(path, header=None)
        else:
            df = pd.read_excel(path, header=None)

    # 헤더 행 찾기: "관할법원" 셀이 정확히 있는 행 (제목 행의 "지역별" 같은 부분 문자열 오탐 방지)
    header_row_idx = None
    for i in range(min(10, len(df))):
        row_values = [str(v).strip() for v in df.iloc[i].tolist()]
        if any(v == "관할법원" for v in row_values):
            header_row_idx = i
            break

    if header_row_idx is None:
        raise ValueError("이 파일은 예상한 '법원별 낙찰가율표' 형식이 아닙니다 (헤더를 찾지 못함)")

    headers = [str(v).replace("\n", "").strip() for v in df.iloc[header_row_idx].tolist()]

    # 컬럼 인덱스 파악
    court_col = next((i for i, h in enumerate(headers) if "관할법원" in h), 1)
    region_col = next((i for i, h in enumerate(headers) if h == "지역"), 2)
    type_col = next((i for i, h in enumerate(headers) if property_type in h), None)

    if type_col is None:
        raise ValueError(f"'{property_type}' 컬럼을 찾지 못했습니다. 사용 가능한 컬럼: {headers}")

    entries = []
    for i in range(header_row_idx + 1, len(df)):
        row = df.iloc[i]
        region_text = row[region_col]
        rate_val = row[type_col]

        if pd.isna(region_text) or pd.isna(rate_val):
            continue

        region_text = str(region_text).strip()
        try:
            rate = float(rate_val)
        except (ValueError, TypeError):
            continue
        if rate > 1:
            rate = rate / 100

        court = row[court_col] if court_col < len(row) and not pd.isna(row[court_col]) else ""
        court = str(court).strip()

        # 지역 텍스트에서 키워드 추출
        # 괄호 패턴 처리: "대구(남구,북구,동구,수성,중구)경산,영천,칠곡,청도"
        # -> "서구", "남구" 같은 구 이름은 여러 도시에 중복되므로, 도시명+구 이름을
        #    "함께 포함"하는지로 매칭 (단순 문자열 이어붙이기 X, keywords 목록으로 AND 매칭)
        paren_match = re.match(r'^(.*?)\((.*?)\)(.*)$', region_text)
        if paren_match:
            prefix, inner, suffix = paren_match.groups()
            prefix = prefix.strip().replace(" ", "")
            inner_items = [x.strip().replace(" ", "") for x in inner.split(",") if x.strip()]
            for item in inner_items:
                # 구체적: "대구"+"서구" 둘 다 주소에 있어야 매칭 (specificity 2)
                entries.append({"keywords": [prefix, item], "rate": rate, "court": court})
            if prefix:
                # 느슨한 fallback: 도시명만 일치해도 매칭 (specificity 1)
                entries.append({"keywords": [prefix], "rate": rate, "court": court})
            suffix_items = [x.strip().replace(" ", "") for x in suffix.split(",") if x.strip()]
            for item in suffix_items:
                entries.append({"keywords": [item], "rate": rate, "court": court})
        else:
            items = [x.strip().replace(" ", "") for x in region_text.split(",") if x.strip()]
            for item in items:
                entries.append({"keywords": [item], "rate": rate, "court": court})

    return entries


def match_hammer_rate(address, rate_table, default_rate=DEFAULT_HAMMER_RATE):
    """
    물건지 주소에 낙찰가율 기준표를 매칭.

    각 기준표 항목은 keywords 리스트(예: ["대구","서구"]) 또는 단일 region 문자열을 가진다.
    - keywords의 모든 항목이 주소에 포함되어야 매칭(AND 조건)
    - 여러 항목이 매칭되면: keywords 개수(specificity) > 총 글자수 순으로 가장 구체적인 것을 채택
      (예: "대구"+"서구" 둘 다 일치 > "대구"만 일치)
    """
    if not address or not rate_table:
        return default_rate, None

    address_normalized = address.replace(" ", "")
    candidates = []

    for entry in rate_table:
        keywords = entry.get("keywords")
        if keywords is None:
            keywords = [entry.get("region", "")]
        keywords = [k for k in keywords if k]
        if not keywords:
            continue
        if all(kw in address_normalized for kw in keywords):
            specificity = len(keywords)
            total_len = sum(len(k) for k in keywords)
            candidates.append((specificity, total_len, keywords, entry["rate"]))

    if not candidates:
        return default_rate, None

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    _, _, best_keywords, best_rate = candidates[0]
    return best_rate, "+".join(best_keywords)


def process_full_pipeline(pdf_path, client, hammer_rate=DEFAULT_HAMMER_RATE, rate_table=None, log=print):
    """
    등기부등본 -> 담보가치까지 전체 처리

    Args:
        client: google.genai.Client 인스턴스. 호출자가 요청 시점의 API 키로 생성해 전달한다
                (이 모듈은 더 이상 자체 client를 만들지 않는다).

    Returns:
        {
            "properties": [
                {
                    "address": ...,
                    "priority_amount": ...,      # 선순위
                    "market_price": ...,          # 최근 실거래가
                    "hammer_rate": ...,
                    "collateral_value": ...,      # 담보가치
                },
                ...
            ],
            "grand_total_collateral": ...
        }
    """
    # Step 1: 등기부등본 분석 (물건지 자동 감지 + 선순위 계산)
    log("=" * 70)
    log("[1단계] 등기부등본 분석 (물건지 자동 감지 + 선순위 계산)")
    log("=" * 70)
    registry_result = core.process_all_properties(client, pdf_path, log=log)

    final_properties = []
    grand_total_collateral = 0

    for prop in registry_result["properties"]:
        address = prop.get("address")
        area_sqm = prop.get("area_sqm")
        priority_amount = prop.get("total_priority_amount", 0)

        # 물건지 주소 기준 낙찰가율 매칭 (기준표 있으면 우선 적용, 없으면 기본값)
        applied_rate, matched_region = match_hammer_rate(address, rate_table, default_rate=hammer_rate)

        log("\n" + "=" * 70)
        log(f"[2단계] 실거래가 조회: {address}" + (f" (전용 {area_sqm}㎡)" if area_sqm else " (전용면적 정보 없음)"))
        log("=" * 70)
        if rate_table:
            if matched_region:
                log(f"  [낙찰가율 매칭] '{matched_region}' 기준 → {applied_rate*100:.0f}%")
            else:
                log(f"  [낙찰가율 매칭] 기준표에 일치하는 지역 없음 → 기본값 {applied_rate*100:.0f}% 적용")

        if not address:
            log("  [경고] 주소를 알 수 없어 실거래가 조회를 건너뜁니다")
            final_properties.append({
                **prop,
                "market_price": None,
                "hammer_rate": applied_rate,
                "collateral_value": None,
                "error": "주소 미상으로 시세 조회 불가"
            })
            continue

        try:
            market_result = hgnn.lookup_recent_price(address, target_area_sqm=area_sqm)
        except Exception as e:
            log(f"  [오류] 실거래가 조회 실패: {e}")
            final_properties.append({
                **prop,
                "market_price": None,
                "hammer_rate": applied_rate,
                "collateral_value": None,
                "error": f"실거래가 조회 실패: {e}"
            })
            continue

        if market_result.get("error"):
            log(f"  [경고] {market_result['error']}")
            final_properties.append({
                **prop,
                "market_price": None,
                "hammer_rate": applied_rate,
                "collateral_value": None,
                "error": market_result["error"]
            })
            continue

        hogangnono_price = market_result.get("average_price")
        matched_apt = market_result.get("matched_apt", {})

        log(f"  매칭된 단지: {matched_apt.get('name')} ({matched_apt.get('address')})")
        if market_result.get("area_filter_applied"):
            log(f"  [평형 매칭] 전용 {area_sqm}㎡ → {market_result.get('matched_area_type')}타입으로 필터링 완료")
        elif market_result.get("note"):
            log(f"  [경고] {market_result['note']}")
        log(f"  [호갱노노] 최근 실거래가 (평균): {hogangnono_price:,}원" if hogangnono_price else "  [호갱노노] 실거래가 없음")

        # 국토교통부 실거래가 공개시스템 (원천 데이터 · 주값)
        molit_price = None
        molit_result = None
        lawd_cd = matched_apt.get("lawd_cd")
        building_dong = extract_building_dong(address)
        if lawd_cd:
            try:
                molit_result = rtms.lookup_recent_price(
                    lawd_cd, matched_apt.get("name", ""), dong=building_dong,
                    area_sqm=area_sqm, months_back=3, log=log
                )
                if molit_result.get("error"):
                    log(f"  [국토부] {molit_result['error']}")
                else:
                    molit_price = molit_result.get("average_price")
                    log(f"  [국토부] 최근 실거래가 (평균): {molit_price:,}원 ({molit_result.get('trade_count')}건)"
                        + (f" · {building_dong}동 필터 적용" if building_dong else ""))
            except Exception as e:
                log(f"  [국토부] 조회 실패 (API 키 미설정 등): {e}")
        else:
            log("  [국토부] 법정동코드를 알 수 없어 조회 생략")

        # 국토부 실거래가(법정 신고 원천 데이터)를 주값으로 우선 사용하고,
        # 호갱노노는 참고/교차검증용으로만 쓴다. 국토부 조회가 안 될 때만 호갱노노로 대체.
        if molit_price:
            market_price = molit_price
            if hogangnono_price:
                diff_pct = abs(hogangnono_price - molit_price) / max(hogangnono_price, molit_price) * 100
                log(f"  [교차검증] 국토부 vs 호갱노노 차이: {diff_pct:.1f}%")
                if diff_pct > 15:
                    log(f"  [경고] 두 소스 간 차이가 큽니다({diff_pct:.1f}%) — 수동 확인 권장")
            log(f"  [최종 채택 시세] {market_price:,}원 (국토부 실거래가 기준)")
        elif hogangnono_price:
            market_price = hogangnono_price
            log("  [안내] 국토부 데이터 없어 호갱노노 데이터로 대체")
        else:
            market_price = None

        # Step 3: 담보가치 계산
        collateral_value = None
        if market_price:
            collateral_value = int(market_price * applied_rate) - priority_amount
            grand_total_collateral += collateral_value

        log("\n" + "=" * 70)
        log(f"[3단계] 담보가치 계산")
        log("=" * 70)
        log(f"  실거래가: {market_price:,}원" if market_price else "  실거래가: 없음")
        log(f"  낙찰가율: {applied_rate * 100:.0f}%" + (f" ({matched_region} 기준)" if matched_region else ""))
        log(f"  선순위: {priority_amount:,}원")
        if collateral_value is not None:
            log(f"  >>> 담보가치 = {market_price:,} x {applied_rate} - {priority_amount:,} = {collateral_value:,}원")

        final_properties.append({
            **prop,
            "matched_apt": matched_apt,
            "matched_area_type": market_result.get("matched_area_type"),
            "recent_trades": market_result.get("recent_trades"),
            "market_price": market_price,
            "hogangnono_price": hogangnono_price,
            "molit_price": molit_price,
            "molit_trade_count": molit_result.get("trade_count") if molit_result else 0,
            "molit_trades": molit_result.get("matches") if molit_result else [],
            "hammer_rate": applied_rate,
            "matched_rate_region": matched_region,
            "collateral_value": collateral_value,
        })

    return {
        "source_file": str(Path(pdf_path).name) if isinstance(pdf_path, (str, Path)) else "uploaded_file",
        "properties": final_properties,
        "grand_total_collateral": grand_total_collateral,
    }


def print_final_report(result):
    print("\n" + "#" * 70)
    print("# 최종 담보가치 평가 리포트")
    print("#" * 70)

    for i, prop in enumerate(result["properties"], 1):
        print(f"\n[물건지 {i}] {prop.get('address', '주소 미상')}")
        print(f"  선순위: {prop.get('total_priority_amount', 0):,}원")

        if prop.get("error"):
            print(f"  [오류] {prop['error']}")
            continue

        print(f"  실거래가: {prop.get('market_price'):,}원" if prop.get("market_price") else "  실거래가: 없음")
        print(f"  낙찰가율: {prop.get('hammer_rate', 0) * 100:.0f}%")
        if prop.get("collateral_value") is not None:
            print(f"  >>> 담보가치: {prop['collateral_value']:,}원")

    print("\n" + "#" * 70)
    print(f"# 전체 물건지 담보가치 총합: {result['grand_total_collateral']:,}원")
    print("#" * 70 + "\n")


if __name__ == "__main__":
    from google import genai

    # 콘솔 직접 실행(CLI) 시에만 Windows 한글 출력 깨짐 방지 적용.
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if len(sys.argv) < 2:
        print("사용법: python full_pipeline.py <PDF파일경로> [낙찰가율(0.0~1.0)] [낙찰가율기준표.xlsx]")
        print("예: python full_pipeline.py 등기부등본.pdf 0.8")
        print("예: python full_pipeline.py 등기부등본.pdf 0.8 낙찰가율표.xlsx")
        sys.exit(1)

    _api_key = os.environ.get("GEMINI_API_KEY")
    if not _api_key:
        print("[오류] 환경변수 GEMINI_API_KEY가 설정되지 않았습니다")
        sys.exit(1)
    cli_client = genai.Client(api_key=_api_key)

    pdf_file = sys.argv[1]
    rate = float(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_HAMMER_RATE
    rate_table_path = sys.argv[3] if len(sys.argv) > 3 else None

    rate_table = None
    if rate_table_path:
        try:
            rate_table = load_court_rate_table(rate_table_path, property_type="아파트")
            print(f"[기준표 로드] 법원 관할구역별 형식, {len(rate_table)}개 항목 로드됨")
        except Exception:
            rate_table = load_rate_table(rate_table_path)
            print(f"[기준표 로드] 단순 지역-낙찰가율 형식, {len(rate_table)}개 지역 로드됨")

    start = time.time()
    try:
        result = process_full_pipeline(pdf_file, cli_client, hammer_rate=rate, rate_table=rate_table)
        print_final_report(result)

        output_file = Path(pdf_file).stem + "_collateral_result.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"[저장] {output_file}")
        print(f"[처리시간] {time.time() - start:.1f}초")

    except Exception as e:
        print(f"[오류] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
