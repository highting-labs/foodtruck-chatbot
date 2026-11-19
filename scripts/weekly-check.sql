-- 운영 주간 점검 (완성 기준 1·2·4·5·8의 "운영 점검 0건" 확인용) — 읽기 전용, 보드 DB chat_logs만 조회
-- 돌리는 법: Supabase SQL 편집기(직원 계정) 또는 Claude의 Supabase 도구로 그대로 실행. 기간은 아래 since 한 줄만 바꿈
-- 결과는 점검 항목별 1줄 + 걸린 대화 id. 손님 글은 내보내지 않음(걸린 대화는 보드 상담 기록 화면에서 직접 확인)
with p as (select now() - interval '7 days' as since),
logs as (
  select l.* from chat_logs l, p where l.created_at >= p.since
),
-- 한 번의 요청에서 손님 말과 봇 답은 같은 시각으로 들어감 → 짝지음
pairs as (
  select a.session_id, a.created_at, a.content as reply, a.meta, coalesce(u.content, '') as utext
  from logs a left join logs u on u.session_id = a.session_id and u.created_at = a.created_at and u.role = 'user'
  where a.role = 'assistant'
),
tools as (
  select pr.session_id, pr.created_at, pr.reply, t
  from pairs pr, jsonb_array_elements(case when jsonb_typeof(pr.meta->'tools') = 'array' then pr.meta->'tools' else '[]'::jsonb end) t
),
won as (   -- 계산기 금액이 답에 그대로 있는지(1,234,000 모양)
  select session_id, created_at, reply,
    case when t->>'mode' = 'range'
      then array[to_char(round((t->>'rangeLow')::numeric), 'FM999,999,999,999'), to_char(round((t->>'rangeHigh')::numeric), 'FM999,999,999,999')]
      else array[to_char(round((t->>'subtotal')::numeric), 'FM999,999,999,999')] end as nums
  from tools where t->>'name' = 'calculate_quote' and t->>'status' = 'ok'
),
phone_first as (   -- 대화에서 손님이 처음 번호를 준 시각
  select session_id, min(created_at) as at from logs
  where role = 'user' and content ~ '01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}' group by session_id
),
checks as (
  -- 1 금액 오류: 마지막 계산 금액이 답에 없음(같은 답에서 여러 번 계산하면 하나라도 빠지면 걸림 → 사람이 확인)
  select '1 금액 누락(계산 금액이 답에 없음)' as item, session_id from won
  -- "1,000,000원"과 "100만 원" 두 모양 모두 인정(만 원 단위로 떨어질 때만)
  where not (select bool_and(position(n in reply) > 0
      or (replace(n, ',', '')::numeric % 10000 = 0 and position((replace(n, ',', '')::numeric / 10000)::bigint::text || '만' in reply) > 0))
    from unnest(nums) n)
  union all
  -- 2 번호를 줬는데 그 뒤로 접수가 없음
  select '2 번호 받고 미접수', f.session_id from phone_first f
  where not exists (select 1 from pairs pr where pr.session_id = f.session_id and pr.created_at >= f.at and pr.meta->>'lead' = 'true')
  union all
  -- 2 접수는 됐는데 담당자 문자 발송 실패(submit_lead 상태 received = 문자 실패, 시트·보드에는 남음)
  select '2 접수 문자 발송 실패', session_id from tools
  where t->>'name' = 'submit_lead' and t->>'status' = 'received'
  union all
  -- 4 손님이 전화·연락 문제·번호 거부·삭제·회사 번호를 말하지 않았는데 대표번호 안내
  select '4 원치 않은 대표번호', session_id from pairs
  where reply ~ '1877-6901'
    and utext !~ '전화|통화|연락\s?(이|을|도)?\s?(안|없|못|주)|급(해|하|한|히)|번호.{0,8}(싫|안\s?남|못\s?남|말고|부담)|남기기\s?(싫|어렵|부담)|삭제|지워|대표\s?번호|사무실\s?번호|고객\s?센터|(연락처|번호)\s?(좀|뭐|알려|어떻게|있)'
  union all
  -- 5 번호 받기 전에 연락처를 2번 넘게 물음(진행 의사·전화 요청 뒤 요청도 걸리니 사람이 확인)
  select '5 연락처 2번 넘게 요청', pr.session_id from pairs pr left join phone_first f on f.session_id = pr.session_id
  where (f.at is null or pr.created_at < f.at)
    and pr.reply ~ '연락처|휴대폰\s?번호|핸드폰\s?번호|전화\s?번호|번호를?\s?남겨|남겨\s?주신\s?번호|남겨\s?주(시면|세요|시겠).{0,12}(접수|연락)'
  group by pr.session_id having count(*) >= 2
  union all
  -- 8 사진 빼고 800자 넘는 답
  select '8 800자 넘는 답', session_id from pairs
  where length(regexp_replace(reply, '!\[[^\]]*\]\([^)]*\)', '', 'g')) > 800
),
summary as (
  select '0 대화 수 / 접수 대화 / 비용(달러)' as item,
    (select count(distinct session_id) from logs)::text || ' / ' ||
    (select count(distinct session_id) from pairs where meta->>'lead' = 'true')::text || ' / ' ||
    coalesce((select round(sum((meta->'usage'->>'usd')::numeric), 2) from pairs), 0)::text as n,
    null::text as sessions
)
select item, n, sessions from summary
union all
select item, count(*)::text, string_agg(distinct session_id, ', ') from checks group by item
order by item;
