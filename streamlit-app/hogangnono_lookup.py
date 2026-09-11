# -*- coding: utf-8 -*-
"""
호갱노노(hogangnono.com) 실거래가 조회
- 공식 API가 아닌, 웹사이트가 내부적으로 쓰는 엔드포인트를 호출합니다.
- 사이트 구조가 바뀌면 깨질 수 있음을 유의하세요.
- 데이터 원본은 국토교통부 실거래가입니다.
"""
import sys
import json
import requests
from datetime import datetime, timedelta

# Windows 콘솔 한글 출력 깨짐 방지 (이미 설정되어 있으면 건너뜀)
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_URL = "https://hogangnono.com"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

# 기본 좌표 (검색 결과 순위에 약간 영향, 텍스트 매칭이 우선이라 크게 중요하지 않음)
DEFAULT_X = 127.0547915
DEFAULT_Y = 37.523003


def search_apartment(query, x=DEFAULT_X, y=DEFAULT_Y, timeout=10):
    """
    아파트/지역명으로 검색하여 후보 단지 리스트 반환

    Args:
        query: 검색어 (예: "천안 청수동 극동아파트")

    Returns:
        후보 리스트 [{"id": "79r35", "name": "극동2차", "address": "...", "household": 510, ...}, ...]
    """
    url = f"{BASE_URL}/api/v2/searches/suggestions/new"
    params = {"query": query, "x": x, "y": y}
    resp = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    apt_list = data.get("data", {}).get("matched", {}).get("apt", {}).get("list", [])
    return apt_list


def find_best_match(candidates, jibun_address):
    """
    후보 리스트 중, 지번 주소(번지)가 일치하는 것을 우선적으로 찾는다.

    Args:
        candidates: search_apartment()의 결과
        jibun_address: 등기부등본에서 추출한 지번 주소 (예: "충청남도 천안시 동남구 청수동 183")

    Returns:
        가장 일치하는 후보 (dict) 또는 None
    """
    if not candidates:
        return None

    # 주소에서 핵심 부분(동+번지) 추출해서 비교
    jibun_normalized = jibun_address.replace(" ", "")

    for c in candidates:
        addr_normalized = c.get("address", "").replace(" ", "")
        if addr_normalized and addr_normalized in jibun_normalized:
            return c
        if addr_normalized and jibun_normalized in addr_normalized:
            return c

    # 정확히 일치하는 게 없으면 검색 순위 1위 반환 (약한 매칭)
    return candidates[0]


def get_recent_trades(apt_id, trade_type=0, start=0, timeout=10):
    """
    특정 단지의 최근 실거래 내역 조회

    Args:
        apt_id: 호갱노노 내부 단지 ID (예: "79r35")
        trade_type: 0=매매, 1=전세, 2=월세

    Returns:
        거래 내역 리스트 (최신순)
        [{"floor": 2, "price": 13500(만원), "date": "2026-09-06...", "dong": None, "areaType": "102", ...}, ...]
    """
    url = f"{BASE_URL}/api/v2/apts/{apt_id}/trade-real"
    params = {"tradeType": trade_type, "start": start}
    resp = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    return data.get("data", {}).get("data", [])


def get_area_types(apt_id, timeout=10):
    """
    단지 내 평형(타입)별 전용면적 매핑 조회.

    참고: /api/apt/{id}/detail 엔드포인트는 직접 호출 시 400을 반환하여(SSR 전용으로 추정),
    대신 단지 상세 페이지 HTML에 서버가 미리 렌더링해 넣어둔 "areaMap" 임베드 데이터를 파싱한다.

    Returns:
        [{"area_type": "102", "private_area_sqm": 84.81, "public_area_sqm": 102.02}, ...]
    """
    url = f"{BASE_URL}/apt/{apt_id}/0"
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    html = resp.text

    marker = '"areaMap":'
    idx = html.find(marker)
    if idx == -1:
        return []

    start = html.find('{', idx)
    depth = 0
    end = start
    for i in range(start, len(html)):
        if html[i] == '{':
            depth += 1
        elif html[i] == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    try:
        area_map = json.loads(html[start:end])
    except (json.JSONDecodeError, ValueError):
        return []

    result = []
    for area_id, info in area_map.items():
        private_sqm = info.get("private_area")
        public_sqm = info.get("public_area")

        # areaType 코드는 popular_type.area[].type 필드에 정확히 들어있음 (예: "102")
        area_type_code = None
        popular_type = info.get("popular_type") or {}
        area_types_in_popular = popular_type.get("area") or []
        info_id = info.get("id")
        for pa in area_types_in_popular:
            if str(pa.get("areaId")) == str(area_id) or (info_id is not None and pa.get("areaId") == info_id):
                area_type_code = pa.get("type")
                break
        if area_type_code is None and area_types_in_popular:
            area_type_code = area_types_in_popular[0].get("type")
        if area_type_code is None and public_sqm:
            # 폴백: 정수부만 취함 (버림)
            area_type_code = str(int(public_sqm))

        result.append({
            "area_type": area_type_code,
            "private_area_sqm": private_sqm,
            "public_area_sqm": public_sqm,
        })
    return result


def find_matching_area_type(area_types, target_sqm, tolerance=3.0):
    """
    등기부등본에서 추출한 전용면적(㎡)과 가장 가까운 areaType 코드를 찾는다.

    Args:
        area_types: get_area_types()의 결과
        target_sqm: 찾고자 하는 전용면적 (㎡)
        tolerance: 허용 오차 (㎡). 이 범위 밖이면 매칭 실패로 간주

    Returns:
        area_type 코드 (문자열) 또는 None
    """
    if not area_types or target_sqm is None:
        return None

    best = None
    best_diff = None
    for a in area_types:
        private_sqm = a.get("private_area_sqm")
        if private_sqm is None:
            continue
        diff = abs(private_sqm - target_sqm)
        if best_diff is None or diff < best_diff:
            best_diff = diff
            best = a

    if best is not None and best_diff is not None and best_diff <= tolerance:
        return best["area_type"]
    return None


def filter_recent(trades, months=3, area_type=None):
    """
    최근 N개월 이내 거래만 필터링 (isCancelled 제외).
    area_type이 주어지면 해당 평형 타입만 필터링 (다른 평형 섞임 방지).
    """
    from datetime import timezone
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=months * 30)
    result = []
    for t in trades:
        if t.get("isCancelled"):
            continue
        if area_type is not None and str(t.get("areaType")) != str(area_type):
            continue
        date_str = t.get("date")
        if not date_str:
            continue
        try:
            trade_date = datetime.fromisoformat(date_str.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            continue
        if trade_date >= cutoff:
            result.append(t)
    return result


def calculate_average_price(trades):
    """거래 리스트에서 평균 매매가 계산 (만원 단위 입력 -> 원 단위 반환)"""
    prices = [t["price"] for t in trades if t.get("price")]
    if not prices:
        return None
    avg_man = sum(prices) / len(prices)
    return int(avg_man * 10000)  # 만원 -> 원


def lookup_recent_price(address_or_apt_name, months=3, trade_type=0, target_area_sqm=None, area_tolerance=3.0):
    """
    통합 조회 함수: 주소/아파트명 입력 -> 최근 실거래가 요약 반환

    Args:
        address_or_apt_name: 검색어 (등기부등본 주소 또는 아파트명)
        months: 최근 몇 개월 데이터를 볼지
        trade_type: 0=매매, 1=전세, 2=월세
        target_area_sqm: 등기부등본에서 추출한 전용면적(㎡). 주어지면 같은 평형만 필터링
        area_tolerance: 면적 매칭 허용 오차(㎡)

    Returns:
        {
            "matched_apt": {...},
            "matched_area_type": "102",       # 매칭된 평형 코드 (있으면)
            "recent_trades": [...],
            "average_price": 139000000,
            "trade_count": 5,
            "area_filter_applied": True/False
        }
    """
    candidates = search_apartment(address_or_apt_name)
    if not candidates:
        return {"error": "검색 결과가 없습니다", "query": address_or_apt_name}

    matched = find_best_match(candidates, address_or_apt_name)
    if not matched:
        return {"error": "일치하는 단지를 찾지 못했습니다", "query": address_or_apt_name}

    apt_id = matched["id"]

    # 전용면적이 주어졌으면 해당 평형(areaType)을 찾아서 필터링
    matched_area_type = None
    area_filter_applied = False
    if target_area_sqm:
        try:
            area_types = get_area_types(apt_id)
            matched_area_type = find_matching_area_type(area_types, target_area_sqm, tolerance=area_tolerance)
        except Exception:
            matched_area_type = None

    all_trades = get_recent_trades(apt_id, trade_type=trade_type)

    if matched_area_type:
        recent = filter_recent(all_trades, months=months, area_type=matched_area_type)
        area_filter_applied = True
        if not recent:
            # 최근 N개월 내 같은 평형 거래가 없으면, 기간 제한 없이 같은 평형 최신 거래로 대체
            same_area_all = [t for t in all_trades if str(t.get("areaType")) == str(matched_area_type)
                              and not t.get("isCancelled")]
            recent = same_area_all[:5]
    else:
        # 면적 매칭 실패 시 기존 방식(전체 평형 평균)으로 폴백
        recent = filter_recent(all_trades, months=months)

    avg_price = calculate_average_price(recent) if recent else calculate_average_price(all_trades[:5])

    note = None
    if target_area_sqm and not matched_area_type:
        note = f"전용면적 {target_area_sqm}㎡과 일치하는 평형을 찾지 못해 전체 평형 평균으로 대체"
    elif not recent:
        note = "최근 데이터 없어 최신 5건으로 대체"

    return {
        "matched_apt": {
            "id": apt_id,
            "name": matched.get("name"),
            "address": matched.get("address"),
            "road_address": matched.get("road_address"),
            "household": matched.get("household"),
            "region_code": matched.get("region_code"),
            "lawd_cd": (matched.get("region_code") or "")[:5] or None,
        },
        "matched_area_type": matched_area_type,
        "target_area_sqm": target_area_sqm,
        "area_filter_applied": area_filter_applied,
        "recent_trades": recent if recent else all_trades[:5],
        "average_price": avg_price,
        "trade_count": len(recent) if recent else len(all_trades[:5]),
        "note": note,
    }


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("사용법: python hogangnono_lookup.py <검색어>")
        print('예: python hogangnono_lookup.py "충청남도 천안시 동남구 청수동 183 극동아파트"')
        sys.exit(1)

    query = sys.argv[1]
    result = lookup_recent_price(query)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if "average_price" in result and result["average_price"]:
        print(f"\n[요약] {result['matched_apt']['name']} 최근 평균 실거래가: {result['average_price']:,}원")
