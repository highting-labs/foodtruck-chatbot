"""상담 데이터 정제 파이프라인 (PoC, 표준 라이브러리만).

원본 CSV → 텍스트 추출 → 익명화 → 상담 단위 분리 → 행사·견적 정보 추출 → 검증 → cases.jsonl / chunks.jsonl
- 원본 파일은 읽기만 한다(쓰기 없음). 결과는 --out 폴더에만 쓴다.
- 금액은 '확정' 근거(직원 말의 확정·접수·입금 확인 등)가 있을 때만 confirmed, 아니면 quoted/negotiating.

python -I ai-research/rag/pipeline.py <CSV 폴더> --out <출력 폴더> [--menu lib/menu-snapshot.json]
"""
import argparse, csv, glob, json, os, re
from datetime import datetime

STAFF_PREFIX = '푸드트럭하우스'

# ── 1. 익명화 ────────────────────────────────────────────────
PHONE = re.compile(r'(?<!\d)(01[016789]|0\d{1,2})[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)')
EMAIL = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+')
ACCOUNT = re.compile(r'(?<!\d)\d{2,6}-\d{2,6}-\d{2,7}(?!\d)')       # 계좌·사업자번호 모양
BIZNO = re.compile(r'(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)')
ADDR_NO = re.compile(r'([가-힣]+(로|길))\s?\d+(-\d+)?')               # 도로명 번지
REP_PHONE = '1877-6901'                                               # 회사 대표번호는 남김


def anonymize(text, names=()):
    t = str(text)
    keep = t.count(REP_PHONE)
    t = t.replace(REP_PHONE, '\x00REP\x00')
    t = EMAIL.sub('user@example.com', t)
    t = BIZNO.sub('000-00-00000', t)
    t = PHONE.sub('\x00PH\x00', t)          # 치환값이 계좌 규칙에 다시 걸리지 않게 자리표시 후 복원
    t = ACCOUNT.sub('000-000-000', t)
    t = t.replace('\x00PH\x00', '010-0000-0000')
    t = ADDR_NO.sub(lambda m: m.group(1) + ' 00', t)
    for n in sorted({n for n in names if n and len(n) >= 2}, key=len, reverse=True):
        t = t.replace(n, '○○○')
    t = t.replace('\x00REP\x00', REP_PHONE)
    assert t.count(REP_PHONE) == keep
    return t


def customer_names(user_field):
    """'가나전자 김민준' → ['가나전자 김민준', '김민준'] (회사명은 검색에 필요해 남기고 사람 이름만 가림)"""
    u = str(user_field or '').strip()
    parts = u.split()
    out = [u] if len(parts) > 1 else []
    if parts and re.fullmatch(r'[가-힣]{2,4}', parts[-1]):
        out.append(parts[-1])
    return out


# ── 2. 불러오기·상담 단위 분리 ────────────────────────────────
def load_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if (r.get('MESSAGE') or '').strip()]
    return rows


def parse_dt(s):
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y. %m. %d. %H:%M', '%Y-%m-%d'):
        try:
            return datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            pass
    return None


def split_sessions(rows, gap_days=3):
    """한 대화방 안에서 3일 넘게 끊기면 다른 상담으로 본다."""
    sessions, cur, last = [], [], None
    for r in rows:
        dt = parse_dt(r.get('DATE'))
        if cur and dt and last and (dt - last).days > gap_days:
            sessions.append(cur); cur = []
        cur.append(r)
        last = dt or last
    if cur:
        sessions.append(cur)
    return sessions


# ── 3. 정보 추출(규칙 기반) ─────────────────────────────────
REGIONS = ['서울', '판교', '성남', '수원', '화성', '동탄', '평택', '인천', '송도', '부산', '해운대', '대전', '유성', '대구', '광주', '울산',
           '춘천', '강원', '제주', '천안', '아산', '청주', '전주', '노원', '여의도', '강남', '분당', '용인', '고양', '파주', '세종']
EVENT_TYPES = {'창립': '창립기념', '체육대회': '체육대회', '축제': '축제', '워크숍': '워크숍', '송년': '송년회', '연말': '송년회',
               '안전기원': '안전기원제', '간호사의 날': '기념일 행사', '학교': '학교 행사', '시민': '지역 축제'}
TRUCK_KW = {'커피': '커피·음료', '음료': '커피·음료', '빙수': '빙수·아이스크림', '아이스크림': '빙수·아이스크림', '분식': '분식', '떡볶이': '분식',
            '어묵': '분식', '덮밥': '식사', '뷔페': '출장뷔페', '호떡': '겨울간식', '붕어빵': '겨울간식', '핫도그': '간식', '츄러스': '간식', '솜사탕': '디저트',
            '마카롱': '디저트', '탕후루': '메뉴판 밖'}
WON = re.compile(r'(\d{1,3}(?:,\d{3})+|\d+)\s*(만\s*)?원')
TOTAL = re.compile(r'(총|합계|=)\s*(\d{1,3}(?:,\d{3})+)\s*원')
PEOPLE = re.compile(r'(\d{2,5})\s*(명|인분|잔|개)')
DATE = re.compile(r'(\d{1,2})\s*월\s*(\d{1,2})\s*일')
CONFIRM_STAFF = re.compile(r'확정|접수했|입금.{0,4}확인|확인했습니다')
CONFIRM_CUST = re.compile(r'진행(할게|합니다|확정)|확정합니다|입금했')
NEGOTIATE = re.compile(r'대략|예상|정도|협의|조정|확정 금액은 아닙|다시 (드릴|연락)|선인데')


def find_region(text):
    """가장 먼저 나온 지역명. '연수원' 속 '수원' 같은 단어 속 지명은 뺀다."""
    t = re.sub(r'연수원|수원지', '', str(text))
    hits = [(t.find(r), r) for r in REGIONS if r in t]
    return min(hits)[1] if hits else None


def to_won(num, man):
    n = int(num.replace(',', ''))
    return n * 10000 if man else n


def extract_case(msgs, menu_names):
    """msgs: [{'role':'customer'|'staff','text':..,'date':..}] (익명화된 것)"""
    cust = ' '.join(m['text'] for m in msgs if m['role'] == 'customer')
    staff = ' '.join(m['text'] for m in msgs if m['role'] == 'staff')
    allt = cust + ' ' + staff
    first = parse_dt(msgs[0]['date']) if msgs else None
    d = DATE.search(cust) or DATE.search(staff)
    event_date = None
    if d and first:
        y = first.year + (1 if int(d.group(1)) < first.month - 1 else 0)
        event_date = f'{y:04d}-{int(d.group(1)):02d}-{int(d.group(2)):02d}'
    people = [int(m.group(1)) for m in PEOPLE.finditer(cust)]
    flat = allt.replace(' ', '')
    menus = sorted({n for n in menu_names if any(len(k) >= 2 and k in flat for k in {n.replace(' ', ''), n.split('(')[0].replace(' ', '')})})
    totals = [to_won(m.group(2), None) for m in TOTAL.finditer(staff)]
    amounts = [to_won(a, m) for a, m in WON.findall(staff)]
    staff_msgs = [m['text'] for m in msgs if m['role'] == 'staff']
    last_staff_total = None
    for t in reversed(staff_msgs):
        mm = list(TOTAL.finditer(t))
        if mm:
            last_staff_total = (to_won(mm[-1].group(2), None), t)
            break
    confirmed = bool(CONFIRM_STAFF.search(staff) or CONFIRM_CUST.search(cust))
    negotiating = bool(NEGOTIATE.search(staff)) or '조정' in cust or '빠듯' in cust
    if last_staff_total and confirmed and not NEGOTIATE.search(last_staff_total[1]):
        status = 'confirmed'
    elif last_staff_total or amounts:
        status = 'negotiating' if negotiating else 'quoted'
    else:
        status = 'no_price'
    return {
        'event_date': event_date,
        'region': find_region(cust) or find_region(staff),
        'event_type': next((v for k, v in EVENT_TYPES.items() if k in allt), None),
        'truck_types': sorted({v for k, v in TRUCK_KW.items() if k in allt}),
        'people': max(people) if people else None,
        'menus': menus,
        'requests': [k for k in ('전기', '발전기', '현수막', '허가', '실내', '할인', '여러 날', '견적서') if k in allt],
        'quote_total': last_staff_total[0] if last_staff_total else None,
        'quote_amounts': sorted(set(amounts)),
        'extra_costs': sorted({k for k in ('출장비', '발전기', '현수막', '실내부스', 'X배너') if k in staff}),
        'price_status': status,                     # confirmed / quoted / negotiating / no_price
        'outcome': '확정' if status == 'confirmed' else ('보류·협의' if status in ('negotiating', 'no_price') else '견적 안내'),
        'customer_text': cust,
        'staff_text': staff,
    }


def validate(case):
    issues = []
    if case['price_status'] == 'confirmed' and not case['quote_total']:
        issues.append('확정인데 합계 없음')
    if case['quote_total'] and case['quote_total'] < 50000:
        issues.append('합계가 너무 작음')
    if not case['region']:
        issues.append('지역 없음')
    if not case['people']:
        issues.append('인원 없음')
    rest = (case['customer_text'] + ' ' + case['staff_text']).replace('010-0000-0000', '').replace('user@example.com', '')
    if PHONE.search(rest) or EMAIL.search(rest):
        issues.append('개인정보 남음')
    return issues


def chunk_case(case_id, msgs, size=6, overlap=2):
    """질문-답 흐름이 끊기지 않게 메시지 6개씩, 2개 겹쳐 자른다."""
    out, i = [], 0
    while i < len(msgs):
        part = msgs[i:i + size]
        out.append({'chunk_id': f'{case_id}#{len(out)}', 'case_id': case_id,
                    'text': '\n'.join(('고객: ' if m['role'] == 'customer' else '직원: ') + m['text'] for m in part)})
        if i + size >= len(msgs):
            break
        i += size - overlap
    return out


def run(src, out, menu_path):
    with open(menu_path, encoding='utf-8') as f:
        snap = json.load(f)
    menu_names = [r.get('name') for r in snap.get('rows', []) if r.get('name') and r.get('type') == 'menu']
    os.makedirs(out, exist_ok=True)
    cases, chunks, report = [], [], {'files': 0, 'sessions': 0, 'issues': {}}
    for path in sorted(glob.glob(os.path.join(src, '*.csv'))):
        if os.path.basename(path).startswith('_'):
            continue
        rows = load_csv(path)
        report['files'] += 1
        names = set()
        for r in rows:
            if not str(r.get('USER', '')).startswith(STAFF_PREFIX):
                names.update(customer_names(r.get('USER')))
        for k, sess in enumerate(split_sessions(rows)):
            msgs = [{'role': 'staff' if str(r.get('USER', '')).startswith(STAFF_PREFIX) else 'customer',
                     'text': anonymize(r.get('MESSAGE'), names), 'date': r.get('DATE')} for r in sess]
            cid = f"{os.path.splitext(os.path.basename(path))[0]}-{k}"
            case = extract_case(msgs, menu_names)
            case['case_id'] = cid
            case['issues'] = validate(case)
            for i in case['issues']:
                report['issues'][i] = report['issues'].get(i, 0) + 1
            cases.append(case)
            chunks.extend(chunk_case(cid, msgs))
            report['sessions'] += 1
    with open(os.path.join(out, 'cases.jsonl'), 'w', encoding='utf-8') as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'chunks.jsonl'), 'w', encoding='utf-8') as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + '\n')
    report['chunks'] = len(chunks)
    report['price_status'] = {s: sum(1 for c in cases if c['price_status'] == s) for s in ('confirmed', 'quoted', 'negotiating', 'no_price')}
    with open(os.path.join(out, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return report


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--out', required=True)
    ap.add_argument('--menu', default=os.path.join(os.path.dirname(__file__), '..', '..', 'lib', 'menu-snapshot.json'))
    a = ap.parse_args()
    if os.path.abspath(a.out).startswith(os.path.abspath(a.src)):
        raise SystemExit('출력 폴더를 원본 폴더 안에 두지 않습니다.')
    print(json.dumps(run(a.src, a.out, a.menu), ensure_ascii=False, indent=2))
