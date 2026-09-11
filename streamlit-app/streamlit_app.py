# -*- coding: utf-8 -*-
"""
등기부등본 -> 담보가치 자동 계산 - Streamlit 웹 UI
물건지 자동 감지 + 선순위 계산 + 실거래가 조회 + 담보가치 산출
"""
import streamlit as st
import os
import time
from google import genai

import registry_core as core
import full_pipeline as pipeline
import pdf_report

st.set_page_config(page_title="담보가치 자동 평가 시스템", layout="wide")

DEFAULT_RATE_TABLE_PATH = os.path.join(os.path.dirname(__file__), "낙찰가율_기준표.xlsx")

# UI 구성
st.title("등기부등본 담보가치 자동 평가 시스템")
st.caption("등기부등본 업로드 → 물건지 자동 감지 → 선순위 계산 → 실거래가 조회 → 담보가치 산출")
st.markdown("---")

# 왼쪽: 사이드바
with st.sidebar:
    st.header("API 설정")
    api_key_input = st.text_input(
        "Gemini API 키",
        type="password",
        value=os.environ.get("GEMINI_API_KEY", ""),
        help="Google AI Studio에서 발급받은 API 키를 입력하세요"
    )

    st.markdown("---")
    st.header("파일 입력")
    uploaded_file = st.file_uploader("등기부등본 PDF 선택", type="pdf")

    st.markdown("---")
    st.header("낙찰가율 설정")

    has_default_table = os.path.exists(DEFAULT_RATE_TABLE_PATH)

    rate_options = ["저장된 기준표 사용 (자동)"] if has_default_table else []
    rate_options += ["다른 기준표 업로드", "기본값 사용 (전체 동일 %)"]

    rate_mode = st.radio(
        "낙찰가율 적용 방식",
        rate_options,
        index=0
    )

    if rate_mode == "저장된 기준표 사용 (자동)":
        st.caption(f"📄 {os.path.basename(DEFAULT_RATE_TABLE_PATH)} 사용 중 (업로드 불필요)")

    default_rate_pct = st.number_input(
        "기본 낙찰가율 (%) — 기준표에 없는 지역일 때 사용",
        min_value=1, max_value=100, value=80, step=1
    )
    default_rate = default_rate_pct / 100

    rate_table_file = None
    if rate_mode == "다른 기준표 업로드":
        rate_table_file = st.file_uploader(
            "낙찰가율 기준표 (csv/xlsx)",
            type=["csv", "xlsx", "xls"],
            help="법원 관할구역별 표(구분/관할법원/지역/아파트/...) 또는 단순 지역-낙찰가율 2열 표 모두 지원"
        )

    st.markdown("---")
    mode = st.radio(
        "분석 모드",
        ["자동 감지 (물건지 여러 개 가능)", "수동 지정 (페이지 직접 입력)"],
        index=0
    )

    page_input = ""
    if mode == "수동 지정 (페이지 직접 입력)":
        page_input = st.text_input(
            "을구 페이지 번호",
            value="",
            help="한 물건지: 3,4 / 여러 물건지: 세미콜론(;)으로 구분 → 8,9,10,11,12;13,14,15"
        )

    extract_button = st.button("담보가치 평가 시작", type="primary", use_container_width=True)


def format_won(v):
    if v is None:
        return "N/A"
    return f"{v:,}원"


# 메인: 결과 표시
if extract_button:
    if not api_key_input:
        st.error("Gemini API 키를 입력하세요")
    elif not uploaded_file:
        st.error("등기부등본 파일을 먼저 선택하세요")
    else:
        try:
            client = genai.Client(api_key=api_key_input)
            pdf_bytes = uploaded_file.read()

            # 낙찰가율 기준표 로드
            rate_table = None

            def _load_table_smart(source, filename_hint=""):
                """법원 관할구역별 형식 우선 시도, 실패하면 단순 2열 형식으로 재시도"""
                try:
                    t = pipeline.load_court_rate_table(source, filename_hint=filename_hint, property_type="아파트")
                    return t, "법원 관할구역별 (아파트 기준)"
                except Exception:
                    t = pipeline.load_rate_table(source, filename_hint=filename_hint)
                    return t, "단순 지역-낙찰가율"

            if rate_mode == "저장된 기준표 사용 (자동)":
                rate_table, table_format = _load_table_smart(DEFAULT_RATE_TABLE_PATH)
                with st.expander(f"낙찰가율 기준표 - {table_format} ({len(rate_table)}개 항목)", expanded=False):
                    st.dataframe(rate_table, use_container_width=True, hide_index=True)

            elif rate_mode == "다른 기준표 업로드":
                if not rate_table_file:
                    st.error("낙찰가율 기준표 파일을 업로드하세요")
                    st.stop()
                rate_table_bytes = rate_table_file.read()
                rate_table, table_format = _load_table_smart(rate_table_bytes, filename_hint=rate_table_file.name)
                with st.expander(f"낙찰가율 기준표 로드됨 - {table_format} ({len(rate_table)}개 항목)", expanded=False):
                    st.dataframe(rate_table, use_container_width=True, hide_index=True)
            # "기본값 사용" 모드는 rate_table = None 으로 유지 (전체 동일 % 적용)

            log_container = st.expander("처리 로그 보기", expanded=False)
            log_lines = []

            def ui_log(msg):
                log_lines.append(str(msg))
                log_container.text("\n".join(log_lines))

            start_time = time.time()

            if mode == "자동 감지 (물건지 여러 개 가능)":
                with st.spinner("등기부등본 분석 + 실거래가 조회 + 담보가치 계산 중..."):
                    result = pipeline.process_full_pipeline(
                        pdf_bytes, hammer_rate=default_rate, rate_table=rate_table, log=ui_log
                    )
            else:
                # 수동 지정 모드: 을구 페이지만 직접 지정, 나머지는 자동
                if page_input.strip():
                    groups_raw = page_input.split(";")
                    page_groups = []
                    for g in groups_raw:
                        g = g.strip()
                        if g:
                            page_groups.append([int(x.strip()) for x in g.split(",")])
                else:
                    total_pages = core.get_page_count(pdf_bytes)
                    page_groups = [list(range(1, total_pages + 1))]

                properties_result = []
                grand_total = 0
                for idx, page_numbers in enumerate(page_groups, start=1):
                    with st.spinner(f"물건지 {idx} 분석 중..."):
                        eulgu_data = core.extract_eulgu_data_with_gemini(client, pdf_bytes, page_numbers, log=ui_log)
                        calc = core.calculate_priority_sum(eulgu_data, log=ui_log)

                    address = None  # 수동 모드는 주소를 모르므로 시세조회 스킵 안내
                    ui_log(f"[안내] 수동 지정 모드는 주소를 알 수 없어 실거래가 조회를 생략합니다")

                    properties_result.append({
                        "property_index": idx,
                        "address": address,
                        "unique_number": None,
                        "eulgu_pages": page_numbers,
                        "raw_eulgu_data": eulgu_data,
                        "market_price": None,
                        "hammer_rate": default_rate,
                        "collateral_value": None,
                        "error": "수동 지정 모드: 주소 미상으로 시세 조회 불가 (자동 감지 모드를 사용하세요)",
                        **calc
                    })

                result = {
                    "total_properties": len(page_groups),
                    "properties": properties_result,
                    "grand_total_collateral": 0
                }

            elapsed = time.time() - start_time

            # 결과 표시
            total_props = len(result["properties"])
            st.success(f"평가 완료! ({elapsed:.1f}초 소요) — 물건지 {total_props}개 처리")

            multi = total_props > 1

            for prop in result["properties"]:
                idx = prop.get("property_index")
                if multi:
                    address_str = f" — {prop['address']}" if prop.get("address") else ""
                    st.markdown(f"## 📍 물건지 {idx}{address_str}")
                    if prop.get("unique_number"):
                        st.caption(f"고유번호: {prop['unique_number']} | 을구 페이지: {prop.get('eulgu_pages')}")
                else:
                    st.markdown("## 분석 결과")
                    if prop.get("address"):
                        st.caption(f"주소: {prop['address']}")

                col1, col2, col3 = st.columns(3)
                with col1:
                    st.metric("전체 근저당권", prop.get("total_mortgages", 0), "개")
                with col2:
                    st.metric("유효한 근저당권", len(prop.get("valid_mortgages", [])), "개")
                with col3:
                    st.metric("말소된 근저당권", prop.get("cancelled_mortgages", 0), "개")

                if prop.get("valid_mortgages"):
                    st.subheader("유효한 근저당권 목록")
                    table_data = []
                    for m in prop["valid_mortgages"]:
                        table_data.append({
                            "순위": m.get("priority"),
                            "채권최고액": f"{m.get('amount'):,}원",
                            "등기목적": m.get("purpose")
                        })
                    st.dataframe(table_data, use_container_width=True, hide_index=True)
                else:
                    st.info("유효한 근저당권이 없습니다")

                st.markdown("#### 💰 담보가치 계산")

                if prop.get("error"):
                    st.warning(f"{prop['error']}")

                if prop.get("area_sqm"):
                    area_note = f"전용 {prop['area_sqm']}㎡"
                    if prop.get("matched_area_type"):
                        area_note += f" → {prop['matched_area_type']}타입 매칭"
                    st.caption(f"📐 {area_note}")

                col_a, col_b, col_c, col_d = st.columns(4)
                with col_a:
                    st.metric("선순위", format_won(prop.get("total_priority_amount")))
                with col_b:
                    st.metric("실거래가 (평균)", format_won(prop.get("market_price")))
                with col_c:
                    rate_label = f"{prop.get('hammer_rate', 0) * 100:.0f}%"
                    if prop.get("matched_rate_region"):
                        rate_label += f" ({prop['matched_rate_region']})"
                    st.metric("낙찰가율", rate_label)
                with col_d:
                    cv = prop.get("collateral_value")
                    st.metric(
                        "담보가치",
                        format_won(cv),
                        delta=None if cv is None else ("여력 있음" if cv >= 0 else "부족")
                    )

                # 호갱노노 vs 국토부 교차검증 결과
                hg_price = prop.get("hogangnono_price")
                molit_price = prop.get("molit_price")
                if hg_price or molit_price:
                    src_col1, src_col2 = st.columns(2)
                    with src_col1:
                        st.caption(f"🏠 호갱노노: {format_won(hg_price)}")
                    with src_col2:
                        molit_label = format_won(molit_price)
                        if molit_price:
                            molit_label += f" ({prop.get('molit_trade_count', 0)}건)"
                        st.caption(f"🏛️ 국토부 실거래가: {molit_label}")

                    if hg_price and molit_price:
                        diff_pct = abs(hg_price - molit_price) / max(hg_price, molit_price) * 100
                        if diff_pct > 15:
                            st.warning(f"⚠️ 두 소스 간 차이 {diff_pct:.1f}% — 수동 확인을 권장합니다")
                        else:
                            st.caption(f"✅ 두 소스 차이 {diff_pct:.1f}% (교차검증 통과)")

                if prop.get("matched_apt"):
                    with st.expander(f"물건지 {idx} - 매칭된 실거래 단지 상세"):
                        st.json(prop["matched_apt"])
                        if prop.get("recent_trades"):
                            st.dataframe(prop["recent_trades"], use_container_width=True, hide_index=True)

                with st.expander(f"물건지 {idx} - 원본 LLM 응답 보기"):
                    st.json(prop.get("raw_eulgu_data", {}))

                with st.expander(f"물건지 {idx} - 전체 근저당권 상태 보기 (부기등기 추적 포함)"):
                    all_data = []
                    for num, mort in prop.get("all_mortgages", {}).items():
                        all_data.append({
                            "근저당권": num,
                            "상태": mort["status"],
                            "금액": f"{mort['amount']:,}원",
                            "등기목적": mort["purpose"],
                            "부기등기개수": mort.get("entries_count", 1)
                        })
                    st.dataframe(all_data, use_container_width=True, hide_index=True)

                st.markdown("---")

            if multi:
                st.markdown("## 🎯 전체 물건지 담보가치 총합")
                st.metric(
                    f"전체 담보가치 합계 (물건지 {total_props}개)",
                    format_won(result.get("grand_total_collateral")),
                    border=True
                )

            # PDF 리포트 다운로드
            st.markdown("---")
            st.markdown("## 📄 리포트 다운로드")
            try:
                result["source_file"] = uploaded_file.name
                pdf_buffer = pdf_report.generate_pdf_report(result)
                file_label = os.path.splitext(uploaded_file.name)[0]
                st.download_button(
                    label="📥 PDF 리포트 다운로드",
                    data=pdf_buffer,
                    file_name=f"{file_label}_담보가치_리포트.pdf",
                    mime="application/pdf",
                    type="primary",
                    use_container_width=True,
                )
            except Exception as pdf_err:
                st.warning(f"PDF 생성 중 오류: {pdf_err}")

        except Exception as e:
            st.error(f"오류: {str(e)}")

st.markdown("---")
st.caption(
    "선순위/근저당 정보는 Google Gemini Vision API로 분석하며, 실거래가는 호갱노노(비공식 조회)를 통해 가져옵니다. "
    "API 키는 저장되지 않으며 세션에서만 사용됩니다."
)
