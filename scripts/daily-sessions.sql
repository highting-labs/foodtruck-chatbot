-- 운영 점검용 대화 목록 (읽기 전용, 보드 DB chat_logs만 조회)
-- 기간은 since 한 줄만 바꿈(매일 점검 = 1 day, 주간 = 7 days). 손님 글은 내보내지 않음 — 원문이 필요한 대화만 id로 따로 읽음
with p as (select now() - interval '1 day' as since),
a as (
  select l.* from chat_logs l, p where l.created_at >= p.since and l.role = 'assistant'
)
select session_id,
  min(created_at) as first_at,
  count(*) as turns,
  bool_or(meta->>'lead' = 'true') as lead,
  bool_or(meta->>'fallback' = 'true') as fallback,                         -- 도구 반복 끝(오류 답)
  bool_or(content ~ '잠시 후 다시 시도') as error_reply,
  bool_or(exists (select 1 from jsonb_array_elements(case when jsonb_typeof(meta->'tools') = 'array' then meta->'tools' else '[]'::jsonb end) t
                  where t->>'name' = 'submit_lead' and t->>'status' = 'received')) as sms_failed,
  max(meta->'usage'->>'model') as model,
  round(sum(coalesce((meta->'usage'->>'usd')::numeric, 0)), 4) as usd,
  max(page) as page
from a
group by session_id
order by first_at;
