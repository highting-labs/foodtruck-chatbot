-- 사내 상담 도우미 RAG 저장 구조 (PoC). 임베딩 차원은 qwen3-embedding:0.6b = 1024.
CREATE EXTENSION IF NOT EXISTS vector;

-- 상담 단위(익명화 후). 원본은 저장하지 않음 — source_file은 파일 이름만.
CREATE TABLE IF NOT EXISTS consult_case (
  case_id      text PRIMARY KEY,
  source_file  text NOT NULL,
  event_date   date,
  region       text,
  event_type   text,
  truck_types  text[] DEFAULT '{}',
  people       int,
  menus        text[] DEFAULT '{}',
  requests     text[] DEFAULT '{}',
  quote_total  int,
  price_status text NOT NULL CHECK (price_status IN ('confirmed','quoted','negotiating','no_price')),
  outcome      text,
  issues       text[] DEFAULT '{}',
  body         text NOT NULL,                        -- 익명화된 대화(검색·근거 표시용)
  embedding    vector(1024),
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(region,'') || ' ' || coalesce(event_type,'') || ' ' || body)) STORED,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consult_case_hnsw ON consult_case USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS consult_case_tsv  ON consult_case USING gin (tsv);
CREATE INDEX IF NOT EXISTS consult_case_meta ON consult_case (region, price_status);

-- 확정 견적만 따로(가격 근거로 쓸 수 있는 것). quoted/negotiating은 여기 넣지 않음.
CREATE OR REPLACE VIEW confirmed_quote AS
  SELECT case_id, event_date, region, people, menus, quote_total FROM consult_case WHERE price_status = 'confirmed' AND quote_total IS NOT NULL;
