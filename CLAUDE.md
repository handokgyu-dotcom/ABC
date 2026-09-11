# ABC — 작업공간 분리 안내

이 저장소는 두 사람이 동시에 바이브 코딩으로 작업합니다. **각자의 작업공간 폴더 밖의 파일은 절대 수정/생성/삭제하지 마세요.** 두 기능은 서로 독립적인 서비스이며, 코드가 섞이면 안 됩니다.

## 작업공간 구조

```
ABC/
├── credit-workflow/         # 담당자 A: HTML 기반 여신(credit) 워크플로우
│   └── remicon_credit_workflow.html
│
├── streamlit-app/           # 담당자 B: Streamlit 앱 (등기부/시세 조회 파이프라인)
│   ├── streamlit_app.py     # 앱 진입점 (entry point)
│   ├── full_pipeline.py     # 전체 처리 파이프라인
│   ├── registry_core.py     # 등기부 PDF 파싱 핵심 로직
│   ├── hogangnono_lookup.py # 호갱노노 시세 조회
│   ├── rtms_lookup.py       # 국토부 실거래가(RTMS) 조회
│   ├── pdf_report.py        # PDF 보고서 생성
│   └── .env                 # 환경변수 / API 키 (git에는 커밋되지 않음)
│
└── CLAUDE.md                # 이 문서
```

## 규칙

1. **`credit-workflow/` 담당자**는 `credit-workflow/remicon_credit_workflow.html`만 수정합니다.
   `streamlit-app/` 폴더의 어떤 파일도 읽거나 수정하지 마세요 (참고가 꼭 필요하면 사용자에게 먼저 확인).
2. **`streamlit-app/` 담당자**는 `streamlit-app/` 폴더 안의 `.py` 파일들과 `.env`만 수정합니다.
   `credit-workflow/` 폴더의 HTML 파일은 건드리지 마세요.
3. 두 작업공간을 연결하는 공유 코드, 공통 유틸, 심볼릭 링크 등을 **임의로 만들지 마세요.** 두 서비스를 실제로 통합해야 하는 경우 사용자가 명시적으로 요청할 때만 진행합니다.
4. 새 파일을 추가할 때도 반드시 자신의 작업공간 폴더 안에 만드세요. 루트에 새 파일/폴더를 만들지 마세요.
5. `streamlit-app/.py` 파일들은 서로 상대 import(`import registry_core as core` 등, 패키지 접두사 없음)로 연결되어 있으므로 항상 `streamlit-app/` 폴더 안에서 실행/유지해야 합니다.
6. `.env`에는 API 키가 들어 있습니다. 절대 내용을 출력하거나 커밋하지 마세요 (`.gitignore`에 이미 등록됨).

## 향후 통합 (참고용, 지금은 진행하지 않음)

두 서비스를 하나로 합치는 작업(예: 공통 백엔드, 공유 데이터 모델 등)은 각자의 기능이 충분히 안정화된 뒤 별도로 논의합니다. 그 전까지는 위 폴더 경계를 지켜주세요.
