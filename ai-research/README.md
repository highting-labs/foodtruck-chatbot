# ai-research — 사내 AI 전환 PoC (운영 코드와 분리)

운영 챗봇(`api/`, `lib/`)은 고치지 않는다. 이 폴더는 사이트에 올라가지 않는다(`.vercelignore`). 문서는 `docs/ai-research/`.

| 경로 | 내용 |
|---|---|
| `eval/ollama-adapter.js` | Anthropic Messages 요청 ↔ Ollama `/api/chat` 변환(나중에 `lib/llm.js`로 옮길 규칙) |
| `eval/run-eval.js` | `api/chat.js`를 그대로 돌려 Claude/로컬 모델 비교. 문자·시트·기록 가로챔, 운영 Supabase 차단(메뉴판 사본으로 동작) |
| `eval/questions.json` | 비교 질문 24개(가짜 상황) |
| `eval/rescore-sessions.js` | '근거 없는 금액' 채점(시험장 Claude 기록·run-eval 결과 공통) |
| `rag/make_samples.py` | 가짜 상담 12건 생성(카카오 내보내기와 같은 CSV 형식) |
| `rag/pipeline.py` | 정제: 익명화 → 상담 분리 → 정보 추출 → 검증 → jsonl |
| `rag/rag.py` | BM25 + 벡터 + 메타 RRF 검색, 견적 엔진 호출, 근거 답변 JSON, 근거 없는 금액 자동 보류 |
| `rag/store_pg.py`, `rag/schema.sql`, `docker-compose.yml` | 로컬 pgvector(127.0.0.1:5433) 적재·하이브리드 SQL 검색 |
| `rag/quote_bridge.js` | 파이썬에서 기존 `lib/quote-engine.js` 호출(네트워크 차단) |

## 실행 (Windows, 이 PC 기준)
```
# 준비: Ollama 설치 + 모델
ollama pull qwen3-embedding:0.6b ; ollama pull qwen3.5:4b ; ollama pull qwen3.5:9b
docker compose -f ai-research/docker-compose.yml up -d

# 테스트(네트워크 없음)
node --test ai-research/eval/
python -I -X utf8 -m unittest discover -s ai-research/rag -p "test_*.py"

# 비교 시험 (출력 폴더는 저장소 밖으로)
node ai-research/eval/run-eval.js ollama:qwen3.5:4b <출력 폴더>
EVAL_ENV_FILE=<시험장 .env> node ai-research/eval/run-eval.js claude <출력 폴더>   # 시험용 키, 약 $0.5~1
node ai-research/eval/rescore-sessions.js <출력 폴더>/eval_ollama_qwen3.5_4b.json

# RAG
python -I -X utf8 ai-research/rag/pipeline.py ai-research/rag/sample_data/kakao --out <출력 폴더>
python -I -X utf8 ai-research/rag/rag.py index <출력 폴더>
python -I -X utf8 ai-research/rag/store_pg.py load <출력 폴더>
python -I -X utf8 ai-research/rag/rag.py eval <출력 폴더> --model qwen3.5:4b --out <출력 폴더>/rag_4b.json
```
- 실제 상담(원본·익명본)은 이 폴더에 넣지 않는다. 익명본을 쓸 땐 `pipeline.py <익명본 폴더> --out <저장소 밖 폴더>`로 원본 위치에서 읽기만.
