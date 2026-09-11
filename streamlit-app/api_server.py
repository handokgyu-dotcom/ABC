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

from dotenv import load_dotenv

# .env는 이 파일과 같은 폴더(streamlit-app/)에 있다고 가정한다.
# 프로세스가 어느 위치에서/어떻게 기동되든(uvicorn, streamlit 등) 항상 로드되도록
# 파일 경로를 명시한다 (cwd에 의존하지 않음).
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

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


# 낙찰가율 기준표: streamlit-app/ 폴더에 미리 넣어둔 고정 파일을 항상 사용한다.
# (streamlit_app.py의 "저장된 기준표 사용 (자동)" 모드와 동일한 파일 · 동일한 방식)
# 프론트엔드(credit-workflow HTML)는 매 요청마다 표를 업로드하지 않는다.
DEFAULT_RATE_TABLE_PATH = os.path.join(os.path.dirname(__file__), "낙찰가율_기준표.xlsx")

_default_rate_table_cache = None


def _load_rate_table_smart(file_bytes_or_path, filename_hint=""):
    """법원 관할구역별 형식 우선 시도, 실패하면 단순 2열 형식으로 재시도."""
    try:
        return pipeline.load_court_rate_table(file_bytes_or_path, filename_hint=filename_hint, property_type="아파트")
    except Exception:
        return pipeline.load_rate_table(file_bytes_or_path, filename_hint=filename_hint)


def _load_default_rate_table():
    """서버에 저장된 낙찰가율_기준표.xlsx를 최초 요청 시 1회만 로드해 캐시한다."""
    global _default_rate_table_cache
    if _default_rate_table_cache is None:
        if not os.path.exists(DEFAULT_RATE_TABLE_PATH):
            raise HTTPException(
                500,
                f"서버에 낙찰가율 기준표({os.path.basename(DEFAULT_RATE_TABLE_PATH)})가 없습니다. "
                f"streamlit-app/ 폴더에 파일을 넣어주세요.",
            )
        _default_rate_table_cache = _load_rate_table_smart(
            DEFAULT_RATE_TABLE_PATH, filename_hint=DEFAULT_RATE_TABLE_PATH
        )
    return _default_rate_table_cache


@app.post("/api/collateral/evaluate")
async def evaluate_collateral(
    pdf: UploadFile = File(...),
    gemini_api_key: str | None = Form(None),
    hammer_rate: float = Form(pipeline.DEFAULT_HAMMER_RATE),
):
    """
    등기부등본 PDF -> 물건지 자동 감지 + 선순위 계산 + 실거래가 조회 + 담보가치 산출.

    streamlit_app.py의 "자동 감지" 모드와 동일한 파이프라인
    (full_pipeline.process_full_pipeline)을 그대로 재사용한다.

    gemini_api_key는 선택값이다. 프론트엔드(credit-workflow HTML)는 키를 직접
    다루지 않으며, 값이 없으면 서버 쪽 환경변수 GEMINI_API_KEY(.env)를 사용한다.
    낙찰가율 기준표도 마찬가지로 매 요청 업로드받지 않고, 서버에 저장된
    낙찰가율_기준표.xlsx를 항상 사용한다.
    """
    gemini_api_key = gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if not gemini_api_key:
        raise HTTPException(500, "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다 (.env 확인 필요)")

    pdf_bytes = await pdf.read()
    if not pdf_bytes:
        raise HTTPException(400, "PDF 파일이 비어 있습니다")

    rate_table_data = _load_default_rate_table()

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
