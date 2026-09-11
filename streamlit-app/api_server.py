# -*- coding: utf-8 -*-
"""
등기부등본 -> 담보가치 자동 계산 - FastAPI 백엔드

streamlit_app.py(Streamlit UI, DEPRECATED)가 하던 일을 REST API로 노출한다.
프론트엔드는 ../credit-workflow/remicon_credit_workflow.html 의 새 STEP에서
이 서버를 fetch()로 호출한다 (두 폴더는 HTTP로만 연결되며, 코드/유틸을 공유하지 않는다).

실행 방법 (반드시 streamlit-app/ 폴더 안에서 실행 — 이 폴더의 .py 파일들은
서로 상대 import(`import registry_core as core` 등, 패키지 접두사 없음)로
연결되어 있음):

    cd streamlit-app
    pip install -r requirements.txt
    uvicorn api_server:app --reload --port 8000
"""
import io
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google import genai

import full_pipeline as pipeline
import pdf_report

app = FastAPI(title="담보가치 자동 평가 API")

# 개발 단계 기본값: 모든 origin 허용.
# credit-workflow/remicon_credit_workflow.html 을 실제 서버에 배포하게 되면
# allow_origins를 그 도메인으로 좁힐 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_rate_table_smart(file_bytes, filename_hint=""):
    """법원 관할구역별 형식 우선 시도, 실패하면 단순 2열 형식으로 재시도."""
    try:
        return pipeline.load_court_rate_table(file_bytes, filename_hint=filename_hint, property_type="아파트")
    except Exception:
        return pipeline.load_rate_table(file_bytes, filename_hint=filename_hint)


@app.post("/api/collateral/evaluate")
async def evaluate_collateral(
    pdf: UploadFile = File(...),
    gemini_api_key: str = Form(...),
    hammer_rate: float = Form(pipeline.DEFAULT_HAMMER_RATE),
    rate_table: UploadFile | None = File(None),
):
    """
    등기부등본 PDF -> 물건지 자동 감지 + 선순위 계산 + 실거래가 조회 + 담보가치 산출.

    streamlit_app.py의 "자동 감지" 모드와 동일한 파이프라인
    (full_pipeline.process_full_pipeline)을 그대로 재사용한다.
    """
    if not gemini_api_key:
        raise HTTPException(400, "gemini_api_key가 필요합니다")

    pdf_bytes = await pdf.read()
    if not pdf_bytes:
        raise HTTPException(400, "PDF 파일이 비어 있습니다")

    rate_table_data = None
    if rate_table is not None:
        rt_bytes = await rate_table.read()
        if rt_bytes:
            try:
                rate_table_data = _load_rate_table_smart(rt_bytes, filename_hint=rate_table.filename or "")
            except Exception as e:
                raise HTTPException(400, f"낙찰가율 기준표 파싱 실패: {e}")

    logs = []

    def api_log(msg):
        logs.append(str(msg))

    try:
        client = genai.Client(api_key=gemini_api_key)
        result = pipeline.process_full_pipeline(
            pdf_bytes,
            client,
            hammer_rate=hammer_rate,
            rate_table=rate_table_data,
            log=api_log,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"평가 처리 중 오류: {e}")

    result["source_file"] = pdf.filename or "uploaded_file"
    result["logs"] = logs
    return result


@app.post("/api/collateral/report")
async def collateral_report(result: dict):
    """
    /api/collateral/evaluate 가 반환한 결과 JSON을 그대로 받아 PDF 보고서를 생성해 스트리밍한다.
    서버에 임시 파일을 쓰지 않는다 (pdf_report.generate_pdf_report가 메모리 버퍼를 반환).
    """
    try:
        pdf_buffer = pdf_report.generate_pdf_report(result)
    except Exception as e:
        raise HTTPException(400, f"PDF 생성 실패: {e}")

    file_stem = os.path.splitext(result.get("source_file") or "collateral")[0]
    filename = f"{file_stem}_담보가치_리포트.pdf"
    # Content-Disposition 헤더는 latin-1만 허용하므로, 한글 파일명은 RFC 5987
    # filename* 형식(UTF-8 percent-encoding)으로 내려주고 filename=엔 ASCII 대체값을 둔다.
    from urllib.parse import quote
    encoded_filename = quote(filename)

    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"report.pdf\"; filename*=UTF-8''{encoded_filename}"
        },
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}
