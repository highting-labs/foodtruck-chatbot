"""상담 도우미 RAG PoC (표준 라이브러리만, 로컬 Ollama 사용).

  python -I -X utf8 ai-research/rag/rag.py index <pipeline 출력 폴더>            # 임베딩 생성 → index.json
  python -I -X utf8 ai-research/rag/rag.py ask <폴더> "질문" [--model qwen3.5:4b]   # 검색 + 근거 답변(JSON)
  python -I -X utf8 ai-research/rag/rag.py eval <폴더> [--model ...] [--out 파일]   # rag_questions.json 전체

설계 원칙
- 검색: BM25(한글 2글자 묶음) + 벡터(코사인)를 RRF로 결합, 지역·인원 메타데이터는 가산점.
- 금액: LLM이 만들지 않는다. 현재 가격은 기존 견적 엔진(quote_bridge.js)으로 계산, 과거 금액은 검색된 사례에서만 인용.
- 검증: 답 안의 금액이 근거(사례·엔진 결과)에 없으면 hold=true로 보류.
"""
import argparse, json, math, os, re, subprocess, sys, time, urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OLLAMA = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
EMBED_MODEL = os.environ.get('EMBED_MODEL', 'qwen3-embedding:0.6b')


# ── Ollama 호출 ─────────────────────────────────────────────
def _post(path, body, timeout=600):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode('utf-8'), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def embed(texts):
    return _post('/api/embed', {'model': EMBED_MODEL, 'input': texts})['embeddings']


def chat_json(model, system, user, schema, think=False):
    t0 = time.time()
    o = _post('/api/chat', {'model': model, 'stream': False, 'think': think, 'format': schema, 'keep_alive': '30m',
                            'options': {'temperature': 0.2, 'num_ctx': 8192},
                            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]})
    txt = re.sub(r'<think>[\s\S]*?</think>', '', o.get('message', {}).get('content', '')).strip()
    try:
        data = json.loads(txt)
        ok = True
    except json.JSONDecodeError:
        data, ok = {'raw': txt}, False
    return data, {'sec': round(time.time() - t0, 2), 'json_ok': ok, 'in_tok': o.get('prompt_eval_count'), 'out_tok': o.get('eval_count')}


# ── 키워드 검색(BM25) ───────────────────────────────────────
def tokens(text):
    t = re.sub(r'[^0-9A-Za-z가-힣]+', ' ', str(text).lower())
    out = []
    for w in t.split():
        out.append(w)
        if re.search(r'[가-힣]', w) and len(w) > 2:
            out.extend(w[i:i + 2] for i in range(len(w) - 1))
    return out


class BM25:
    def __init__(self, docs, k1=1.4, b=0.75):
        self.docs = [Counter(tokens(d)) for d in docs]
        self.len = [sum(d.values()) for d in self.docs]
        self.avg = sum(self.len) / max(1, len(self.len))
        df = Counter(t for d in self.docs for t in d)
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        self.k1, self.b = k1, b

    def scores(self, q):
        qt = tokens(q)
        res = []
        for d, L in zip(self.docs, self.len):
            s = 0.0
            for t in qt:
                if t in d:
                    f = d[t]
                    s += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * L / self.avg))
            res.append(s)
        return res


def cosine(a, b):
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0


def rrf(rank_lists, k=60):
    """여러 순위를 합친다(Reciprocal Rank Fusion): 점수 크기가 달라도 순위만으로 공정하게 섞임."""
    s = Counter()
    for ranks in rank_lists:
        for r, idx in enumerate(ranks):
            s[idx] += 1.0 / (k + r + 1)
    return [i for i, _ in s.most_common()]


# ── 인덱스 ─────────────────────────────────────────────────
def load_jsonl(p):
    with open(p, encoding='utf-8') as f:
        return [json.loads(l) for l in f if l.strip()]


def case_doc(c):
    """검색용 문서 = 요약 필드 + 대화 본문(익명화된 것)."""
    head = ' '.join(str(x) for x in [c.get('event_type'), c.get('region'), c.get('people') and f"{c['people']}명", ' '.join(c.get('truck_types', [])), ' '.join(c.get('menus', [])), ' '.join(c.get('requests', []))] if x)
    return head + '\n고객: ' + c['customer_text'] + '\n직원: ' + c['staff_text']


def build_index(folder):
    cases = load_jsonl(os.path.join(folder, 'cases.jsonl'))
    docs = [case_doc(c) for c in cases]
    t0 = time.time()
    vecs = embed(docs)
    idx = {'embed_model': EMBED_MODEL, 'dim': len(vecs[0]), 'case_ids': [c['case_id'] for c in cases], 'vectors': vecs, 'embed_sec': round(time.time() - t0, 2)}
    with open(os.path.join(folder, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(idx, f)
    return {'cases': len(cases), 'dim': idx['dim'], 'embed_sec': idx['embed_sec']}


QREGION = re.compile(r'(서울|판교|성남|수원|화성|동탄|평택|인천|송도|부산|해운대|대전|대구|광주|춘천|강원|노원|여의도|강남|분당|용인)')
QPEOPLE = re.compile(r'(\d{2,5})\s*(명|인분|잔|개)')


def search(folder, q, k=3, use_vector=True):
    cases = load_jsonl(os.path.join(folder, 'cases.jsonl'))
    docs = [case_doc(c) for c in cases]
    lists = []
    bm = BM25(docs).scores(q)
    lists.append(sorted((i for i in range(len(docs)) if bm[i] > 0), key=lambda i: -bm[i]))   # 0점 문서는 순위에 넣지 않음
    vs = None
    if use_vector:
        idx = json.load(open(os.path.join(folder, 'index.json'), encoding='utf-8'))
        qv = embed([q])[0]
        vs = [cosine(qv, v) for v in idx['vectors']]
        lists.append(sorted(range(len(docs)), key=lambda i: -vs[i]))
    # 메타데이터 순위: 같은 지역, 비슷한 인원(±40%)
    reg = QREGION.search(q); ppl = QPEOPLE.search(q)
    def meta(i):
        c = cases[i]; s = 0
        if reg and c.get('region') and (reg.group(1) in c['region'] or c['region'] in reg.group(1)): s += 1
        if ppl and c.get('people') and abs(c['people'] - int(ppl.group(1))) <= 0.4 * int(ppl.group(1)): s += 1
        return s
    # 질문에 지역·인원이 없으면 전부 0점 → 원래 파일 순서가 가산되던 버그(11-19 발견). 맞는 문서만 넣음
    lists.append(sorted((i for i in range(len(docs)) if meta(i) > 0), key=lambda i: -meta(i)))
    order = rrf(lists)[:k]
    return [{'case_id': cases[i]['case_id'], 'bm25': round(bm[i], 3), 'cos': round(vs[i], 3) if vs else None, 'case': cases[i]} for i in order]


# ── 현재 견적(기존 엔진) ────────────────────────────────────
def current_quote(params):
    if not params or not params.get('items') or not params.get('region'):
        return None
    p = subprocess.run(['node', os.path.join(HERE, 'quote_bridge.js')], input=json.dumps(params, ensure_ascii=False),
                       capture_output=True, text=True, encoding='utf-8', timeout=30)
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {'status': 'error', 'error': p.stderr[-300:]}


PARAM_SCHEMA = {'type': 'object', 'properties': {
    'has_quote_request': {'type': 'boolean'},
    'items': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'servings': {'type': 'number'}}, 'required': ['name', 'servings']}},
    'region': {'type': 'string'}}, 'required': ['has_quote_request', 'items', 'region']}

ANSWER_SCHEMA = {'type': 'object', 'properties': {
    'recommended_reply': {'type': 'string'},
    'referenced_cases': {'type': 'array', 'items': {'type': 'string'}},
    'referenced_quotes': {'type': 'array', 'items': {'type': 'string'}},
    'need_to_confirm': {'type': 'array', 'items': {'type': 'string'}},
    'hold': {'type': 'boolean'},
    'hold_reason': {'type': 'string'}},
    'required': ['recommended_reply', 'referenced_cases', 'referenced_quotes', 'need_to_confirm', 'hold', 'hold_reason']}

SYSTEM = """당신은 푸드트럭하우스 직원을 돕는 상담 도우미입니다. 고객에게 직접 보내지 않고 직원이 확인 후 사용합니다.
규칙:
1. 금액은 [현재 견적 계산 결과]나 [과거 사례]에 적힌 숫자만 씁니다. 새 금액·할인율·정책을 지어내지 않습니다.
2. 과거 사례 금액은 '과거 사례(사례 ID) 기준'이라고 밝히고, price_status가 confirmed가 아니면 '확정 아님'이라고 씁니다.
3. 근거가 부족하면 hold=true, hold_reason에 이유를 쓰고 need_to_confirm에 직원이 확인할 것을 적습니다.
4. referenced_cases에는 실제로 참고한 사례 ID만 넣습니다.
5. 한국어로 담백하고 짧게(5문장 이내) 씁니다."""


def answer(folder, q, model, k=3):
    hits = search(folder, q, k=k)
    params, pmeta = chat_json(model, '고객 문의에서 견적 계산에 필요한 메뉴·인분·지역만 뽑습니다. 메뉴판 이름이 확실하지 않으면 손님 말 그대로 씁니다. 모르면 빈 값.', q, PARAM_SCHEMA)
    quote = current_quote(params) if params.get('has_quote_request') else None
    ctx = []
    for h in hits:
        c = h['case']
        ctx.append(f"- 사례 {c['case_id']}: {c.get('event_type') or '-'} / {c.get('region') or '-'} / {c.get('people') or '-'}명 / 메뉴 {', '.join(c['menus']) or '-'} / "
                   f"합계 {c['quote_total'] and format(c['quote_total'], ',') + '원' or '-'} / price_status={c['price_status']} / 요청 {', '.join(c['requests']) or '-'}\n  대화 요약: {c['staff_text'][:220]}")
    qtxt = '없음'
    if quote and quote.get('status') == 'ok':
        qtxt = json.dumps({k: quote.get(k) for k in ('summaryLine', 'subtotal', 'rangeLow', 'rangeHigh', 'items', 'costs', 'notes') if quote.get(k) is not None}, ensure_ascii=False)[:1500]
    elif quote:
        qtxt = f"계산 안 됨({quote.get('status')}: {quote.get('message') or quote.get('error') or ''})"
    user = f"[고객 문의]\n{q}\n\n[현재 견적 계산 결과]\n{qtxt}\n\n[과거 사례]\n" + '\n'.join(ctx)
    data, ameta = chat_json(model, SYSTEM, user, ANSWER_SCHEMA)
    # 검증: 답 안의 금액(1만 원 이상)이 근거에 있는지
    evidence = user
    ev_nums = {int(x.replace(',', '')) for x in re.findall(r'\d{1,3}(?:,\d{3})+|\d{4,}', evidence)}
    reply = data.get('recommended_reply', '') if isinstance(data, dict) else ''
    nums = [int(x.replace(',', '')) for x in re.findall(r'\d{1,3}(?:,\d{3})+', reply)]
    nums += [int(m) * 10000 for m in re.findall(r'(\d+)\s*만\s*원', reply)]
    unsupported = sorted({n for n in nums if n >= 10000 and n not in ev_nums})
    # 모델이 ID를 "사례 대화_S001-0" / "S001-0"처럼 조금씩 다르게 써서 핵심(S001-0)만 비교(11-19 오탐 수정)
    core = lambda s: (re.search(r'S\d{3}-\d+', str(s)) or re.search(r'.*', str(s))).group(0)
    hit_ids = {core(h['case_id']) for h in hits}
    bad_ids = [i for i in (data.get('referenced_cases') or []) if core(i) not in hit_ids] if isinstance(data, dict) else []
    guard = {'unsupported_amounts': unsupported, 'unknown_case_ids': bad_ids}
    if unsupported or bad_ids:
        data['hold'] = True
        data['hold_reason'] = (data.get('hold_reason') or '') + f" [자동 보류: 근거 없는 금액 {unsupported} / 없는 사례 {bad_ids}]"
    return {'question': q, 'model': model, 'hits': [{k: h[k] for k in ('case_id', 'bm25', 'cos')} for h in hits], 'params': params,
            'quote_status': quote and quote.get('status'), 'quote_subtotal': quote and quote.get('subtotal'), 'answer': data,
            'guard': guard, 'meta': {'param': pmeta, 'answer': ameta, 'sec': round(pmeta['sec'] + ameta['sec'], 2)}}


def run_eval(folder, model, out):
    qs = json.load(open(os.path.join(HERE, 'rag_questions.json'), encoding='utf-8'))['cases']
    res = []
    for c in qs:
        r = answer(folder, c['q'], model)
        top = [h['case_id'] for h in r['hits']]
        a = r['answer'] if isinstance(r['answer'], dict) else {}
        sc = {
            'retrieval_hit': any(e in top for e in c['expect_cases']) if c['expect_cases'] else None,
            'hold_ok': (a.get('hold') is True) == c['expect_hold'] if 'expect_hold' in c else None,
            'json_ok': r['meta']['answer']['json_ok'],
            'no_unsupported_amount': not r['guard']['unsupported_amounts'],
            'sec': r['meta']['sec'],
        }
        res.append({'id': c['id'], 'type': c['type'], 'score': sc, **r})
        print(c['id'], c['type'], 'hit=', sc['retrieval_hit'], 'hold_ok=', sc['hold_ok'], 'json=', sc['json_ok'], 'amt_ok=', sc['no_unsupported_amount'], f"{sc['sec']}s", top)
    if out:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        json.dump({'model': model, 'embed_model': EMBED_MODEL, 'results': res}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    hit = [r for r in res if r['score']['retrieval_hit'] is not None]
    hold = [r for r in res if r['score']['hold_ok'] is not None]
    print(f"\n{model}: 검색 적중 {sum(r['score']['retrieval_hit'] for r in hit)}/{len(hit)}, 보류 판단 {sum(r['score']['hold_ok'] for r in hold)}/{len(hold)}, "
          f"JSON {sum(r['score']['json_ok'] for r in res)}/{len(res)}, 근거 없는 금액 없음 {sum(r['score']['no_unsupported_amount'] for r in res)}/{len(res)}, 평균 {sum(r['score']['sec'] for r in res) / len(res):.1f}초")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['index', 'ask', 'eval', 'search'])
    ap.add_argument('folder')
    ap.add_argument('q', nargs='?')
    ap.add_argument('--model', default='qwen3.5:4b')
    ap.add_argument('--out')
    a = ap.parse_args()
    if a.cmd == 'index':
        print(build_index(a.folder))
    elif a.cmd == 'search':
        for h in search(a.folder, a.q, use_vector=os.path.exists(os.path.join(a.folder, 'index.json'))):
            print(h['case_id'], h['bm25'], h['cos'])
    elif a.cmd == 'ask':
        print(json.dumps(answer(a.folder, a.q, a.model), ensure_ascii=False, indent=2))
    else:
        run_eval(a.folder, a.model, a.out)
