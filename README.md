# ABC — 실행 방법

이 저장소는 두 개의 독립된 서비스로 구성됩니다 (자세한 작업공간 경계는 [CLAUDE.md](CLAUDE.md) 참고).

```
ABC/
├── credit-workflow/         # HTML 기반 여신(credit) 워크플로 — 정적 페이지
│   └── remicon_credit_workflow.html
│
└── streamlit-app/           # 등기부/시세 조회 파이프라인
    ├── api_server.py        # FastAPI 백엔드 (credit-workflow의 STEP 05가 호출)
    ├── streamlit_app.py      # 기존 Streamlit UI (DEPRECATED)
    ├── full_pipeline.py / registry_core.py / hogangnono_lookup.py / rtms_lookup.py / pdf_report.py
    ├── requirements.txt
    └── .env                  # API 키 (직접 생성 필요, git에는 커밋되지 않음)
```

두 서비스는 **HTTP(fetch) 로만** 연결됩니다 — `credit-workflow/remicon_credit_workflow.html`의 STEP 05가
`streamlit-app/api_server.py`가 띄운 백엔드를 호출하는 구조입니다. 코드/유틸은 공유하지 않습니다.

---

## 1. streamlit-app/ 의존성 설치

```bash
cd streamlit-app
pip install -r requirements.txt
```

### 필요한 환경변수 (.env)

`streamlit-app/.env` 파일을 직접 만들고 아래 키를 채워 넣으세요 (`.gitignore`에 등록되어 있어 커밋되지 않습니다):

```
GEMINI_API_KEY=여기에_Gemini_API_키
MOLIT_API_KEY=여기에_국토부_실거래가_공개시스템_API_키
```

- `GEMINI_API_KEY`: 등기부등본 PDF 인식(Google Gemini Vision)에 사용. FastAPI 백엔드는 이 키를 서버 환경변수가 아니라
  **요청마다 프론트엔드가 보내는 값**으로 받으므로, API로만 쓸 거라면 `.env`에 꼭 넣지 않아도 됩니다(당장은 편의를 위해 기본값으로만 쓰임).
- `MOLIT_API_KEY`: 국토교통부 실거래가 조회(`rtms_lookup.py`)에 필요. 서버 환경변수로 반드시 설정해야 합니다.

## 2. FastAPI 백엔드 실행 (streamlit-app/api_server.py)

`streamlit-app/` 폴더 안에서 실행해야 합니다 (이 폴더의 `.py` 파일들이 서로 상대 import로 연결되어 있음).

```bash
cd streamlit-app
python -m uvicorn api_server:app --reload --port 8000
```

> `uvicorn` 명령을 PATH에 등록해 두었다면 `python -m` 없이 `uvicorn api_server:app --reload --port 8000`으로도 실행됩니다.

정상 기동 확인:

```bash
curl http://localhost:8000/api/health
# {"status":"ok"}
```

주요 엔드포인트:
- `POST /api/collateral/evaluate` — 등기부등본 PDF 업로드 → 담보가치 자동 평가 (JSON 반환)
- `POST /api/collateral/report` — 위 결과 JSON을 받아 PDF 리포트 생성/다운로드

## 3. credit-workflow 프론트엔드 열기

`credit-workflow/remicon_credit_workflow.html`은 정적 파일이라 서버 없이 브라우저에서 바로 엽니다.

```bash
start credit-workflow/remicon_credit_workflow.html   # Windows
```

또는 파일 탐색기에서 더블클릭해서 열어도 됩니다. **STEP 05 "담보가치 평가"** 탭에서 등기부 PDF와 Gemini API 키를 입력하고
"담보가치 평가 실행"을 누르면, 위에서 띄운 FastAPI 백엔드(`http://localhost:8000`)를 호출합니다.
백엔드가 켜져 있지 않으면 이 탭에서 오류 메시지가 표시됩니다(다른 STEP은 영향 없이 정상 동작).

## 4. (참고, DEPRECATED) 기존 Streamlit UI

`streamlit-app/streamlit_app.py`는 API 서버로 대체될 예정이며 더 이상 신규 기능이 반영되지 않습니다.
그래도 당분간은 아래처럼 계속 켤 수 있습니다.

```bash
cd streamlit-app
streamlit run streamlit_app.py
```

---

## 실행 순서 요약

1. `cd streamlit-app && pip install -r requirements.txt`
2. `streamlit-app/.env`에 `MOLIT_API_KEY` (필요 시 `GEMINI_API_KEY`) 채우기
3. `python -m uvicorn api_server:app --reload --port 8000` (streamlit-app/ 안에서)
4. `credit-workflow/remicon_credit_workflow.html`을 브라우저로 열고 STEP 05에서 사용
