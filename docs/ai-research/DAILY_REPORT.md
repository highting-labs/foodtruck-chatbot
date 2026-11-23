# 8. 작업 보고 — 2026-11-19 사내 AI 사전 연구·PoC

## 요약
- 현재 챗봇 구조 분석 완료: Java/Spring이 아니라 **Vercel 서버리스(Node)**, Claude 호출 1곳(`api/chat.js:351`), 턴당 약 $0.015·5.2초, 대화당 약 $0.06~0.07(단가 보정)
- 로컬 LLM 후보 선정·실측: 이 PC(RTX 2060 SUPER 8GB)에서 qwen3.5:4b(100% GPU)·9b(일부 CPU) 시험. **손님 챗봇 대체는 부적합**(도구 호출 1~2/11, 접수 누락), **직원용 RAG 도우미는 4b로 가능**(검색 7/7, JSON 8/8)
- 데이터 파이프라인·RAG PoC 구현: 익명화 → 상담 분리 → 추출 → 검증 → pgvector(로컬 Docker), 하이브리드 검색, 견적 엔진 연동, 근거 없는 금액 자동 보류
- 테스트 질문 32개(챗봇 24 + RAG 8) 작성·실행
- 비용 분석: 지금 대화량에서는 API 비용이 작을 가능성이 큼, 코드의 캐시 읽기 단가 기록 오류 발견(PR #23)
- **11-20 추가: Claude 24문항 실행 — Haiku 5.5가 Sonnet 5.5와 같은 24/24 통과에 비용 $0.0238 대 $0.3231(약 1/14).** 단 코드의 `max_tokens 1024`로는 Haiku 답 2/27개가 잘림 → 4096이면 해결(임시 사본으로 확인)

## 진행사항
- chatbot-developer: 호출 구조·토큰 실측·저장 구조·교체 지점(`lib/llm.js` 어댑터) 확인
- chatbot-tester: 시험 자산(고정 세트 20명·회귀 59·세션 417)·실패 유형·반출 제한 확인
- 하드웨어 조사 → Ollama 0.40.16 설치(winget 다운로드 멈춤 → 공식 설치 파일 직접, 서명 확인) → 모델 3개(약 10.5GB)
- 시험 하네스: 운영 코드를 고치지 않고 Anthropic ↔ Ollama 변환으로 같은 프롬프트·도구 비교
- 로컬 pgvector 0.8.7 컨테이너(127.0.0.1:5433) 띄움 — 지금도 실행 중
- 문서 8개 작성(`docs/ai-research/`)

## 생성·수정한 파일 (브랜치 `docs/ai-research`)
- 새 문서: `docs/ai-research/` CURRENT_ARCHITECTURE · LOCAL_LLM_COMPARISON · DATA_PIPELINE · RAG_ARCHITECTURE · MODEL_EVALUATION · COST_ANALYSIS · IMPLEMENTATION_ROADMAP · DAILY_REPORT
- 새 코드: `ai-research/` README · docker-compose.yml · eval/(ollama-adapter.js, ollama-adapter.test.js, run-eval.js, rescore-sessions.js, questions.json) · rag/(make_samples.py, pipeline.py, rag.py, store_pg.py, quote_bridge.js, schema.sql, rag_questions.json, test_rag.py, sample_data/kakao/대화_S001~S012.csv 가짜)
- 수정: `.vercelignore`에 `ai-research/` 한 줄(시험 코드가 사이트 공개 파일로 올라가지 않게)
- 운영 코드(`api/`, `lib/`, `index.html`) 변경 없음
- 저장소 밖: 시험 원자료 JSON → `workspace\_reports\foodtruck-chatbot\2026-11-19_ai-research\`

## 실행한 테스트
| 테스트 | 결과 |
|---|---|
| 어댑터 변환 단위 테스트(node --test) | 6/6 통과 |
| RAG 단위 테스트(unittest) | 13/13 통과 |
| 손님 챗봇 24문항 — qwen3.5:4b(2회)·9b(1회) | 통과 13·13/24, 도구 2·1/11, 근거 없는 금액 11·1/24 |
| RAG 8문항 — 4b·9b | 검색 7/7, JSON 8/8, 근거 없는 금액 없음 6·8/8 |
| pgvector 하이브리드 검색 4문항 | 4/4 1위 |
| 기존 Claude 기록 재채점(317대화) | 금액 언급 턴의 4.2% 추적 불가 |
| Haiku 5.5 회귀 59대화 · 고정 세트 20명(11-23) | 회귀: 오류·주입 0, 반복 한도에 걸린 턴 3(한도 4로 재확인 시 0) / 고정 세트: 번호 접수 19/19, 금액 오류 0(1건은 채점 오탐) / 턴당 비용 Sonnet의 약 1/11~1/12, 합계 $0.58 |
| Claude로 같은 24문항(11-20, 사용자 요청 후) | Sonnet 5.5 24/24 · $0.3231 / Haiku 5.5 24/24 · $0.0236(잘림 2/27) / Haiku 5.5 max_tokens 4096 24/24 · $0.0238(잘림 0) |

## 발견한 문제
- **문제** — 로컬 모델이 견적·접수 도구를 거의 안 부름 / 원인: 긴 한국어 규칙 + 작은 모델, 매뉴얼이 Claude 습관에 맞춰짐 / 해결: 손님 챗봇은 Claude 유지, 로컬은 역할을 좁힌 직원 도우미로
- **문제** — `api/chat.js:25` `PRICE`의 Sonnet 5.5 캐시 읽기 $0.20(공식 $0.10) / 원인: 단가 기록 오류 / 해결: 공식 단가 페이지 각주(Opus 5.5·Sonnet 5.5 캐시 적중 = 입력의 0.05배)로 확인 → chatbot-developer가 PR #23으로 정정(대화 기록 비용이 약 35% 높게 나오던 것). 이 브랜치에서는 안 고침
- **문제** — 규칙 추출이 "연수원" 속 "수원"을 지역으로 잡음 / 해결: 가장 먼저 나온 지역 + 단어 속 지명 제외, 테스트 추가
- **문제** — 메모리 검색에서 지역·인원 없는 질문이 파일 순서대로 가산 / 해결: 0점 문서 제외, 테스트 추가
- **문제** — 채점기 오탐(JSON 숫자·최소 주문액·사례 ID 표기) / 해결: 근거 집합 보강·ID 정규화, 수정 전후 수치 기록
- **문제** — RAG가 숫자는 근거에 있지만 엉뚱한 사례 금액을 붙임(150개 질문에 100개 사례 합계) / 원인: 숫자 대조 검증의 한계 / 해결(다음): 현재 견적은 엔진 결과만, 과거 금액은 수량과 묶어서만
- **문제** — Haiku 5.5 답이 문장 중간에서 잘림(2/27) / 원인: `api/chat.js:360`이 Sonnet 5.5가 아니면 `max_tokens 1024`, Haiku 5.5는 생각이 기본으로 켜져 한도를 먹음 / 해결: 임시 사본에서 4096으로 바꿔 잘림 0 확인. 운영 코드 수정은 Haiku 교체 PR에서
- **문제** — winget Ollama 다운로드 0바이트 정지 / 해결: GitHub 공식 설치 파일 직접 받기 + 서명 확인

## 결정 사항
- 손님용 챗봇은 Claude 유지(로컬 전환 보류), 직원용 상담 도우미부터 로컬 4b + RAG
- 파인튜닝 미실행(지시대로), RAG 우선
- 실제 상담 데이터(원본·익명본) 미사용, 가짜 샘플 12건으로 PoC

## 사용자 결정 필요
1. 익명본 상담 1,290대화를 로컬 파이프라인(외부 전송 없음)에 써도 되는지 — 시험 세션은 "반출 금지", 개발 세션은 "익명본 사용 권장"으로 의견이 다름
2. Anthropic 콘솔 청구서 확인(운영·시험·개발 키별) — "비용이 높다"의 출처 확정
3. 직원용 도우미를 돌릴 상시 PC(이 개발 PC를 쓸지)
4. 요청서의 Java/Spring Boot 백엔드가 다른 저장소에 있는지
5. 견적서 Excel 6개를 구조 매핑용으로 열어 봐도 되는지(로컬 처리만), xlsb용 패키지 설치 여부

## 다음 작업 우선순위
1. ~~같은 24문항 Claude 실행~~ — 11-20 완료(Sonnet·Haiku)
2. ~~Haiku 5.5 여러 턴 확인~~ — 11-23 완료(MODEL_EVALUATION 5.7): Sonnet과 거의 같은 품질, 턴당 약 1/11~1/12. 남은 것: chatbot-developer가 `CHAT_MODEL=claude-haiku-5-5` + `max_tokens` 4096 + 도구 반복 한도 4 교체 PR → 바꾼 코드로 회귀 59대화 재확인 → 사용자 머지
3. `PRICE` 캐시 단가 정정 — chatbot-developer가 PR #23(`fix/sonnet55-cache-read-price` → dev, OPEN) 올림 → 사용자 리뷰·머지
4. RAG 개선: 파라미터가 뽑히면 항상 엔진 호출, 과거 금액은 수량과 묶어 표시 → 8문항 재평가
5. 승인 시 익명본 적재 → 무작위 50건 사람 확인
6. 직원용 도우미 화면 설계 → persona-test(대표·실무자·신입 시선)
7. 로컬 모델 시험 반복(temperature 0 또는 3회 평균)으로 도구 호출률 안정 수치

## 정리할 것
- 로컬 pgvector 컨테이너: 필요 없으면 `docker compose -f ai-research/docker-compose.yml down`(볼륨까지 지우려면 `-v`, 가짜 데이터뿐)
- Ollama 모델 3개(약 10.5GB): 계속 쓸 계획이 없으면 `ollama rm <모델>`
