"""네트워크 없이 도는 단위 테스트: python -I -X utf8 -m unittest discover -s ai-research/rag -p "test_*.py" """
import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline as P
import rag as R

HERE = os.path.dirname(os.path.abspath(__file__))


class Anonymize(unittest.TestCase):
    def test_phone_email_account_name(self):
        t = P.anonymize('김민준 과장 010-0000-5678, 010 0000 5432, a.b@x.example.com, 국민 123456-01-234567, 테크노로 123', names=['김민준'])
        self.assertNotIn('0000-5678', t); self.assertNotIn('5432', t); self.assertNotIn('a.b@x', t)
        self.assertNotIn('234567', t); self.assertNotIn('김민준', t); self.assertNotIn('테크노로 123', t)
        self.assertIn('010-0000-0000', t)

    def test_keeps_rep_number_and_amounts(self):
        t = P.anonymize('대표번호 1877-6901, 총 1,150,000원')
        self.assertIn('1877-6901', t); self.assertIn('1,150,000원', t)

    def test_customer_names(self):
        self.assertEqual(P.customer_names('가나전자 김민준'), ['가나전자 김민준', '김민준'])


class Extract(unittest.TestCase):
    def msgs(self, pairs):
        return [{'role': r, 'text': t, 'date': '2025-05-12 10:00:00'} for r, t in pairs]

    def test_confirmed_needs_total_and_confirm(self):
        c = P.extract_case(self.msgs([('customer', '판교 300명 진행할게요'), ('staff', '총 1,150,000원입니다. 확정으로 진행하겠습니다')]), [])
        self.assertEqual(c['price_status'], 'confirmed'); self.assertEqual(c['quote_total'], 1150000)

    def test_negotiating_is_not_confirmed(self):
        c = P.extract_case(self.msgs([('customer', '대략 얼마예요'), ('staff', '대략 110만원 선인데 정확한 금액은 다시 드릴게요')]), [])
        self.assertEqual(c['price_status'], 'negotiating')

    def test_region_not_inside_word(self):
        self.assertEqual(P.find_region('부산 해운대 연수원 워크숍'), '부산')

    def test_event_date_rolls_to_next_year(self):
        c = P.extract_case([{'role': 'customer', 'text': '1월 10일 행사', 'date': '2025-11-20 10:00:00'}], [])
        self.assertEqual(c['event_date'], '2026-01-10')


class Pipeline(unittest.TestCase):
    def test_samples_end_to_end_no_pii(self):
        out = tempfile.mkdtemp()
        rep = P.run(os.path.join(HERE, 'sample_data', 'kakao'), out, os.path.join(HERE, '..', '..', 'lib', 'menu-snapshot.json'))
        self.assertEqual(rep['sessions'], 12)
        self.assertNotIn('개인정보 남음', rep['issues'])
        cases = R.load_jsonl(os.path.join(out, 'cases.jsonl'))
        s007 = next(c for c in cases if c['case_id'] == '대화_S007-0')
        self.assertEqual(s007['region'], '부산')
        with open(os.path.join(out, 'chunks.jsonl'), encoding='utf-8') as f:
            raw = f.read()
        for leaked in ('0000-5678', '0000 5432', 'ganadenja', '123456-01-234567', '김민준'):
            self.assertNotIn(leaked, raw)


class Guard(unittest.TestCase):
    def test_case_id_variants_are_accepted(self):
        import unittest.mock as m
        hits = [{'case_id': '대화_S001-0', 'bm25': 1, 'cos': None, 'case': {'case_id': '대화_S001-0', 'event_type': None, 'region': '판교', 'people': 300, 'menus': [], 'quote_total': 1150000,
                 'price_status': 'confirmed', 'requests': [], 'staff_text': '총 1,150,000원'}}]
        replies = iter([({'has_quote_request': False, 'items': [], 'region': ''}, {'sec': 0, 'json_ok': True}),
                        ({'recommended_reply': '사례 S001-0 기준 1,150,000원', 'referenced_cases': ['사례 대화_S001-0'], 'referenced_quotes': [], 'need_to_confirm': [], 'hold': False, 'hold_reason': ''}, {'sec': 0, 'json_ok': True})])
        with m.patch.object(R, 'search', return_value=hits), m.patch.object(R, 'chat_json', side_effect=lambda *a, **k: next(replies)):
            r = R.answer('x', '판교 300명', 'm')
        self.assertEqual(r['guard'], {'unsupported_amounts': [], 'unknown_case_ids': []})
        self.assertFalse(r['answer']['hold'])

    def test_unsupported_amount_forces_hold(self):
        import unittest.mock as m
        replies = iter([({'has_quote_request': False, 'items': [], 'region': ''}, {'sec': 0, 'json_ok': True}),
                        ({'recommended_reply': '20% 할인해서 900,000원입니다', 'referenced_cases': [], 'referenced_quotes': [], 'need_to_confirm': [], 'hold': False, 'hold_reason': ''}, {'sec': 0, 'json_ok': True})])
        with m.patch.object(R, 'search', return_value=[]), m.patch.object(R, 'chat_json', side_effect=lambda *a, **k: next(replies)):
            r = R.answer('x', '할인', 'm')
        self.assertEqual(r['guard']['unsupported_amounts'], [900000])
        self.assertTrue(r['answer']['hold'])


class Search(unittest.TestCase):
    def test_bm25_and_rrf(self):
        bm = R.BM25(['판교 창립기념 커피 300명', '부산 워크숍 덮밥', '화성 체육대회 빙수'])
        s = bm.scores('판교 커피 행사')
        self.assertEqual(max(range(3), key=lambda i: s[i]), 0)
        self.assertEqual(R.rrf([[0, 1, 2], [0, 2, 1]])[0], 0)

    def test_keyword_only_search_on_samples(self):
        out = tempfile.mkdtemp()
        P.run(os.path.join(HERE, 'sample_data', 'kakao'), out, os.path.join(HERE, '..', '..', 'lib', 'menu-snapshot.json'))
        top = [h['case_id'] for h in R.search(out, '부산 해운대 스테이크 덮밥 워크숍', use_vector=False)]
        self.assertEqual(top[0], '대화_S007-0')

    def test_no_metadata_query_does_not_favor_file_order(self):
        out = tempfile.mkdtemp()
        P.run(os.path.join(HERE, 'sample_data', 'kakao'), out, os.path.join(HERE, '..', '..', 'lib', 'menu-snapshot.json'))
        top = [h['case_id'] for h in R.search(out, '실내 컨벤션 분식', use_vector=False)]
        self.assertEqual(top[0], '대화_S012-0')


if __name__ == '__main__':
    unittest.main()
