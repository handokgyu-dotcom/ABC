# -*- coding: utf-8 -*-
"""
국토교통부 아파트매매 실거래자료 조회
공공데이터포털(data.go.kr) Open API 사용
"""
import os
import sys
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# 아파트매매 실거래자료 API 엔드포인트 (data.go.kr "국토교통부_아파트 매매 실거래자료" 서비스)
BASE_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"


def _get_api_key():
    """환경변수에서 API 키를 읽음 (모듈 로드 시점이 아니라 호출 시점에 체크)"""
    key = os.environ.get("MOLIT_API_KEY")
    if not key:
        raise RuntimeError(
            "환경변수 MOLIT_API_KEY가 설정되지 않았습니다. "
            "공공데이터포털(data.go.kr)에서 발급받은 인증키를 설정하세요."
        )
    return key


def get_recent_months(n=3):
    """최근 n개월 YYYYMM 리스트 반환"""
    today = datetime.now()
    months = []
    year, month = today.year, today.month
    for _ in range(n):
        months.append(f"{year}{month:02d}")
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    return months


def fetch_trade_data(lawd_cd, deal_ymd, api_key=None):
    """
    특정 지역(법정동코드) + 특정 년월의 아파트 실거래가 조회

    Args:
        lawd_cd: 법정동코드 5자리 (예: "44131")
        deal_ymd: 계약년월 6자리 (예: "202508")

    Returns:
        거래 내역 리스트
    """
    api_key = api_key or _get_api_key()
    params = {
        "serviceKey": api_key,
        "LAWD_CD": lawd_cd,
        "DEAL_YMD": deal_ymd,
        "numOfRows": 1000,
        "pageNo": 1,
    }

    response = requests.get(BASE_URL, params=params, timeout=30)
    response.raise_for_status()

    root = ET.fromstring(response.content)

    result_code = root.findtext(".//resultCode")
    # 정상 코드는 "00" 또는 "000" 등 자릿수가 다를 수 있어 숫자로 비교
    try:
        is_ok = result_code is None or int(result_code) == 0
    except ValueError:
        is_ok = False
    if not is_ok:
        result_msg = root.findtext(".//resultMsg")
        raise RuntimeError(f"API 오류 [{result_code}]: {result_msg}")

    items = []
    for item in root.findall(".//item"):
        data = {child.tag: (child.text or "").strip() for child in item}
        items.append(data)

    return items


def find_apartment_price(lawd_cd, apt_name, dong=None, area_sqm=None, area_tolerance=3.0,
                          months_back=3, api_key=None, log=print):
    """
    특정 아파트 단지의 최근 실거래가 검색 (평형 필터링 지원)

    Args:
        lawd_cd: 법정동코드
        apt_name: 아파트 단지명 (예: "극동아파트")
        dong: 동 번호 필터 (선택, 예: "201")
        area_sqm: 전용면적(㎡) 필터. 주어지면 이 값과 가까운(±tolerance) 거래만 반환
        area_tolerance: 면적 매칭 허용 오차(㎡)
        months_back: 몇 개월 전까지 조회할지

    Returns:
        일치하는 거래 내역 리스트 (최신순), 각 항목에 excluUseAr(전용면적) 포함
    """
    all_matches = []
    months = get_recent_months(months_back)

    for ymd in months:
        try:
            items = fetch_trade_data(lawd_cd, ymd, api_key=api_key)
        except Exception as e:
            log(f"[경고] {ymd} 조회 실패: {e}")
            continue

        for item in items:
            item_apt_name = item.get("aptNm", "")
            if not (apt_name in item_apt_name or item_apt_name in apt_name):
                continue
            if dong and item.get("dong") and dong not in item.get("dong", ""):
                continue
            if area_sqm is not None:
                try:
                    item_area = float(item.get("excluUseAr", ""))
                    if abs(item_area - area_sqm) > area_tolerance:
                        continue
                except (ValueError, TypeError):
                    continue
            all_matches.append(item)

    def sort_key(x):
        return (
            x.get("dealYear", ""),
            x.get("dealMonth", "").zfill(2),
            x.get("dealDay", "").zfill(2),
        )

    all_matches.sort(key=sort_key, reverse=True)
    return all_matches


def calculate_average_price(matches):
    """거래 리스트에서 평균 매매가 계산 (만원 단위 -> 원 단위)"""
    prices = []
    for m in matches:
        amount_str = m.get("dealAmount", "").replace(",", "").strip()
        try:
            prices.append(int(amount_str))
        except ValueError:
            continue
    if not prices:
        return None
    avg_man = sum(prices) / len(prices)
    return int(avg_man * 10000)


def lookup_recent_price(lawd_cd, apt_name, dong=None, area_sqm=None, area_tolerance=3.0,
                         months_back=3, api_key=None, log=print):
    """
    통합 조회 함수: 국토부 API로 최근 실거래가 요약 반환 (hogangnono_lookup.lookup_recent_price와 같은 형식)

    Returns:
        {
            "matches": [...],
            "average_price": 139000000,
            "trade_count": 5,
            "error": None
        }
    """
    try:
        matches = find_apartment_price(
            lawd_cd, apt_name, dong=dong, area_sqm=area_sqm,
            area_tolerance=area_tolerance, months_back=months_back,
            api_key=api_key, log=log
        )
    except Exception as e:
        return {"error": str(e), "matches": [], "average_price": None, "trade_count": 0}

    if not matches:
        return {
            "error": "해당 기간/평형 내 거래 내역이 없습니다",
            "matches": [],
            "average_price": None,
            "trade_count": 0,
        }

    avg_price = calculate_average_price(matches)
    return {
        "error": None,
        "matches": matches,
        "average_price": avg_price,
        "trade_count": len(matches),
    }


def print_matches(matches, limit=10):
    """조회 결과 출력"""
    if not matches:
        print("[결과 없음] 해당 기간 내 거래 내역을 찾지 못했습니다")
        return

    print(f"\n[검색결과] 총 {len(matches)}건 (최신 {min(limit, len(matches))}건 표시)\n")
    for m in matches[:limit]:
        date_str = f"{m.get('dealYear')}-{m.get('dealMonth', '').zfill(2)}-{m.get('dealDay', '').zfill(2)}"
        amount = m.get("dealAmount", "").replace(",", "").strip()
        try:
            amount_num = int(amount) * 10000
            amount_str = f"{amount_num:,}원"
        except ValueError:
            amount_str = f"{amount}만원"

        print(f"  {date_str} | {m.get('aptNm')} {m.get('dong', '')}동 | "
              f"{m.get('excluUseAr')}㎡ | {m.get('floor')}층 | {amount_str}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("사용법: python rtms_lookup.py <법정동코드> <아파트명> [동번호] [전용면적]")
        print("예: python rtms_lookup.py 44131 극동아파트 201 84.81")
        sys.exit(1)

    lawd_cd = sys.argv[1]
    apt_name = sys.argv[2]
    dong = sys.argv[3] if len(sys.argv) > 3 else None
    area_sqm = float(sys.argv[4]) if len(sys.argv) > 4 else None

    try:
        matches = find_apartment_price(lawd_cd, apt_name, dong=dong, area_sqm=area_sqm)
        print_matches(matches)
        avg = calculate_average_price(matches)
        if avg:
            print(f"\n[평균 실거래가] {avg:,}원 ({len(matches)}건 기준)")
    except RuntimeError as e:
        print(f"[오류] {e}")
        sys.exit(1)
