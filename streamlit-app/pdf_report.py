# -*- coding: utf-8 -*-
"""
담보가치 평가 결과를 PDF 리포트로 생성
"""
import io
from datetime import datetime

import os
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

FONT_NAME = "MalgunGothic"
FONT_BOLD = "MalgunGothic-Bold"

_MALGUN_REGULAR = r"C:\Windows\Fonts\malgun.ttf"
_MALGUN_BOLD = r"C:\Windows\Fonts\malgunbd.ttf"

if os.path.exists(_MALGUN_REGULAR) and os.path.exists(_MALGUN_BOLD):
    # 시스템 폰트(맑은 고딕) 사용: 숫자/문장부호가 반각으로 정상 렌더링됨
    pdfmetrics.registerFont(TTFont(FONT_NAME, _MALGUN_REGULAR))
    pdfmetrics.registerFont(TTFont(FONT_BOLD, _MALGUN_BOLD))
else:
    # 폰트 파일이 없는 환경 대비 폴백 (CID 내장 폰트, 반각 처리 이슈 있을 수 있음)
    FONT_NAME = "HYSMyeongJo-Medium"
    FONT_BOLD = "HYGothic-Medium"
    pdfmetrics.registerFont(UnicodeCIDFont(FONT_NAME))
    pdfmetrics.registerFont(UnicodeCIDFont(FONT_BOLD))


def _won(v):
    if v is None:
        return "-"
    return f"{v:,}원"


def _pct(v):
    if v is None:
        return "-"
    return f"{v * 100:.0f}%"


def build_styles():
    styles = {}
    styles["title"] = ParagraphStyle(
        "title", fontName=FONT_BOLD, fontSize=20, alignment=TA_CENTER,
        spaceAfter=6, textColor=colors.HexColor("#1a1a2e")
    )
    styles["subtitle"] = ParagraphStyle(
        "subtitle", fontName=FONT_NAME, fontSize=10, alignment=TA_CENTER,
        textColor=colors.HexColor("#666666"), spaceAfter=16
    )
    styles["h2"] = ParagraphStyle(
        "h2", fontName=FONT_BOLD, fontSize=14, spaceBefore=14, spaceAfter=8,
        textColor=colors.HexColor("#16213e")
    )
    styles["body"] = ParagraphStyle(
        "body", fontName=FONT_NAME, fontSize=10, leading=15
    )
    styles["small"] = ParagraphStyle(
        "small", fontName=FONT_NAME, fontSize=8.5, leading=12,
        textColor=colors.HexColor("#555555")
    )
    styles["kpi_label"] = ParagraphStyle(
        "kpi_label", fontName=FONT_NAME, fontSize=9, alignment=TA_CENTER,
        textColor=colors.HexColor("#666666")
    )
    styles["kpi_value"] = ParagraphStyle(
        "kpi_value", fontName=FONT_BOLD, fontSize=15, alignment=TA_CENTER,
        textColor=colors.HexColor("#0f3460")
    )
    styles["kpi_value_neg"] = ParagraphStyle(
        "kpi_value_neg", fontName=FONT_BOLD, fontSize=15, alignment=TA_CENTER,
        textColor=colors.HexColor("#c0392b")
    )
    return styles


def _kpi_table(items, styles):
    """상단 요약 카드 형태 (라벨/값 쌍 여러 개를 가로로)"""
    header_row = [Paragraph(label, styles["kpi_label"]) for label, _ in items]
    value_row = []
    for _, value in items:
        is_neg = isinstance(value, str) and value.startswith("-")
        style = styles["kpi_value_neg"] if is_neg else styles["kpi_value"]
        value_row.append(Paragraph(value, style))

    col_width = (170 * mm) / len(items)
    t = Table([header_row, value_row], colWidths=[col_width] * len(items))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f5f6fa")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#dcdde1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dcdde1")),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def _mortgage_table(mortgages, styles):
    """유효 근저당권 목록 테이블"""
    data = [["순위", "채권최고액", "등기목적"]]
    for m in mortgages:
        data.append([
            str(m.get("priority", "")),
            _won(m.get("amount")),
            str(m.get("purpose", "")),
        ])

    t = Table(data, colWidths=[25 * mm, 50 * mm, 95 * mm])
    style_cmds = [
        ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ("FONTNAME", (0, 1), (-1, -1), FONT_NAME),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f3460")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dcdde1")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style_cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f5f6fa")))
    t.setStyle(TableStyle(style_cmds))
    return t


def generate_pdf_report(result, output_path_or_buffer=None):
    """
    담보가치 평가 결과(full_pipeline.process_full_pipeline의 반환값)를
    PDF 리포트로 생성한다.

    Args:
        result: process_full_pipeline() 결과 dict
        output_path_or_buffer: 저장할 파일 경로 또는 BytesIO. None이면 새 BytesIO 반환

    Returns:
        output_path_or_buffer (파일 경로를 넘겼으면 그 경로, 아니면 BytesIO)
    """
    styles = build_styles()

    if output_path_or_buffer is None:
        output_path_or_buffer = io.BytesIO()

    doc = SimpleDocTemplate(
        output_path_or_buffer,
        pagesize=A4,
        topMargin=18 * mm,
        bottomMargin=15 * mm,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
    )

    elements = []

    # 표지 / 헤더
    elements.append(Paragraph("등기부등본 담보가치 평가 리포트", styles["title"]))
    now_str = datetime.now().strftime("%Y년 %m월 %d일 %H:%M")
    source_file = result.get("source_file", "-")
    elements.append(Paragraph(f"생성일시: {now_str} | 원본 파일: {source_file}", styles["subtitle"]))
    elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#0f3460")))
    elements.append(Spacer(1, 10))

    properties = result.get("properties", [])
    multi = len(properties) > 1

    # 전체 요약 (물건지 여러 개일 때)
    if multi:
        elements.append(Paragraph("전체 요약", styles["h2"]))
        elements.append(_kpi_table([
            ("총 물건지 수", f"{len(properties)}개"),
            ("전체 담보가치 합계", _won(result.get("grand_total_collateral"))),
        ], styles))
        elements.append(Spacer(1, 14))

    # 물건지별 상세
    for i, prop in enumerate(properties, 1):
        if i > 1:
            elements.append(Spacer(1, 10))
            elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#dcdde1")))
            elements.append(Spacer(1, 10))

        title = f"물건지 {i}" if multi else "평가 결과"
        if prop.get("address"):
            title += f" — {prop['address']}"
        elements.append(Paragraph(title, styles["h2"]))

        if prop.get("unique_number"):
            elements.append(Paragraph(f"고유번호: {prop['unique_number']}", styles["small"]))
            elements.append(Spacer(1, 6))

        if prop.get("error"):
            elements.append(Paragraph(f"⚠ {prop['error']}", styles["body"]))
            continue

        # 핵심 지표 카드
        rate_label = _pct(prop.get("hammer_rate"))
        if prop.get("matched_rate_region"):
            rate_label += f" ({prop['matched_rate_region']})"

        elements.append(_kpi_table([
            ("선순위", _won(prop.get("total_priority_amount"))),
            ("실거래가", _won(prop.get("market_price"))),
            ("낙찰가율", rate_label),
            ("담보가치", _won(prop.get("collateral_value"))),
        ], styles))
        elements.append(Spacer(1, 10))

        # 계산식
        if prop.get("collateral_value") is not None and prop.get("market_price"):
            formula = (
                f"담보가치 = 실거래가({_won(prop.get('market_price'))}) × "
                f"낙찰가율({rate_label}) - 선순위({_won(prop.get('total_priority_amount'))}) "
                f"= {_won(prop.get('collateral_value'))}"
            )
            elements.append(Paragraph(formula, styles["small"]))
            elements.append(Spacer(1, 10))

        # 근저당권 요약
        elements.append(Paragraph(
            f"전체 근저당권 {prop.get('total_mortgages', 0)}개 "
            f"(유효 {len(prop.get('valid_mortgages', []))}개, "
            f"말소 {prop.get('cancelled_mortgages', 0)}개)",
            styles["body"]
        ))
        elements.append(Spacer(1, 6))

        if prop.get("valid_mortgages"):
            elements.append(_mortgage_table(prop["valid_mortgages"], styles))
        else:
            elements.append(Paragraph("유효한 근저당권이 없습니다.", styles["small"]))

        # 매칭된 실거래 단지 정보
        matched_apt = prop.get("matched_apt")
        if matched_apt:
            elements.append(Spacer(1, 8))
            elements.append(Paragraph(
                f"실거래 매칭 단지: {matched_apt.get('name', '-')} "
                f"({matched_apt.get('address', '-')}, {matched_apt.get('household', '-')}세대)",
                styles["small"]
            ))

    # 하단 안내
    elements.append(Spacer(1, 20))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#dcdde1")))
    elements.append(Spacer(1, 6))
    elements.append(Paragraph(
        "※ 본 리포트는 자동화 도구로 생성된 참고 자료이며, 법적 효력이 없습니다. "
        "선순위/근저당 정보는 AI 비전 분석 결과이므로 반드시 원본 등기부등본과 대조 확인하시기 바랍니다. "
        "실거래가는 비공식 경로로 조회된 참고값입니다.",
        styles["small"]
    ))

    doc.build(elements)

    if hasattr(output_path_or_buffer, "seek"):
        output_path_or_buffer.seek(0)

    return output_path_or_buffer


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("사용법: python pdf_report.py <결과JSON파일> [출력PDF경로]")
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        result = json.load(f)

    output_path = sys.argv[2] if len(sys.argv) > 2 else "담보가치_리포트.pdf"
    generate_pdf_report(result, output_path)
    print(f"[저장] {output_path}")
