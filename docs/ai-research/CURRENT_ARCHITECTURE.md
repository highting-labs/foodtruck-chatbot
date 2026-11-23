# 1. 현재 챗봇 구조 및 Claude API 사용 분석

- 작성: 2026-11-19 · 기준 코드: `origin/dev` 8f1facb (= 운영 main 42db70e와 같은 코드)
- 방법: 코드 직접 읽기 + chatbot-developer·chatbot-tester 세션 확인 + 시험 기록 417대화 집계
- 코드 변경 없음(읽기 전용 분석)

## 1.1 요청서 전제와 다른 점 (먼저 확인 필요)

| 요청서 전제 | 실제 | 영향 |
|---|---|---|
| 기존 백엔드 Java 21 / Spring Boot | **Vercel 서버리스 함수(Node.js, 외부 패키지 0개)** `api/*.js` + `lib/*.js` | 로컬 LLM 연결은 Java가 아니라 `api/chat.js`의 LLM 호출부를 바꾸는 방식 |
| DB PostgreSQL / pgvector | **Supabase(Postgres)** — 행사 보드와 같은 운영 프로젝트 하나. 별도 테스트 DB 없음 | pgvector는 PoC에서 로컬 Docker로만 띄움. 운영 Supabase에는 손대지 않음 |
| 프론트엔드 | 빌드 없는 HTML/JS (`index.html`의 [대화 상담] 탭) | 변경 불필요 |

- Spring Boot 백엔드가 다른 저장소(예: 보드·CMS)에 있는지는 이 세션에서 확인 못 함 → **확인 필요 항목**으로 남김.

## 1.2 전체 흐름

```
손님 화면(index.html 대화 상담 탭) ── messages 배열 전체를 매번 POST
   │
   ▼
api/chat.js (Vercel 함수, 서버는 대화 상태를 저장하지 않음)
   ├─ 입력 정리: user/assistant 글자만, 최근 100개, 손님 말 2,000자·봇 6,000자 자름, 손님 말 40턴 초과 시 전화 안내
   ├─ 호출 횟수 제한 lib/rate-limit.js (1인 1분 10회·하루 150회, 전체 하루 2,000회 → 넘으면 AI 없이 안내)
   ├─ 메뉴판 lib/menu-source.js (보드 DB site_menus, 5분 캐시, 실패 시 lib/menu-snapshot.json)
   ├─ ★ Claude 호출 루프 (최대 3회, api/chat.js:350)
   │     POST https://api.anthropic.com/v1/messages (fetch 직접, SDK 없음)
   │     system = [지식 lib/knowledge.js] + [메뉴판 텍스트 + cache_control] + [오늘 날짜] + (접수됨 안내)
   │     tools  = calculate_quote, submit_lead
   │     ├─ calculate_quote → lib/quote-engine.js → lib/quote-calc.js (모든 금액은 여기서만)
   │     └─ submit_lead     → lib/lead-notify.js(문자) + lib/sheet-log.js(구글시트) + lib/capacity.js(날짜 여유)
   ├─ 답 후처리(모델과 무관한 서버 규칙): 중복 문장 제거, 연락처 반복 요청 제거, 진행 질문 붙이기,
   │     접수 뒤 견적 변경 시 자동 추가 접수, 접수 표시 줄, 음료 고르기 버튼
   └─ 대화 기록 lib/chat-log.js → 보드 DB chat_logs (RPC chat_log_add, CHAT_LOG_KEY 필요), 응답 후 waitUntil로 저장
```

## 1.3 Claude API 호출 지점과 설정

| 항목 | 값 | 위치 |
|---|---|---|
| 호출 지점 | 1곳(도구 루프 안에서 답 1개당 1~3회 호출) | `api/chat.js:351` |
| 모델 | `claude-sonnet-5-5` (환경변수 `CHAT_MODEL`, 11-10에 4.6에서 변경) | `api/chat.js:20` |
| max_tokens | Sonnet 5.5: 4096 / 그 외 1024 | `api/chat.js:360` |
| 생각(thinking) | `adaptive`, effort `low` (`CHAT_THINKING`·`CHAT_EFFORT`) | `api/chat.js:22-23` |
| 프롬프트 캐싱 | system 2번째 블록(메뉴판)에 `cache_control: ephemeral` → tools + 지식 + 메뉴판이 함께 캐시, 날짜·접수 안내는 캐시 뒤 | `api/chat.js:366` |
| 단가표(코드 기록) | Sonnet 5.5: 입력 $2 · 출력 $10 · 캐시 쓰기 $2.5 · 캐시 읽기 $0.20 (100만 토큰당) | `api/chat.js:25` |
| 사용량 기록 | 답마다 `usage{calls,input,output,cacheWrite,cacheRead,usd}` → 응답 JSON과 `chat_logs.meta.usage` | `api/chat.js:328, 527-530, 538` |

- 다른 Claude 호출: 없음(`api/notify.js`·`api/menu.js`는 LLM을 쓰지 않음).
- 단가표는 코드에 적힌 값 기준. 실제 청구 단가는 Anthropic 콘솔에서 확인 필요(저장소에 청구 자료 없음).

## 1.4 시스템 프롬프트와 컨텍스트 구성

| 구성 | 크기 | 비고 |
|---|---|---|
| 지식(`SYSTEM_KNOWLEDGE`, lib/knowledge.js) | 19,712자 | 절대 규칙·응대 규칙·FAQ·말투·접수 형식 11장 |
| 메뉴판 텍스트(`menuPromptText`) | 2,076자(스냅샷 기준) | 메뉴 약 100개·출장비·기타비용 |
| 도구 정의 2개 | 약 4,000자 | 입력 칸 설명이 길다 |
| 날짜·접수 안내 | 수십 자 | 캐시 밖 |
| 대화 내역 | 대화 길이만큼 | 서버가 매번 전체를 다시 보냄 |

- **실측 고정부 토큰: 1회 호출당 캐시 읽기 약 24,050토큰**(운영 1턴 예시, chatbot-developer 확인). 한국어 규칙 글이 길어 토큰이 많다.
- 도구를 부르면 같은 답 안에서 2~3회 호출 → 고정부를 2~3번 읽음(캐시라 1/10 가격).

## 1.5 질문 1회당 토큰·비용·속도 (측정치)

| 출처 | 표본 | 턴당 비용 | 턴당 응답 시간 | 대화당 비용 |
|---|---|---|---|---|
| 시험장 세션 집계(이 문서용, `sessions/*.json`) | 417대화 · 1,956턴 | 평균 **$0.0202** · 중앙 $0.0154 · p90 $0.0361 · 최대 $0.082 | 평균 **5.2초** · 중앙 4.6초 · p90 8.9초 | 평균 **$0.094** (평균 4.7턴) · p90 $0.158 |
| 운영 1턴 예시 | 1턴 | $0.009 (입력 109 · 출력 425 · 캐시 읽기 약 24,050) | - | - |
| 실제 상담 익명본 재생 | 80대화 | - | - | $0.074~0.086 |

- 시험장 수치에는 Sonnet 4.6 시기 대화가 일부 섞여 있고, 시험 손님은 일부러 까다롭게 만든 경우가 많아 **운영보다 약간 비싸게 나온 값**으로 본다.
- 응답 시간은 시험장 로컬 실행 기준(네트워크 왕복 포함). 운영 응답 시간은 따로 측정한 기록 없음.
- 월 사용량(대화 수)은 저장소에 없음 → 운영 `chat_logs` 건수 조회 필요(읽기 전용, 이번엔 운영 DB 접근 안 함).

## 1.6 대화 기록·데이터 저장 구조

| 저장소 | 내용 | 접근 |
|---|---|---|
| Supabase `chat_logs` | 세션 ID·역할·내용(6,000자까지)·meta(도구 입력·결과, usage) | 쓰기: RPC `chat_log_add` + `CHAT_LOG_KEY` / 읽기: 보드 로그인 직원 |
| Supabase `chat_rate_hit` | 호출 횟수 | rate-limit |
| Supabase `capacity_check`(함수) | 날짜별 직영 여유 단계만 반환 | capacity |
| Supabase `quote_menus`·`site_menus` | 메뉴·단가 원본(보드에서 수정) | menu-source |
| 구글시트(Apps Script) | 접수 리드 | sheet-log |
| 문자(Solapi) | 담당자 접수 알림 | lead-notify |

- 회사 데이터(학습·검색 후보) 위치
  - 카카오 채널 상담 원본 1,279개: `workspace\_backups\foodtruck-chatbot\2026-11-17_카카오채팅\` (실제 고객 정보 — **사용 금지**)
  - 익명본 1,290개: `workspace\foodtruck-chatbot-test\data\kakao-chats\` (시험장 밖 반출 금지 — chatbot-tester)
  - 견적서 엑셀: `Desktop\견적서 예시\` xlsx 5개 + xlsb 1개 (고객 정보 포함, 구조만 확인)

## 1.7 구현된 기능 / 미구현 기능

| 구분 | 내용 |
|---|---|
| 구현 | 대화형 견적 계산(확정가·범위·최소 미달·메뉴 후보), 메뉴·FAQ 안내, 상담 접수(문자·시트·보드), 접수 뒤 견적 변경 자동 전달, 연락처 1회 요청, 외국어 손님, 욕설 대응, 날짜 여유에 따른 응대 깊이, 음료 고르기 버튼, 호출 제한 |
| 미구현 | **과거 상담·견적 검색(RAG) 없음**, 직원용 상담 도우미 화면 없음, 답변 근거(출처) 표시 없음, 견적서 14칸 묶음 질문(설계 미승인), 슬랙 알림(브랜치 멈춤), 전화 갈래 금액 기준 |
| 진행 중(충돌 주의) | PR #21 `fix/manual-contact-phone-length`(api/chat.js·knowledge.js), PR #22 `chore/weekly-ops-check`, 로컬 `docs/chat-quote-collection-design`, `feat/slack-quote-alert` |

- 요청서의 목표 기능(유사 상담 검색, 과거 견적 검색, 출처 제공, 직원용 답변 초안)은 **지금 챗봇에 전부 없는 새 기능**이다. 지금 챗봇은 "손님용 견적 계산기 + 접수"다.

## 1.8 로컬 LLM을 연결할 수 있는 방법

1. **LLM 호출 어댑터 분리(권장, chatbot-developer 의견과 같음)**: `api/chat.js:350~440` 루프의 `fetch(api.anthropic.com)`를 `lib/llm.js`의 `complete({system, tools, messages}) → {text, toolCalls, usage}`로 빼고, `LLM_PROVIDER=anthropic|ollama`로 고름.
   - Anthropic 전용 요소(`input_schema`, `tool_use`/`tool_result` 블록, `cache_control`, thinking·effort, usage 이름)는 어댑터 안으로.
   - 견적 엔진·답 후처리는 모델과 무관해서 그대로 둠.
   - 이번 PoC의 `ai-research/eval/ollama-adapter.js`가 이 변환 규칙을 이미 구현·시험함(단위 테스트 6개 통과).
2. **Vercel에서 로컬 Ollama 호출 문제**: 서버리스 함수는 회사 PC의 `127.0.0.1`에 닿지 않음 → 사내 GPU 서버를 외부에 열어야 함(터널·인증·가용성 문제). 그래서 **손님용 챗봇의 즉시 전환보다, 사내에서만 쓰는 직원용 상담 도우미부터** 로컬 모델로 시작하는 것이 현실적(로드맵 참고).
3. **기능 분리(하이브리드)**: 견적 계산은 이미 프로그램 로직, 단순 FAQ는 캐시·로컬, 복잡한 대화는 Claude 유지.

## 1.9 확인이 필요한 것

- Spring Boot 백엔드가 있는 다른 저장소가 있는지(요청서 전제)
- 운영 월 대화 수·월 청구액(Anthropic 콘솔·`chat_logs` 건수) → 비용 분석의 실제 기준
- 익명본 상담 데이터를 로컬 PoC(외부 전송 없음)에 써도 되는지 사용자 승인
