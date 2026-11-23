"""pgvector 적재·검색 (PoC). 파이썬 DB 패키지 없이 docker exec psql로 SQL을 보낸다.
  python -I -X utf8 ai-research/rag/store_pg.py load <pipeline 출력 폴더>     # cases.jsonl + index.json → consult_case
  python -I -X utf8 ai-research/rag/store_pg.py search "질문"                 # 벡터 + 전문검색 RRF
로컬 컨테이너(ftc-ai-poc-pgvector-1)만 대상. 운영 DB 접속 정보는 쓰지 않는다.
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rag as R

CONTAINER = os.environ.get('PG_CONTAINER', 'ftc-ai-poc-pgvector-1')


def psql(sql):
    p = subprocess.run(['docker', 'exec', '-i', CONTAINER, 'psql', '-U', 'poc', '-d', 'ftc_rag', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'],
                       input=sql, capture_output=True, text=True, encoding='utf-8')
    if p.returncode:
        raise RuntimeError(p.stderr[-500:])
    return p.stdout


def lit(s):
    return 'NULL' if s is None else "'" + str(s).replace("'", "''") + "'"


def arr(xs):
    return "ARRAY[" + ','.join(lit(x) for x in xs) + "]::text[]" if xs else "'{}'::text[]"


def load(folder):
    cases = R.load_jsonl(os.path.join(folder, 'cases.jsonl'))
    idx = json.load(open(os.path.join(folder, 'index.json'), encoding='utf-8'))
    vec = dict(zip(idx['case_ids'], idx['vectors']))
    rows = []
    for c in cases:
        v = '[' + ','.join(f'{x:.6f}' for x in vec[c['case_id']]) + ']'
        rows.append(f"({lit(c['case_id'])},{lit(c['case_id'].rsplit('-', 1)[0])},{lit(c['event_date'])},{lit(c['region'])},{lit(c['event_type'])},"
                    f"{arr(c['truck_types'])},{c['people'] or 'NULL'},{arr(c['menus'])},{arr(c['requests'])},{c['quote_total'] or 'NULL'},"
                    f"{lit(c['price_status'])},{lit(c['outcome'])},{arr(c['issues'])},{lit(R.case_doc(c))},'{v}')")
    sql = ("BEGIN;\nINSERT INTO consult_case (case_id,source_file,event_date,region,event_type,truck_types,people,menus,requests,quote_total,"
           "price_status,outcome,issues,body,embedding) VALUES\n" + ',\n'.join(rows) +
           "\nON CONFLICT (case_id) DO UPDATE SET body=EXCLUDED.body, embedding=EXCLUDED.embedding, price_status=EXCLUDED.price_status, quote_total=EXCLUDED.quote_total;\nCOMMIT;\n"
           "SELECT count(*), count(*) FILTER (WHERE price_status='confirmed') FROM consult_case;")
    return psql(sql).strip()


def search(q, k=3):
    qv = '[' + ','.join(f'{x:.6f}' for x in R.embed([q])[0]) + ']'
    words = ' | '.join(w for w in R.tokens(q) if len(w) >= 2) or 'x'
    sql = f"""
WITH v AS (SELECT case_id, row_number() OVER (ORDER BY embedding <=> '{qv}') r FROM consult_case ORDER BY embedding <=> '{qv}' LIMIT 20),
     t AS (SELECT case_id, row_number() OVER (ORDER BY ts_rank(tsv, to_tsquery('simple', {lit(words)})) DESC) r
           FROM consult_case WHERE tsv @@ to_tsquery('simple', {lit(words)}) LIMIT 20)
SELECT c.case_id, c.region, c.people, c.quote_total, c.price_status,
       round((coalesce(1.0/(60+v.r),0) + coalesce(1.0/(60+t.r),0))::numeric, 5) AS rrf
FROM consult_case c LEFT JOIN v USING (case_id) LEFT JOIN t USING (case_id)
WHERE v.r IS NOT NULL OR t.r IS NOT NULL
ORDER BY rrf DESC LIMIT {k};"""
    return [l.split('\t') for l in psql(sql).strip().splitlines()]


if __name__ == '__main__':
    if sys.argv[1] == 'load':
        print('rows, confirmed =', load(sys.argv[2]))
    else:
        for r in search(sys.argv[2]):
            print(r)
