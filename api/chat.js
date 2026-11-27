// api/chat.js
// 백엔드 프록시: 프론트에서 대화 내역을 받아 Claude API에 넘기고,
// AI가 견적 도구를 부르면 quote-engine으로 계산해 다시 넘긴 뒤, 최종 답변만 프론트로 돌려준다.
// ★ ANTHROPIC_API_KEY 는 Vercel 환경변수. 프론트엔드에 절대 노출하지 않는다.

const { calculateQuote } = require('../lib/quote-engine.js');
const { getMenuData, menuPromptText } = require('../lib/menu-source.js');
const { SYSTEM_KNOWLEDGE, CLASSIC_DRINKS, VENUE_NOTICE_EN_SHORT, VENUE_NOTICE_EN_FULL } = require('../lib/knowledge.js');
const { VENUE_NOTICE_SHORT, VENUE_NOTICE_FULL } = require('../lib/quote-calc.js');
const { sendLeadAlert } = require('../lib/lead-notify.js');
const { logLead } = require('../lib/sheet-log.js');
const { logChat } = require('../lib/chat-log.js');
const { capacityCheck, capacityGuide } = require('../lib/capacity.js');
const { checkRate, limitMessage } = require('../lib/rate-limit.js');
const { alertFailure } = require('../lib/slack-alert.js');

// 대화 크기 제한 (비용·악용 방지): 손님 말 40번 넘으면 전화 안내, 한 말은 2,000자까지
const MAX_USER_TURNS = Number(process.env.CHAT_MAX_TURNS) || 40;
const MAX_USER_CHARS = 2000, MAX_BOT_CHARS = 6000, MAX_MESSAGES = 100;

// 상담용 모델. 환경변수 CHAT_MODEL로 바꿀 수 있음(기본 claude-haiku-5-5, 되돌리려면 claude-sonnet-5-5). Sonnet 5.5는 생각 설정(CHAT_THINKING·CHAT_EFFORT)을 같이 맞춤(Haiku는 기본값 그대로)
const MODEL = process.env.CHAT_MODEL || 'claude-haiku-5-5';   // 2026-11-23 Sonnet 5.5 → Haiku 5.5 (회귀 59대화·고정 세트 20명·24문항 비교: 품질 거의 같고 턴당 약 1/11~1/12 비용, docs/ai-research/MODEL_EVALUATION.md 5.6·5.7)
const IS_S55 = /^claude-sonnet-5-5/.test(MODEL);
const S55_THINKING = process.env.CHAT_THINKING || 'adaptive';   // adaptive(필요할 때만 짧게) / between_tools(생각 끔)
const S55_EFFORT = process.env.CHAT_EFFORT || 'low';
// 요금(달러, 100만 토큰당) — 대화 기록에 비용을 같이 남기기 위함. Sonnet 4.6은 공개 요금 기준, 바뀌면 여기만 고침
const PRICE = { 'claude-sonnet-4-6': { in: 3, out: 15, cw: 3.75, cr: 0.30 }, 'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.10 }, 'claude-haiku-5-5': { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 } };   // Sonnet 5.5 캐시 읽기는 입력의 0.05배(다른 모델 0.1배와 다름). Haiku 5.5는 프롬프트 10만 토큰 이하 단가

// AI에게 알려줄 도구 정의
const tools = [
  {
    name: 'calculate_quote',
    description: '고객 정보(메뉴·인분수·지역 등)가 충분히 모였을 때만 호출한다. 정확한 견적을 계산해 반환한다. 이 도구 없이 절대 금액을 말하지 않는다. 메뉴는 "현재 메뉴판"의 메뉴 이름 그대로, 인분과 함께만 넘긴다(단가는 넘기지 않는다 — 메뉴판에서 자동으로 찾음).',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '주문 메뉴 항목들',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '현재 메뉴판의 메뉴 이름 (예: 감자핫도그, 베이직세트(커피음료 7종))' },
              servings: { type: 'number', description: '인분 수' },
            },
            required: ['name', 'servings'],
          },
        },
        region: { type: 'string', description: '행사 지역·도시 (예: 수원, 판교, 부산)' },
        serviceHours: { type: 'number', description: '배식 시간(시간). 모르면 3' },
        startTime: { type: 'string', description: '배식 시작 시각 HH:MM (손님이 말했을 때만, 예: 10:00)' },
        eventDate: { type: 'string', description: '행사 날짜 YYYY-MM-DD (손님이 날짜를 말했으면 오늘 날짜 기준으로 바꿔서 꼭 넣기. 모르면 비움)' },
        powerAvailable: { type: 'boolean', description: '220V 전기 연결 가능 여부. 고객이 "전기 없다/모른다"면 false, 말 안 했으면 넣지 않음' },
        venueStatus: { type: 'string', enum: ['확정', '미정', '허가필요'], description: '트럭 진행 장소: 정해짐 / 아직 미정 / 학교·공원 등 허가 필요. 말 안 했으면 넣지 않음' },
        sideBanners: { type: 'array', items: { type: 'string', enum: ['좌', '우'] }, description: '좌·우 옆면 현수막: 원하면 ["좌","우"](한쪽만이면 그쪽), 필요 없다고 했으면 [] 빈 배열, 아직 안 물어봤으면 넣지 않음 (상단·중앙은 항상 기본이라 넣지 않음)' },
        extras: {
          type: 'array',
          description: '고객이 원한 기타비용만: 발전기 / X배너 / 스티커(1,000장 단위 qty) / 섹터이동 / 모니터 / 실내부스. 여러 개면 qty',
          items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } }, required: ['name'] },
        },
        offMenu: { type: 'string', description: '메뉴판에 없는 요청(있으면 그대로)' },
        topUpAgreed: { type: 'boolean', description: "최소 주문 금액 맞춤 동의: 계산 결과가 below_minimum이어서 손님에게 물었고, 손님이 '모자란 금액을 더해 진행'에 동의했을 때만 true. 손님이 답하기 전에는 넣지 않음" },
      },
      required: ['items', 'region'],
    },
  },
  {
    name: 'submit_lead',
    description: '고객이 상담을 원하거나 연락처를 남겼을 때 호출한다. 담당자에게 상담 리드를 문자로 전달하고, 보드에서 행사·견적서를 만들 때 이 값을 그대로 쓴다. 연락처(전화번호)를 받으면 바로 호출한다. 성함(회사명)을 아직 모르면 contactName에 "미기재"로 넣고 호출한 뒤 성함을 한 번만 묻는다. 이후 견적서 정보(회사명·담당자·이메일·주소·결제방식 등)를 더 받으면 지금까지 받은 값 전부를 담아 isUpdate:true로 한 번 더 호출한다.',
    input_schema: {
      type: 'object',
      properties: {
        contactName: { type: 'string', description: '담당자명 또는 회사명. 아직 모르면 "미기재"' },
        phone: { type: 'string', description: '연락처(전화번호). 이메일만 받았으면 비움(phone·email 중 하나는 꼭)' },
        region: { type: 'string', description: '행사 지역(있으면)' },
        menu: { type: 'string', description: '문의 메뉴·인분 요약(있으면)' },
        quote: { type: 'string', description: '안내한 견적 금액 요약(있으면)' },
        datetime: { type: 'string', description: '행사 날짜·시간(있으면)' },
        note: { type: 'string', description: '기타 문의·특이사항(있으면). 손님이 남긴 번호가 본인 번호가 아니라고 했으면 "본인 번호 아님(손님 말)"을 꼭 적음' },
        company: { type: 'string', description: '회사·기관명 = 견적서 상호/행사명 (예: 판교테크)' },
        contactPerson: { type: 'string', description: '담당자 이름·직함 (예: 김과장)' },
        email: { type: 'string', description: '견적서 받을 이메일' },
        address: { type: 'string', description: '행사 정확한 주소·장소 (예: 성남시 분당구 판교역로 235 광장)' },
        payMethod: { type: 'string', description: '결제 방식: 세금계산서 / 카드 / 현금영수증 / 계좌이체 중 고객이 그걸로 하겠다고 정한 것만. "카드 되나요?"처럼 묻기만 했으면 비우고 note에 "카드 결제 문의"' },
        eventDate: { type: 'string', description: '행사 날짜 YYYY-MM-DD (오늘 날짜 기준으로 바꿔서). 모르면 비움' },
        serveTime: { type: 'string', description: '배식 시간 HH:MM~HH:MM (예: 11:00~14:00). 모르면 비움' },
        drinkChoice: { type: 'string', description: '커피 세트 음료 구성: 손님이 고른 음료, 또는 고르지 않았으면 "기본 구성(임시) · 담당자 확인". 커피 세트가 없으면 비움' },
        callTime: { type: 'string', description: '손님이 먼저 말한 통화 편한 시간대(예: 오후 2~5시). 묻지 말고 손님이 말했을 때만' },
        isUpdate: { type: 'boolean', description: '이 대화에서 submit_lead를 이미 한 번 불렀고, 정보를 보태려고 다시 부르는 경우에만 true. 처음 부르면 넣지 않음' },
      },
      required: ['contactName'],
    },
  },
];

// 연락처 카드(금액 직전에 번호·이메일 받기) — 판단은 대화 기록만으로(서버는 상태를 따로 갖지 않음)
// 카드 문장·건너뛰기 말·제출 말은 화면과 같은 글자(바꾸면 index.html도 같이)
const CARD_LINE = { ko: '견적서를 받으실 연락처(휴대폰·회사번호 또는 이메일)를 아래에 남겨 주시면 항목별 금액을 바로 보여 드릴게요. 번호 없이 대략 금액만 보셔도 괜찮아요.', en: 'Leave a phone number or email below and I will show the itemized quote right away. You can also just see a rough total without it.' };
const RANGE_LINE = { ko: '항목별 금액과 견적서는 아래 [견적서 받기]로 번호나 이메일을 남겨 주시면 바로 보여 드릴게요.', en: 'For the itemized quote, tap [Get quote] below and leave a phone number or email.' };
const SKIP_TEXT = /^\s*(번호 없이 대략 금액만 보기|나중에 할게요, 대략 금액만 볼게요|See a rough range without contact|Maybe later, just show me a rough range)\s*$/;
// 카드 버튼 대신 손님이 직접 "번호 남기기 싫어요, 금액만" 같이 쳐도 건너뛴 것으로 봄(같은 카드를 두 번 띄우지 않게)
const SKIP_SAID = /번호.{0,8}(싫|안\s?남|못\s?남|말고|부담)|남기기\s?(싫|어렵|부담)|연락처\s?(없이|는\s?싫|싫|안\s?남|못\s?남)|(그냥|일단|대략)\s?(금액|가격)|(금액|가격)만\s?(알려|보여|볼게|궁금)|no (phone|contact)|without (my )?(phone|contact)|just (the )?(price|range)/i;
const PHONE_RE = /010[-\s.]?\d{4}[-\s.]?\d{4}|01[16789][-\s.]?\d{3,4}[-\s.]?\d{4}|0[2-6]\d?[-\s.]?\d{3,4}[-\s.]?\d{4}/;   // 휴대폰 + 회사 유선(02·031 등)
// 접수에 적힌 휴대폰 번호가 이상한지: 010인데 11자리가 아니거나, 손님 글에 그 숫자가 없음(이메일이 있으면 그걸로 연락 가능하니 통과)
const badPhone = (inp, userText) => {
  const d = String((inp || {}).phone || '').replace(/\D/g, '');
  if (!d || String((inp || {}).email || '').trim()) return false;
  return (/^010/.test(d) && d.length !== 11) || (/^01/.test(d) && !String(userText || '').replace(/\D/g, '').includes(d));
};
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const man = (n, up) => (up ? Math.ceil(n / 10000) : Math.floor(n / 10000)) * 10000;   // 만 원 단위로
// 건너뛴 손님에게 보여 줄 대략 금액: 합계를 만 원 단위로 올린 한 금액(범위는 쓰지 않음 — 대표 결정 11-26). 항목별 금액은 연락처를 남긴 뒤에
const roughAmount = (c) => [man(c.subtotal, true)];

// 접수가 실제로 된 답 끝에 서버가 붙이는 정해진 한 줄 — 화면이 답 글을 그대로 다시 보내므로 다음 턴에 이 줄로 '이미 접수됨'을 안다
// (서버는 이전 턴의 도구 호출을 받지 못함. 모델이 "접수 안 됐다"고 단정하던 일 막기)
const LEAD_MARK = { ko: '✅ 상담 접수 완료 — 담당자에게 전달됐어요', koUpdate: '✅ 추가 정보 전달 완료 — 담당자에게 전달됐어요', en: '✅ Your request has been sent to our staff.' };
// 판단은 챗봇 답의 '마지막 줄'이 표시 줄과 정확히 같을 때만 — 모델이 문장 안에서 인용하거나 손님이 붙여 넣은 문구로 잘못 판단하지 않게
// (예전의 "접수됐어요" 같은 문장 판단은 모델이 접수 없이 말해도 걸려서 쓰지 않음)
const LEAD_MARKS = Object.values(LEAD_MARK);
const endsWithLeadMark = (s) => { const ls = String(s || '').trim().split('\n'); return LEAD_MARKS.includes(ls[ls.length - 1].trim()); };
const LEAD_MARK_ANY = /✅\s*(?=상담 접수 완료|추가 정보 전달 완료|Your request has been sent)/g;   // 모델이 직접 쓴 표시 문구는 ✅만 뗌(문장은 살리고, 표시 줄로는 못 보이게 — 서버만 붙임)

// 손님이 넣은 값 정리 — 담당자 문자에 줄바꿈으로 가짜 머리글·"대표 승인 완료" 같은 줄이 끼던 일 막기
// 칸마다 줄바꿈을 공백으로, 길이 제한, 링크·머리글처럼 보이면 표시를 붙임
function cleanLeadValue(v, max) {
  let s = String(v).replace(/\s+/g, ' ').trim();   // \s는 줄바꿈·탭·줄 구분 문자(U+2028·2029)까지 포함
  // 꺾쇠는 전각으로 — 보드 화면에 이스케이프 없이 그리는 곳이 있어 태그가 되지 않게(문자는 HTML이 아니라 읽는 데 지장 없음)
  s = s.replace(/</g, '＜').replace(/>/g, '＞');
  if (s.length > max) s = s.slice(0, max) + '…';
  if (/https?:\/\/|www\.|\[[^\]]{0,40}\]/i.test(s)) s += ' (손님 글·확인 안 됨)';
  return s;
}
function cleanLead(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) out[k] = typeof v === 'string' ? cleanLeadValue(v, k === 'note' ? 500 : 200) : v;
  return out;
}
// 구글시트에서 =·+·-·@로 시작하는 값은 수식으로 실행될 수 있어 앞에 '를 붙임
const sheetSafe = (v) => (/^[=+\-@]/.test(String(v || '')) ? "'" + v : (v || ''));

// 지난 날짜면 다음 해로 — 모델이 연도를 틀리게 넣는 일(2027-01-15 → 2026-01-15)이 있어서. 담당자가 알 수 있게 표시를 남김
function fixPastDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return { date: d, note: '' };
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (d >= today) return { date: d, note: '' };
  const next = (Number(d.slice(0, 4)) + 1) + d.slice(4);
  return next >= today ? { date: next, note: ' (연도 자동 보정, 확인 필요)' } : { date: d, note: ' (지난 날짜, 확인 필요)' };
}

// 글 속 금액 → 숫자 목록 ("1,215,000~1,350,000원", "133만 1천 원")
function amounts(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/(\d+(?:\.\d+)?)\s*만\s*(?:(\d)\s*천)?|\d{1,3}(?:,\d{3})+|\d{5,}/g)) {
    out.push(m[1] ? Math.round(Number(m[1]) * 10000 + (m[2] ? Number(m[2]) * 1000 : 0)) : Number(m[0].replace(/,/g, '')));
  }
  return out;
}

// 금액 숫자(1개=한 금액, 2개=범위) → 문자 견적 줄. withVat=false면 부가세 포함은 빼고 씀
function amountText(nums, withVat = true) {
  const won = (n) => Math.round(n).toLocaleString('ko-KR');
  const range = nums.length > 1, w = (xs) => (range ? '약 ' : '') + xs.map(won).join('~') + '원';
  return `${w(nums)} (부가세 별도${range ? ', 확정 전' : ''})` + (withVat ? ` · 부가세 포함 ${w(nums.map((n) => n * 1.1))}` : '');
}

// 모델 quote에 금액·기본 말 말고 다른 말("하루치", "제주 출장비 별도 안내" 등)이 있으면 원문을 뒤에 붙임 — 계산 결과로 바꿔 쓸 때 사라지지 않게
function quoteExtra(modelQuote) {
  const rest = String(modelQuote || '').replace(/(\d+(?:\.\d+)?)\s*만\s*(?:\d\s*천)?|\d{1,3}(?:,\d{3})+|\d{5,}/g, '')
    .replace(/합계|약|원|부가세\s*(별도|포함)|출장비\s*포함|확정\s*전|Total|KRW|[~()·,./:\s-]/gi, '');
  return rest ? ` / 챗봇 안내: ${modelQuote}` : '';
}

// 문자 견적 줄. 순서: ① 이번 요청의 calculate_quote 결과(접수가 이번 답보다 먼저 실행돼 대화 기록엔 아직 없음)
// ② 손님에게 보여 준 "**합계 …**" 줄(계산기 summaryLine) 중 모델 quote와 금액이 같은 것 ③ 모델 quote 그대로(영어 등 합계 줄 없음)
// 같은 게 없으면(메뉴를 바꿨는데 최소 미달, A·B 비교 등) 둘 다 적고 확인 필요 표시 — 이때 맞지 않는 줄의 부가세 포함은 빼서 확정처럼 안 보이게
function quoteLine(modelQuote, botTexts, calcs = []) {
  const q = amounts(modelQuote);
  const same = (nums) => nums.length > 0 && nums.every((n) => q.includes(n));
  if (calcs.length) {
    const last = calcs[calcs.length - 1];
    if (last.status !== 'ok') return modelQuote || '최소 금액 미달 · 수량 조정 상담 필요';
    const nums = (c) => [c.subtotal];
    const ok = calcs.filter((c) => c.status === 'ok');
    const pick = [...ok].reverse().find((c) => same(nums(c))) || last;   // 같은 요청에 A·B를 계산했으면 모델이 고른 쪽
    return amountText(nums(pick)) + quoteExtra(modelQuote);
  }
  const sums = [];
  for (const t of botTexts) for (const l of String(t || '').split('\n')) if (/^\s*(?:[-·•]\s*)?\*\*(합계|Total)/i.test(l)) sums.push(amounts(l.replace(/\(.*$/, '')).slice(0, 2));
  // 계산기 결과도, 손님에게 보여 준 합계 줄도 없는데 모델이 금액을 적었으면 모델이 직접 계산한 금액 → 확인 표시(S25-e: 172인분 702,000원)
  if (!sums.filter((s) => s.length).length) return q.length ? `${modelQuote} (계산기 결과 없음 — 견적 확인 필요)` : (modelQuote || '');
  for (let i = sums.length - 1; i >= 0; i--) if (modelQuote && same(sums[i])) return amountText(sums[i]) + quoteExtra(modelQuote);
  const last = amountText(sums.filter((s) => s.length).pop(), false);
  return modelQuote ? `${modelQuote} / 대화 마지막 합계: ${last} (견적 확인 필요)` : `${last} (견적 확인 필요)`;
}

// 상담 리드를 담당자에게 문자로 발송 (ctx: 날짜 보정 표시, 손님에게 보여 준 챗봇 글)
async function handleLead(input, ctx = {}) {
  const p = input || {};
  const calcs = ctx.calcs || [], history = ctx.history || [];
  const won = (n) => Math.round(n).toLocaleString('ko-KR');
  // 손님에게 마지막으로 보여 준 합계(이번 요청 전) — 추가 접수의 견적 줄·변경 줄에 씀
  // 합계가 나온 가장 최근 답의 합계 줄 전부(손님이 두 안을 비교한 답이면 둘 다) — 마지막 줄 하나만 보면 고르지 않은 안을 이전 견적으로 잡던 일
  let lastSums = [];
  for (let i = history.length - 1; i >= 0 && !lastSums.length; i--) {
    lastSums = String(history[i] || '').split('\n').filter((x) => /^\s*(?:[-·•]\s*)?\*\*(합계|Total)/i.test(x))
      .map((l) => amounts(l.replace(/\(.*$/, '')).slice(0, 2)).filter((n) => n.length);
  }
  const lastSum = lastSums.length ? lastSums[lastSums.length - 1] : null;
  // 다시 계산하지 않은 추가 접수(이메일만 보탬·삭제 요청 등): 챗봇이 적은 금액과 맞는 합계가 있으면 그대로, 없을 때만 마지막 합계 — "견적 확인 필요"가 잘못 붙던 일
  const baseQuote = quoteLine(p.quote, ctx.botTexts || [], calcs);
  const quote = p.isUpdate && !calcs.length && lastSum && /견적 확인 필요/.test(baseQuote) ? amountText(lastSum) : baseQuote;
  const when = [p.eventDate, p.serveTime].filter(Boolean).join(' ');
  const org = [p.company, p.contactPerson].filter(Boolean).join(' ');
  const who = [org, p.contactName && !org.includes(p.contactName) ? p.contactName : ''].filter(Boolean).join(' / ');   // 회사명이 있어도 손님 이름이 빠지지 않게
  const auto = p.contactName === '(앞 접수와 같은 손님)';

  // 담당자가 문자 첫머리만 보고 무슨 건인지·무엇을 조심할지 알게(페르소나 시험: 삭제 요청·남의 번호가 문의 줄에 묻힘)
  const nth = history.filter((h) => endsWithLeadMark(h)).length;   // 이 대화에서 앞서 접수된 횟수
  const tags = [auto ? '견적 변경(자동 전달)' : p.isUpdate ? '정보 추가' : '신규'];
  if (p.contactName === '미기재' && !org) tags.push('이름 미확인');
  if (/최소 금액 미달/.test(quote)) tags.push('최소 금액 미달');
  const allText = Object.values(p).filter((v) => typeof v === 'string').join(' ');
  // 사무실 답(11-20 질문 9): "그냥 전화 주세요" 손님은 정보와 함께 담당자에게 → 상태 줄에 표시
  // 모델이 메모를 "전화 연락을 원함"·"손님이 전화 요청"처럼 여러 모양으로 써서 단어 조합으로 봄(11-23 시험에서 두 번 빠짐)
  const callNote = String(p.note || '');
  if (p.callTime || (/전화|통화/.test(callNote) && /원|요청|연락|부탁|주세요|희망/.test(callNote))) tags.push('전화 요청');
  const warn = [];
  if (/개인정보\s*삭제|삭제\s*요청|번호\s*(지워|삭제)/.test(p.note || '')) warn.push('⚠ 개인정보 삭제 요청 — 연락 전 처리 여부 확인');
  if (/본인 번호 아님/.test(p.note || '')) warn.push('⚠ 본인 번호 아님(손님 말) — 이 번호로 연락해도 되는지 확인');
  if (!p.phone && p.email) tags.push('이메일만');
  if (/^\s*0(2|[3-6]\d)/.test(p.phone || '')) tags.push('회사 유선(문자 불가)');
  if (/손님 글·확인 안 됨/.test(allText)) warn.push('⚠ 손님이 쓴 링크·머리글 포함 — 내용 확인');
  if (ctx.dateNote) warn.push('⚠ 행사 날짜 연도 확인');
  if (/계산기 결과 없음/.test(quote)) warn.push('⚠ 계산기로 계산하지 않은 금액 — 견적 다시 계산');
  else if (/견적 확인 필요/.test(quote)) warn.push('⚠ 챗봇이 적은 금액과 계산 결과가 다름 — 견적 확인');
  // 추가 접수에서 견적이 바뀌었으면 이전 → 지금
  const lc = [...calcs].reverse().find((c) => c && c.status === 'ok');
  // 음식값이 60만 원보다 적어 모자란 금액을 더한 견적 → 담당자가 견적서에 같은 줄로 옮기게(대표 확정 11-25)
  if (lc && lc.costs && lc.costs.최소주문맞춤 > 0) tags.push(`최소 주문 금액 맞춤 +${won(lc.costs.최소주문맞춤)}원(음식값 ${won(lc.foodValue || 0)}원, 손님 동의)`);
  // 최소 주문 금액에 못 미쳤는데 손님이 맞춤/수량 늘리기를 고르기 전에 접수된 건 → 담당자가 첫 연락에서 물어보게(11-27)
  if (!lc) {
    const lastAny = calcs[calcs.length - 1];
    let short = lastAny && lastAny.status === 'below_minimum' && lastAny.short ? `${won(lastAny.short)}원` : '';
    if (!short && !calcs.length) {
      const bt = ctx.botTexts || [];
      for (let i = bt.length - 1; i >= 0; i--) {
        const t = String(bt[i] || '');
        if (/\*\*(합계|Total)/i.test(t)) break;
        const m = /최소 주문/.test(t) && t.match(/(\d[\d,]*\s?만?\s?원)\s*(?:이|가)?\s*모자라/);
        if (m) { short = m[1]; break; }
      }
    }
    if (short) tags.push(`최소 주문 금액 미달(${short} 모자람) · 손님 선택 전(맞춤/수량 늘리기)`);
  }
  const nowNums = lc ? [lc.subtotal] : null;
  const fmt = (ns) => (ns.length > 1 ? '약 ' : '') + ns.map(won).join('~') + '원';
  // 이번 견적이 앞서 보여 준 안 중 하나와 같으면 변경 아님(날짜만 고친 추가 접수 등)
  const sameAsShown = nowNums && lastSums.some((n) => fmt(n) === fmt(nowNums));
  const change = p.isUpdate && lastSum && nowNums && !sameAsShown ? `변경: 견적 ${lastSums.length > 1 ? '(앞서 비교한 안 중) ' : ''}${fmt(lastSum)} → ${fmt(nowNums)}` : '';
  if (change && !auto) tags[0] = '견적 변경';
  // 견적서 칸 중 전기·출력물은 계산에 넣은 조건으로 고정 칸(손님이 말 안 했으면 확인 필요)
  const ci = (lc && lc._input) || {};
  const power = !lc ? '' : ci.powerAvailable === false || (lc.costs && lc.costs.자가발전기 > 0) ? '없음(자가발전기 포함)' : ci.powerAvailable === true ? '있음' : '확인 필요(있다고 보고 계산)';
  const banner = !lc ? '' : Array.isArray(ci.sideBanners) ? (ci.sideBanners.length ? `상단·중앙 + ${ci.sideBanners.join('·')}` : '상단·중앙만') : '확인 필요(상단·중앙 기본)';
  const missing = [];
  if (!p.company) missing.push('행사명·회사');
  if (!p.email) missing.push('이메일');
  if (!p.eventDate && !p.datetime) missing.push('날짜');
  if (!p.serveTime) missing.push('시간');
  if (!p.address) missing.push('주소');
  if (!p.payMethod) missing.push('결제방식');
  if (!p.menu && !lc) missing.push('메뉴·인분');
  if (!lc || power.startsWith('확인')) missing.push('전기');
  if (!lc || banner.startsWith('확인')) missing.push('출력물(현수막)');

  const lines = [
    p.isUpdate ? `[푸드트럭하우스 챗봇 상담 · 추가 정보${nth ? ` ${nth}차` : ''}]` : '[푸드트럭하우스 챗봇 상담 신청]',
    `상태: ${tags.join(' · ')}`,
    ...warn,
    ...(change ? [change] : []),
    ...(!auto && missing.length ? [`견적서 빈 칸: ${missing.join(', ')}`] : []),
    `담당자/회사: ${who || '-'}`,
    `연락처: ${p.phone || '-'}`,
  ];
  if (p.email) lines.push(`이메일: ${p.email}`);
  if (when) lines.push(`날짜·시간: ${when}${ctx.dateNote || ''}`);
  if (p.address) lines.push(`주소: ${p.address}`);
  if (p.callTime) lines.push(`손님이 말한 통화 시간: ${p.callTime}`);
  if (p.payMethod) lines.push(`결제: ${p.payMethod}`);
  if (p.region) lines.push(`지역: ${p.region}`);
  if (p.menu) lines.push(`메뉴/인분: ${p.menu}`);
  if (p.drinkChoice) lines.push(`음료 구성: ${p.drinkChoice}`);
  // 이번 요청에 계산이 없으면(견적 다음 턴에 접수) 앞서 보여 준 답의 "차량 N대"로
  const prevTrucks = Number(((ctx.botTexts || []).join('\n').match(/차량\s?(\d)대/g) || []).map((s) => s.replace(/\D/g, '')).pop() || 1);
  const trucks = lc ? lc.trucks || 1 : prevTrucks;
  if (trucks > 1) lines.push(`차량: ${trucks}대(인분 합계 500 이상, 출장비 ${trucks}대분)`);
  if (power) lines.push(`전기: ${power}`);
  if (banner) lines.push(`현수막: ${banner}`);
  if (quote) lines.push(`견적: ${quote}`);
  // 연락처 카드로 들어온 접수: 손님이 무엇을 봤고 무엇을 안내받았는지(첫 통화에서 "어디까지 보셨어요?"를 묻지 않게 — 페르소나 시험 11-24)
  // 숫자로: 건너뛴 손님이 처음 본 대략 금액 → 이번에 본 항목별 금액(부가세 별도). 카드 없이 번호를 준 접수에도 같은 줄(경로마다 문자 모양이 다르지 않게)
  const cf = ctx.card || {};
  if (!p.isUpdate && !auto) {
    const roughs = [...(ctx.botTexts || []).join('\n').matchAll(/대략\s*\**\s*(\d[\d,]*)만/g)];
    const rough = roughs.length ? `연락처 전 대략 ${roughs[roughs.length - 1][1]}만 원 → ` : '';
    const seen = nowNums ? `항목별 ${fmt(nowNums)}` : lastSum ? `항목별 ${fmt(lastSum)}` : '아직 금액 안 봄';
    lines.push(`손님이 본 금액: ${rough}${seen} (부가세 별도)`);
    lines.push(`안내한 것: ${!p.phone && p.email ? '견적서는 메일로 보내 드린다고 함(전화번호 없음)' : '담당자가 견적서 보내고 확인 연락'}${cf.shown ? ' · 연락처 카드로 받음' : ''} (할인·차량 확보는 약속 안 함)`);
  }
  const norm = (s) => String(s).replace(/\s/g, '').replace(/\d{4}-/g, '');   // 연도 보정으로 연도만 달라진 건 같은 글로 봄
  if (p.datetime && (!when || norm(p.datetime) !== norm(when))) lines.push(`일정: ${p.datetime}`);   // 날짜·시간 줄과 같은 글일 때만 생략(여러 날 일정 등은 남김)
  if (p.note) lines.push(`문의: ${p.note}`);

  const res = await sendLeadAlert(lines.join('\n'));
  // 문자가 안 나가면 담당자가 접수를 모름 → 슬랙으로 바로 알림(손님 이름·번호는 빼고)
  if (!res.ok) await alertFailure('sms', { where: '챗봇 접수', reason: res.reason, sessionId: ctx.sessionId, summary: [p.menu, p.region, p.isUpdate ? '추가 정보' : '신규'].filter(Boolean).join(' · ') });

  // 구글시트에도 영구 기록(문자를 놓쳐도 리드를 잃지 않기 위함). 실패해도 무시.
  // 시트 칸은 Apps Script에 고정돼 있어 음료 구성은 note에 붙임
  await logLead({
    source: '대화형챗봇',
    contactName: sheetSafe(p.contactName),
    phone: sheetSafe(p.phone || (p.email ? `이메일 ${p.email}` : '')),
    region: sheetSafe(p.region),
    menu: sheetSafe(p.menu),
    quote: sheetSafe(quote),
    datetime: sheetSafe(when ? when + (ctx.dateNote || '') : p.datetime),
    note: sheetSafe([p.note, p.drinkChoice && `음료 구성: ${p.drinkChoice}`].filter(Boolean).join(' / ')),
  });

  // AI에게는 항상 접수됨을 알려 고객에게 안심 안내하도록 한다(발송 실패해도 대화상 리드는 남음).
  return res.ok
    ? { status: 'submitted', message: '담당자에게 상담 신청이 전달되었습니다.' }
    : { status: 'received', message: '상담 신청이 접수되었습니다. (담당자 확인 예정)' };
}

// 한국 시간 오늘 날짜 (예: 오늘: 2026-11-06 (금))
function todayText() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const w = '일월화수목금토'[d.getUTCDay()];
  return `오늘: ${d.toISOString().slice(0, 10)} (${w}) — 한국 시간`;
}

// 접수 뒤 연락 안내(사무실 답 11-20: 영업시간엔 몇 분 안에, 길어도 10~20분) — 영업시간 평일 09~18시(대표 확인 11-25), 공휴일은 모름
function contactWhen() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const day = d.getUTCDay(), h = d.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  if (weekday && h >= 9 && h < 18) return '영업시간이라 보통 몇 분 안에(늦어도 20분 안팎) 담당자가 연락드려요.';
  if (weekday && h < 9) return '오늘 오전 9시 영업 시작 후 담당자가 바로 연락드려요.';
  const next = day === 5 || day === 6 ? '월요일' : '내일';   // 금 저녁·토 → 월, 일·평일 저녁 → 내일
  return `지금은 영업시간(평일 09~18시)이 아니라 ${next} 오전에 담당자가 연락드려요.`;
}

// 커피 세트(2·4·7종) 견적에서 음료 구성을 묻는 답 → { kind:'drinks', count, defaults, options }
function drinkPicker(reply) {
  const t = String(reply || '');
  if (!/음료는 기본 구성|바꾸고 싶은 음료|원하시는 음료로|음료를 골라|음료 구성/.test(t) || !/\?|말씀해 주세요|정하셔도/.test(t)) return null;
  const m = t.match(/\(커피음료\s*([247])종\)[^\n]*\n\s*└\s*([^\n]+)/);
  if (!m) return null;
  const count = Number(m[1]);
  const base = (x) => x.replace(/\(아이스\)/g, '').trim();
  const line = m[2].includes('기본') ? m[2].split(/기본[:：]?/).pop() : m[2];   // "15종 중 7가지 선택 (기본: …)" → 기본 뒤만
  const defaults = line.replace(/[()*]/g, ' ').split(/[·,/]/).map((x) => x.trim()).filter((x) => x && x.length <= 14)
    .map((x) => (base(x) === '아이스티' ? '복숭아아이스티' : x))   // 아이스티는 복숭아 하나뿐이라 합침(레몬 등이 생기면 따로 구분)
    .map((x) => CLASSIC_DRINKS.find((c) => base(c) === base(x)) || x);   // "아샷추" → 목록 이름 "아샷추(아이스)"
  const options = [...new Set([...defaults, ...CLASSIC_DRINKS])];
  return { kind: 'drinks', count, defaults: defaults.slice(0, count), options };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  try {
    const { messages: rawMessages, sessionId, page } = req.body || {};
    if (!Array.isArray(rawMessages)) {
      return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
    }
    // 손님 화면이 보내는 건 글자 대화뿐 — 그 외 모양은 버리고, 너무 긴 말은 자름
    const messages = rawMessages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_MESSAGES)
      .map(m => ({ role: m.role, content: m.role === 'user' && m.content.length > MAX_USER_CHARS
        ? m.content.slice(0, MAX_USER_CHARS) + '\n\n(손님 말이 너무 길어 뒷부분이 잘렸어요. 놓친 내용이 있을 수 있으니 필요한 건 다시 여쭤보세요.)'   // 잘린 걸 챗봇이 알게
        : m.content.slice(0, m.role === 'user' ? MAX_USER_CHARS : MAX_BOT_CHARS) }));
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) return res.status(400).json({ error: '메시지가 비어 있어요.' });

    // 호출 횟수 제한 — 걸리면 AI를 부르지 않고 안내만 (손님 화면엔 보통 답처럼 보임)
    const rate = await checkRate('chat', req);
    if (!rate.ok) return res.status(200).json({ reply: limitMessage(rate.why), limited: rate.why });
    const lastSaysPhone = /010[-\s.]?\d{4}[-\s.]?\d{4}|01[16789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(messages[messages.length - 1].content) || EMAIL_RE.test(messages[messages.length - 1].content);   // 연락처를 남기는 말은 길어도 받아서 접수
    if (messages.filter(m => m.role === 'user').length > MAX_USER_TURNS && !lastSaysPhone) {
      return res.status(200).json({ reply: '대화가 길어져서 여기부터는 담당자가 직접 도와드리는 게 정확해요. 대표번호 1877-6901로 전화 주시거나, 성함과 연락처를 남겨 주시면 담당자가 연락드릴게요. 새로 상담하시려면 위의 ↺ 새로 시작을 눌러 주세요.', limited: 'turns' });
    }

    const convo = [...messages];
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
    const meta = { tools: [] };   // 이번 답에서 쓴 도구 요약 → 대화 기록에 같이 남김
    const usage = { model: MODEL, calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };   // 이번 답에 쓴 토큰(여러 번 부르면 합산)
    const menuText = menuPromptText(await getMenuData());   // 보드 견적 메뉴판 → 챗봇이 아는 메뉴·가격

    const preTexts = [];   // 도구를 부르기 전에 쓴 글(예: "네, 카드 결제 가능해요!") — 예전엔 마지막 답만 보내서 이 글이 빠졌음
    const calcs = [];   // 이번 요청에서 돌린 calculate_quote 결과(차례대로)
    let leadKind = null;   // 이번 요청에서 접수했으면 'new'(새 접수) / 'update'(추가 정보)
    // 글자가 있는 가장 최근 손님 말이 외국어(영어·일본어·중국어 등)면 외국어 손님("300"처럼 숫자만 있는 말은 건너뜀)
    // 장소 안내·접수 표시 줄은 정해 둔 영어 문구를 씀(일본어·중국어 문구는 따로 없어 영어로)
    // 메뉴명·이름·지명만 한글로 섞어 쓰는 외국 손님이 있어 "한글이 없을 때만"이 아니라 양으로 판단:
    // 일본어 가나가 한 글자라도 있으면 외국어 / 아니면 한자 수 + 영문자 수÷2(한글 1글자≈영문 2글자) ≥ 한글 수이면 외국어
    const FOREIGN = /[A-Za-z]{2,}|[぀-ヿ一-鿿]/;
    // 이메일 주소의 영문자는 언어 판단에서 뺌(연락처 카드로 이메일만 남긴 한국 손님에게 영어 안내가 나가던 일)
    const langText = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ');
    const lastWords = [...messages].reverse().map((m) => ({ role: m.role, content: langText(m.content) })).find((m) => m.role === 'user' && (/[가-힣]/.test(m.content) || FOREIGN.test(m.content)));
    const count = (s, re) => (String(s).match(re) || []).length;
    const english = !!lastWords && FOREIGN.test(lastWords.content) && (/[぀-ヿ]/.test(lastWords.content)
      || count(lastWords.content, /[一-鿿]/g) + count(lastWords.content, /[A-Za-z]/g) / 2 >= count(lastWords.content, /[가-힣]/g));
    // 이 대화에서 현수막 위치를 이미 물었으면(앞선 챗봇 답에 그 질문) 계산기의 "현수막 한 번 물어보세요" 안내를 빼고 넘김 — 매번 다시 묻던 일
    const askedBanner = messages.some((m) => m.role === 'assistant' && /좌·우 옆면|X배너에도/.test(m.content));
    let leadSent = messages.some((m) => m.role === 'assistant' && endsWithLeadMark(m.content));   // 이미 접수한 대화면 다음 접수는 '추가 정보'로
    const leadBefore = leadSent;   // 이번 요청 전에 이미 접수된 대화인지(견적 변경 자동 전달 판단용)
    // 이미 접수한 대화면 모델에게도 알림(앞 턴의 도구 호출은 모델에 가지 않아 "접수 안 됐다"고 단정하던 일)
    const leadNote = leadSent ? [{ type: 'text', text: '[봇에게] 이 대화에서는 이미 상담 접수가 됐어요(담당자에게 전달됨). 손님이 접수 여부를 물으면 "네, 접수돼 있어요"라고 답하고, 정보를 보태면 submit_lead로 추가하세요. 내부 도구 이름은 말하지 않습니다.' }] : [];
    // 앞서 견적에 쓴 지역(출장비 줄)을 알려 줌 — 메뉴를 바꾸면 이미 받은 지역을 다시 묻던 일(운영 시험 11-23: 커피 → 핫도그로 바꾸자 "수원"을 다시 물음)
    const regionHits = [...messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || '')).join('\n')
      .matchAll(/(?:출장비|Travel fee)\s?\(([^),]+)/gi)].map((m) => m[1].trim());
    const knownRegion = regionHits.length ? regionHits[regionHits.length - 1] : '';
    const regionNote = knownRegion ? [{ type: 'text', text: `[봇에게] 이 대화에서 이미 받은 행사 지역: ${knownRegion} — 메뉴·인분을 바꿔도 지역은 다시 묻지 말고 이 지역으로 계산하세요(손님이 지역을 바꾸면 그때만 새 지역).` }] : [];
    // 연락처 카드: 연락처(번호·이메일)를 받기 전에는 금액을 주지 않음(ask), 손님이 카드를 건너뛰었으면 대략 금액만(range)
    const userAll = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    const isCard = (m) => m.role === 'assistant' && (m.content.includes(CARD_LINE.ko) || m.content.includes(CARD_LINE.en));
    const cardShown = messages.some(isCard);
    // 직접 친 거절 말은 카드를 한 번 본 뒤에만 건너뛰기로 봄("금액만 알려 주세요"로 시작한 손님도 카드는 한 번 보게)
    const cardSkipped = messages.some((m, i) => m.role === 'user' && (SKIP_TEXT.test(m.content) || (SKIP_SAID.test(m.content) && messages.slice(0, i).some(isCard))));
    const hasContact = PHONE_RE.test(userAll) || EMAIL_RE.test(userAll) || leadSent;
    const emailOnly = EMAIL_RE.test(userAll) && !PHONE_RE.test(userAll);
    const gate = hasContact ? null : cardSkipped ? 'range' : 'ask';
    const quoteBefore = messages.some((m) => m.role === 'assistant' && /\*\*(합계|Total)/.test(m.content));
    const cardNote = hasContact && (cardShown || cardSkipped) && !quoteBefore && !leadSent
      ? [{ type: 'text', text: '[봇에게] 손님이 견적서 받을 곳(연락처)을 남겼어요. calculate_quote로 앞서 받은 조건을 다시 계산해 항목별 견적을 보여 주고, 같은 답에서 submit_lead로 접수하세요(이메일만 받았으면 phone은 비우고 email에).' }] : [];
    // 도구 호출이 나오면 실행하고 다시 물어보는 루프 (최대 4회 — Haiku는 계산 2번 + 접수를 한 답에서 해 3회를 다 쓰는 일이 있었음)
    // 도구는 4번까지, 그래도 끝나지 않으면 마지막 한 번은 도구 없이 지금까지 결과로 답하게 함
    // (운영 시험 11-23: 50명 음식 조합을 계속 계산하다 한도를 다 써서 "잠시 후 다시 시도해 주세요"로 끝남)
    const TOOL_ROUNDS = 4;
    for (let i = 0; i <= TOOL_ROUNDS; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,   // Haiku 5.5는 생각이 기본으로 켜져 1024면 답이 문장 중간에서 잘렸음(24문항 중 2개)
          ...(IS_S55 ? { thinking: { type: S55_THINKING }, output_config: { effort: S55_EFFORT } } : {}),
          // 프롬프트 캐싱: 고정 지식(system)에 캐시 지점을 두면 tools+system이 함께 캐시된다.
          // 반복 요청 시 이 부분은 재계산하지 않고 캐시에서 읽어 비용·속도를 크게 줄인다(답변 품질은 동일).
          system: [
            { type: 'text', text: SYSTEM_KNOWLEDGE },
            { type: 'text', text: menuText, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: todayText() },   // 날짜는 캐시 지점 뒤에(매일 바뀜)
            // 이메일만 받은 손님에게 "몇 분 안에 연락"은 지킬 수 없는 약속 → 메일로 보낸다고만(페르소나 재시험 11-24)
            { type: 'text', text: emailOnly ? '[봇에게] 이 손님은 전화번호 없이 이메일만 남겼어요. 접수 뒤 안내는 "담당자가 확인해서 견적서를 메일로 보내 드릴게요."로 하고, 몇 분 안에 연락드린다는 시간 약속이나 전화 이야기는 하지 마세요.' : `[봇에게] 접수 뒤 담당자 연락 안내는 "곧 연락드릴게요" 대신 이 문장을 그대로 쓰세요: "${contactWhen()}"` },
            ...leadNote,
            ...regionNote,
            ...cardNote,
            ...(i === TOOL_ROUNDS ? [{ type: 'text', text: '[봇에게] 이번 답에서는 도구를 더 쓸 수 없어요. 지금까지의 계산 결과와 대화만으로 손님에게 바로 답하세요. 계산하지 않은 새 금액은 말하지 말고, 더 계산이 필요하면 무엇을 정해 주시면 계산해 드린다고만 하세요. 빈 답은 안 됩니다.' }] : []),
          ],
          tools,
          ...(i === TOOL_ROUNDS ? { tool_choice: { type: 'none' } } : {}),
          messages: convo,
        }),
      });

      const data = await r.json();
      if (data && data.usage) { const u = data.usage; usage.calls++; usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0; }
      if (data.error) {
        await alertFailure('error', { where: 'AI 호출', reason: data.error.message || 'API 오류', sessionId });
        return res.status(500).json({ error: data.error.message || 'API 오류' });
      }

      if (data.stop_reason === 'tool_use') {
        const toolUses = data.content.filter((b) => b.type === 'tool_use');
        convo.push({ role: 'assistant', content: data.content });
        // 단, "잠깐만요, 계산해 볼게요!" 같은 빈말 줄은 빼고(바로 뒤에 "견적 나왔어요"가 와서 같은 말을 두 번 하는 것처럼 보임)
        const FILLER = /^(잠깐만?요?|잠시만?요?|네)?[,!~ ]*[^.?!]{0,40}(계산|확인|정리|반영|접수)[^.?!]{0,12}(볼게요|드릴게요|할게요|하겠습니다|해 볼게요)[!.~ 🙂😊]*$|^let me (calculate|check)/i;
        const pre = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          .split('\n').filter((l) => !FILLER.test(l.trim())).join('\n').trim();
        if (pre) preTexts.push(pre);

        const runTool = async (tu) => {
          let out;
          if (tu.name === 'calculate_quote') {
            const cin = Object.assign({}, tu.input, tu.input && tu.input.eventDate ? { eventDate: fixPastDate(tu.input.eventDate).date } : {});   // 지난 날짜면 다음 해로(날짜 여유 조회용)
            // 최소 주문 금액 맞춤은 손님 동의가 있어야 함: 앞선 답에서 맞춤을 물어본 적이 없으면 동의로 보지 않음(모델이 혼자 true를 넣는 것 막기)
            if (cin.topUpAgreed && !messages.some((m) => m.role === 'assistant' && typeof m.content === 'string' && /최소 주문 금액 맞춤|minimum order/i.test(m.content))) cin.topUpAgreed = false;
            out = await calculateQuote(cin);
            // 영어 손님이면 장소 안내 자리에 정해 둔 영어 문구를 넣음(매뉴얼 지시만으로는 한국어 원문이 가끔 그대로 나감)
            if (english && out.venueNoticeEn) out = Object.assign({}, out, { venueNotice: out.venueNoticeEn });
            if (askedBanner && Array.isArray(out.notes)) out = Object.assign({}, out, { notes: out.notes.filter((n) => !/현수막 위치를 아직 안 물어봤어요/.test(n)) });
            calcs.push(Object.assign({}, out, { _input: cin }));   // 같은 요청의 접수 문자 견적 줄에 씀(전기·현수막 칸에 쓰려고 넣은 조건도 같이)
            meta.tools.push({ name: 'calculate_quote', input: cin, status: out.status, subtotal: out.subtotal, mode: out.mode, region: out.region, items: out.items, costs: out.costs, banners: out.banners, capacity: out.capacity });   // 보드에서 견적서 품목 채울 때 씀
            // 연락처 전: 모델에게 금액을 넘기지 않음(ask) / 건너뛴 손님: 만 원 단위 대략 금액만(range) — 계산 결과 전체는 기록·접수 문자용으로 남김
            if (gate && out.status === 'ok') {
              const rough = roughAmount(out), c = calcs[calcs.length - 1];
              c._gate = gate; c._rough = rough; meta.tools[meta.tools.length - 1].gate = gate;
              const base = { menu: (out.items || []).map((x) => `${x.name} ${x.servings}인분`).join(', '), region: out.region, trucks: out.trucks, venueNotice: out.venueNotice,
                notes: (out.notes || []).filter((n) => !/\d{1,3}(,\d{3})+|\d+\s*만/.test(n)) };
              out = gate === 'ask'
                ? Object.assign(base, { status: 'contact_first', message: '[봇에게] 계산은 끝났어요. 연락처를 받기 전이라 금액은 말하지 마세요(합계·항목 금액·단가 곱셈 모두). 받은 조건(메뉴·인분·지역·날짜)만 한두 줄로 확인하고 끝내세요. 연락처·contact를 묻거나 필요하다고 말하는 문장은 쓰지 말고(화면이 연락처 카드를 띄움), 아직 접수 전이라 "접수"라는 말도 쓰지 마세요. 손님 언어로 답하세요.' })
                : Object.assign(base, { status: 'range_only', approx: english ? `about ${rough[0].toLocaleString('en-US')} KRW (VAT excluded, estimate)` : `대략 ${rough[0] / 10000}만 원(부가세 별도, 확정 전)`,
                  message: '[봇에게] 손님이 연락처 카드를 건너뛰었어요. approx 대략 금액만 그대로 보여 주세요(범위로 바꾸지 말 것). 항목별 금액·단가 곱셈·**합계** 줄은 쓰지 말고, 연락처를 다시 권하지 마세요(화면에 견적서 받기 버튼이 남아 있음). 손님이 연락처를 남기기 싫다고 했어도 대표번호를 붙이지 말고 이 금액으로 답하세요. 손님이 항목별 금액·출장비를 물으면 계산이 안 된 것처럼 말하지 말고 "항목별 금액은 [견적서 받기]로 번호나 이메일을 남겨 주시면 바로 보여 드려요"라고 이유를 말하세요. 할인 이야기는 손님이 묻기 전에는 하지 마세요. 손님 언어로 답하세요(영어 손님이면 영어).' });
            } else if (gate && out.status === 'below_minimum' && (out.items || []).length) {
              // 연락처 전 최소 미달: 항목 금액·음식값은 숨기고 모자란 금액과 두 가지 방법만(사용자 결정 11-26). 연락처를 받은 뒤에는 그대로 다 보여 줌
              const c = calcs[calcs.length - 1], w = (n) => Math.round(n).toLocaleString('ko-KR');
              c._gate = gate; c._min = true; meta.tools[meta.tools.length - 1].gate = gate;
              out = { status: 'below_minimum', menu: out.items.map((x) => `${x.label} ${x.qty}인분`).join(', '), minimum: out.minimum, short: out.short,
                message: `[봇에게] 음식값이 최소 주문 금액(음식값 ${w(out.minimum)}원, 부가세 별도, 출장비 따로)보다 ${w(out.short)}원 모자라요. 연락처를 받기 전이라 항목 금액(단가 × 수량 — 금액)과 음식값 합계는 쓰지 말고, 모자란 금액만 알려 주세요. 손님 동의 없이 금액을 더하지 말고 이렇게 물어보세요: "최소 주문은 음식값 ${w(out.minimum)}원부터인데, 말씀하신 메뉴는 ${w(out.short)}원이 모자라요. ① 메뉴·수량은 그대로 두고 모자란 ${w(out.short)}원을 '최소 주문 금액 맞춤'으로 더해 진행하거나 ② 메뉴나 수량을 늘려 맞추실 수 있어요. 어떻게 할까요?" 손님이 ①에 동의하면 topUpAgreed:true를 넣어 다시 계산하고, ②면 바꾼 메뉴·수량으로 다시 계산하세요. 연락처를 묻는 문장은 쓰지 마세요(화면이 연락처 카드를 띄움). '보정'이라는 말은 쓰지 말 것. 손님 언어로 답하세요.` };
            }
          } else if (tu.name === 'submit_lead' && badPhone(tu.input, userAll)) {
            // 010 번호는 11자리여야 하고, 손님이 쓴 숫자 그대로여야 함 — 아니면 접수하지 않고 다시 확인(11-27: 0101111111이 접수됨, 모델이 숫자를 보태 11자리로 만들기도 함)
            out = { status: 'check_phone', message: '[봇에게] 휴대폰 번호 자릿수가 맞지 않아 접수하지 않았어요(010 번호는 11자리). "번호가 한 자리 빠진 것 같아요. 다시 한 번 확인해 주시겠어요?"처럼 다시 물어보고, 접수했다고 말하지 마세요.' };
            meta.tools.push({ name: 'submit_lead', input: cleanLead(tu.input), status: 'check_phone' });
          } else if (tu.name === 'submit_lead' && !String((tu.input || {}).phone || '').trim() && !String((tu.input || {}).email || '').trim()) {
            out = { status: 'need_contact', message: '[봇에게] 번호나 이메일이 없어 접수하지 않았어요. 연락처를 받은 뒤에 다시 부르세요.' };
            meta.tools.push({ name: 'submit_lead', input: cleanLead(tu.input), status: 'need_contact' });
          } else if (tu.name === 'submit_lead') {
            const input = cleanLead(tu.input);   // 손님이 넣은 값 정리(문자·시트·보드 기록 모두 이 값)
            if (leadSent) input.isUpdate = true;   // 모델이 isUpdate를 빠뜨려 같은 손님이 '상담 신청'으로 여러 번 들어가던 일 막기
            else input.isUpdate = false;           // 반대로 첫 접수인데 모델이 isUpdate를 붙이면 '추가 정보'로 들어가 신규가 묻히던 일(11-25 dev 합본 시험)
            leadSent = true;
            const origDate = input.eventDate;
            const fd = fixPastDate(input.eventDate); input.eventDate = fd.date;
            // "일정" 칸(손님 말 그대로)에도 같은 날짜가 있으면 같이 고침 — 한 문자에 연도가 두 가지로 나오던 일
            if (fd.note && fd.date !== origDate && typeof input.datetime === 'string') input.datetime = input.datetime.split(origDate).join(fd.date);
            const history = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
            const botTexts = [...history, ...preTexts];
            out = await handleLead(input, { dateNote: fd.note, botTexts, calcs, history, sessionId, card: { shown: cardShown || cardSkipped, skipped: cardSkipped } });
            // 날짜가 있으면 그날 직영 여유(보드 '챗봇 상담'에 🟢/🟡/🟠로 표시 + 이후 응대 깊이)
            // 전기 없다는 말이 대화에 있었으면 발전기까지 따져서 판단 (예전엔 빠져서 발전기 모자란 날도 '여유'로 나왔음)
            const allUser = convo.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
            const powerOff = /전기\s*(가|는|도)?\s*(없|안\s*(돼|되|들어)|불가|모르)|콘센트\s*(가|는)?\s*없/.test(allUser);
            const cap = input.eventDate ? await capacityCheck(input.eventDate, input.menu || '', powerOff) : null;
            const guide = capacityGuide(cap); if (guide) out = Object.assign({}, out, { note: guide });
            // 연락처와 함께 온 질문을 접수 인사로 덮어 버리는 일이 잦아서 도구 결과에 다시 짚어 줌
            out = Object.assign({}, out, { reminder: '[봇에게] 손님의 마지막 말에 질문(결제·가격·가능 여부 등)이 있었다면 답의 첫 줄에서 그 질문에 먼저 답한 뒤 접수 안내를 하세요.' });
            meta.tools.push({ name: 'submit_lead', input, status: out.status, capacity: cap ? cap.level : undefined });
            meta.lead = true;
            leadKind = leadKind === 'new' || !input.isUpdate ? 'new' : 'update';   // 답 끝 접수 표시 줄 고르기
          } else {
            out = { error: 'unknown tool' };
          }
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(out),
          };
        };
        // 계산을 먼저 다 끝낸 뒤 접수(같은 답에서 둘 다 부르면 접수 문자에 새 견적이 실리게), 접수끼리는 차례로(두 번째가 '추가 정보'가 되게)
        const done = {};
        await Promise.all(toolUses.filter((tu) => tu.name !== 'submit_lead').map(async (tu) => { done[tu.id] = await runTool(tu); }));
        for (const tu of toolUses.filter((t) => t.name === 'submit_lead')) done[tu.id] = await runTool(tu);
        const results = toolUses.map((tu) => done[tu.id]);

        convo.push({ role: 'user', content: results });
        continue; // 결과를 넣고 한 번 더 AI에게 물어본다
      }

      // 도구 없이 바로 답한 경우 → 최종 답변 반환
      // 도구 전에 쓴 글 중 마지막 답에 이미 같은 말이 있는 문장은 뺌(같은 합계·"접수됐어요"가 두 번 보이던 문제)
      const finalText = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const key = (s) => s.replace(/[\s*#😊🙂🎉😅📞👍✅!.,~?]/g, '');
      const finalKey = key(finalText);
      // 같은 내용을 다른 말로 두 번 쓴 문단 거르기: 두 글자 묶음 겹침 비율(같은 뜻 중복 0.7~0.8 / 다른 내용 0~0.1, 시험 대화로 잼)
      const grams = (s) => { const k = key(s), g = new Set(); for (let j = 0; j < k.length - 1; j++) g.add(k.slice(j, j + 2)); return g; };
      const finalGrams = finalText.split('\n').filter((l) => key(l).length >= 10).map(grams);
      const nearDup = (l) => { const A = grams(l); if (A.size < 9) return false; return finalGrams.some((B) => { let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size) >= 0.6; }); };
      const ANNOUNCE = /접수|견적.{0,4}(나왔|뽑아|내\s*드릴)|계산해|확인해 드릴게요|정리해 드릴게요|감사해요!?$|감사합니다!?$/;
      const keptPre = preTexts.map((p) => p.split('\n').filter((l) => {
        const k = key(l); if (!k) return true;
        // "접수할게요" 같은 알림 줄은 빼되, "네, 카드 결제 가능해요! 접수할게요"처럼 질문 답이 섞인 줄은 남김
        if (ANNOUNCE.test(l.trim()) && l.trim().length < 60 && !/가능|돼요|됩니다|어려|안\s*돼|있어요|없어요/.test(l)) return false;
        if (k.length >= 6 && finalKey.includes(k)) return false;
        return !nearDup(l);   // 도구 전 글과 최종 글이 같은 내용이면 최종 글만
      }).join('\n').trim()).filter(Boolean);
      let reply = [...keptPre, finalText]
        .join('\n\n')
        .replace(/<br\s*\/?>/gi, '\n')                   // 답에 <br>이 글자 그대로 보이던 것
        .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')   // 채팅창에 그대로 보이는 구분선 줄 제거
        .replace(/^\s*>\s?/gm, '')                       // 인용 기호(>)도 그대로 보여서 제거
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      // 계산기 없이 지어낸 금액 막기(절대 규칙): 10만 원 이상 금액이 이번 계산 결과·앞선 답·손님 말·메뉴판·매뉴얼 어디에도 없으면 그 문장을 뺌
      // (11-23 실무자 시험: "츄러스+회오리감자 100인분이면 약 40만 원 안팎" — 계산기 없이 어림한 틀린 금액)
      {
        const known = new Set();
        const addNums = (s) => amounts(s).forEach((n) => [1, 0.1].forEach((k) => known.add(Math.round(n * k))));
        // 연락처 카드 전(ask)에는 이번 계산 금액을 아무것도 인정하지 않고, 건너뛴 손님(range)에는 대략 금액 한 숫자만 — 항목 금액이 새지 않게
        calcs.forEach((c) => (c._min ? [c.minimum, c.short] : c._gate === 'ask' ? [] : c._gate === 'range' ? c._rough : [c.subtotal, c.foodValue, c.minimum, c.short,
          ...Object.values(c.costs || {}), ...(c.items || []).map((i) => i.amount)]).forEach((n) => {
          if (Number(n) > 0) [1, 0.1].forEach((k) => known.add(Math.round(Number(n) * k)));   // 부가세 액수(10%)까지만 — 부가세 포함 금액은 손님에게 말하지 않음(대표 결정 11-25)
        }));
        messages.forEach((m) => addNums(typeof m.content === 'string' ? m.content : ''));
        addNums(menuText); addNums(SYSTEM_KNOWLEDGE);
        let dropped = false;
        const cleaned = reply.split('\n').map((line) => {
          if (!amounts(line).some((n) => n >= 100000 && !known.has(Math.round(n)))) return line;
          const keep = line.split(/(?<=[.?!。])\s+/).filter((sen) => !amounts(sen).some((n) => n >= 100000 && !known.has(Math.round(n))));
          dropped = true;
          return keep.length ? keep.join(' ') : null;
        }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (dropped && calcs.some((c) => c._gate)) {
          reply = cleaned;   // 카드 문장·대략 금액 안내가 뒤에 붙으므로 "계산해 드릴게요" 문장은 붙이지 않음
          meta.amountGuard = true;
        } else if (dropped) {
          // 부가세 포함 금액을 물은 답에서 빠진 것이면 부가세 안내 문장으로(계산해 드린다는 말은 맞지 않음)
          const vatAsk = /부가세|vat|tax/i.test(String((messages[messages.length - 1] || {}).content || ''));
          reply = (cleaned ? cleaned + '\n\n' : '') + (vatAsk ? (english ? 'All amounts exclude VAT. The 10% VAT is listed separately on the written quote.' : '안내 금액은 모두 부가세 별도예요. 부가세 10%는 견적서에 따로 적어 드려요.') : english ? 'Once the menu and quantity are set, I will calculate the exact amount right away.' : '메뉴와 인분을 정해 주시면 정확한 금액은 계산기로 바로 계산해 드릴게요.');
          meta.amountGuard = true;   // 상담 기록에서 이 장치가 걸린 답을 찾을 수 있게
        }
      }
      // 조율·확인이 필요한 답은 접수로 이어지게(전화로 넘기지 않음): 아직 번호를 안 받았고 이번 대화에서 연락처를 물은 적도 없으면 한 줄 붙임
      // (규칙 글만으로는 "인원·지역 알려 주세요"로 끝나는 경우가 있어 서버에서 보장)
      const userTexts = convo.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
      const hasPhone = PHONE_RE.test(userTexts) || EMAIL_RE.test(userTexts) || meta.lead;   // 이메일·회사 유선도 연락처로 봄
      const askedBefore = messages.some((m) => m.role === 'assistant' && /연락처|1877-6901/.test(String(m.content || '')));
      // "담당자 확인" 말이 목록 줄(- · •)에만 있으면 원칙 설명 같은 글이라 붙이지 않음(내부 지침 질문 답 끝에 연락처 요청이 붙던 일)
      const consultLine = reply.split('\n').some((l) => /담당자.{0,20}(확인|조율)/.test(l) && !/^\s*([-·•*]|\d+\.)\s/.test(l));
      // 견적이 한 번이라도 나온 대화에서만 붙임 — "노란색 차 있어요?" 같은 가벼운 문의에 곧바로 연락처를 묻던 일(11-23 실무자 시험)
      const quoteShown = /합계/.test(reply) || messages.some((m) => m.role === 'assistant' && /합계/.test(String(m.content || '')));
      if (!hasPhone && !gate && !askedBefore && consultLine && quoteShown && !/연락처|1877-6901/.test(reply)) {
        reply += '\n\n담당자가 확인해서 연락드릴 수 있게, 성함(회사명)과 연락처를 남겨 주시겠어요?';
      }
      // 연락처 요청은 한 대화에 한 번만: 앞 답에서 이미 물었고 아직 번호가 없으면 이번 답의 연락처 요청 줄을 뺌
      // (매뉴얼에 "한 번만"이 있어도 다시 계산할 때마다 또 묻던 일 — 손님이 진행 의사를 밝힌 답은 예외)
      // 모델이 "연락처만 남겨 주시겠어요?", 목록 줄 "- 연락처(휴대폰 번호)"처럼 모양을 바꿔 다시 묻던 일 → 연락처를 말하는 문장이면 모양과 상관없이 봄
      // "남겨 주시면 접수해 드릴게요"처럼 '연락처' 없이 번호를 다시 조르던 말도 포함(실제 상담 시험 55·70)
      const CONTACT = /연락처|휴대폰\s?번호|핸드폰\s?번호|전화\s?번호|번호를?\s?남겨|남겨\s?주신\s?번호|남겨\s?주(시면|세요|시겠).{0,12}(접수|연락)|contact (info|information|details|number)|phone number/i;   // 영어 손님 답도(연락처 카드 시험 CC-09)
      const askedContact = messages.some((m) => m.role === 'assistant' && CONTACT.test(String(m.content || '')));
      // 손님 마지막 말(글자). 바깥 lastUser(메시지 객체)와 이름이 같아 상담 기록에 손님 말이 빠지던 일(11-19~11-23) → 이름 분리
      const lastUserText = String((convo.filter((m) => m.role === 'user' && typeof m.content === 'string').pop() || {}).content || '');
      // 앞 답이 진행 질문(NEXT_STEP)으로 끝났고 손님이 "네/그걸로" 등으로 받았으면 진행 의사로 봄
      const NEXT_STEP = '이 구성으로 진행하실까요? 메뉴나 인원을 바꾸시려면 말씀해 주세요.';
      const prevBot = String((messages.filter((m) => m.role === 'assistant').pop() || {}).content || '');
      // "진행하게 되면 연락드리겠습니다"·"문의드리려고 연락드렸습니다" 같은 말은 진행 의사가 아님 → 분명한 말만
      const wantsGo = /(진행|예약|계약)\s?(할게|할께|하겠|해\s?주|해\s?줘|부탁|하고\s?싶|원해|할래|합시다)|예약할|확정\s?(할게|할께|하겠|해\s?주|이죠|인가요|으로\s?할)|접수\s?(해|부탁)|그걸로\s?할|이걸로\s?할/.test(lastUserText)
        || (prevBot.includes(NEXT_STEP) && /^\s*(네|넵|예|응|ㅇㅇ|ㅇㅋ|오케이|좋|그걸로|이걸로|그렇게|그래)/.test(lastUserText));
      // 챗봇이 "진행을 위해 아래 두 가지만 알려 주세요"처럼 진행 절차로 묻는 답이면 손님이 진행 의사를 보인 것 → 지우지 않음
      // (운영 시험 11-23: 연락처 줄만 지워져 "두 가지" 뒤에 성함 한 줄만 남음)
      const proceedAsk = /(진행|접수|예약|확정)(을|를)?\s?위해|진행하시려면|접수하시려면|진행해\s?드릴\s?수\s?있게/.test(reply);
      // 견적이 아직 없는 가벼운 문의("노란색 차 있어요?")에 모델이 바로 연락처를 묻는 것도 뺌 — 손님이 전화·연락을 원한 경우는 빼지 않음(11-23 실무자 시험)
      const casualAsk = !quoteShown && !/전화|통화|연락\s?(주|달|부탁|해)/.test(lastUserText);
      // 연락처 카드 대화(gate)에서는 모델이 쓴 연락처 요청 문장을 늘 뺌 — 카드가 받고, 건너뛴 손님에게는 다시 조르지 않음
      if (!hasPhone && (askedContact || casualAsk || gate) && !wantsGo && !proceedAsk) {
        // 연락처를 말하는 목록 줄은 통째로, 일반 줄은 그 문장만 빼고 나머지 문장은 남김
        reply = reply.split('\n').map((l) => {
          if (!CONTACT.test(l)) return l;
          if (/^\s*([-·•*]|\d+\.)\s/.test(l)) return null;
          const rest = l.split(/(?<=[.?!])\s+/).filter((s) => !CONTACT.test(s)).join(' ').trim();
          return rest || null;
        }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        // 연락처를 다시 묻지 않는 대신, 견적만 보여 주고 끝나 손님이 다음에 뭘 할지 모르는 일이 없게 진행 질문으로 마무리
        // 모델이 같은 진행 질문을 이미 썼으면(마침표로 끝나 '?' 판정에 안 걸림) 다시 붙이지 않음
        if (/합계/.test(reply) && !/[?？]\s*$/.test(reply) && !/진행하실(까요|지|래요)|진행할까요|진행하시겠어요/.test(reply) && !/(알려|말씀해)\s?주세요[.!]?\s*$/.test(reply)) reply += '\n\n' + NEXT_STEP;   // "어느 쪽으로 할지 알려 주세요."로 끝난 답에도 또 붙던 일(11-23)   // "진행하실지 알려 주세요"로 이미 물었는데 또 붙던 일(HKM-FS-09)
      }
      // 출력물·현수막·배너 문의면 "상단·중앙은 기본(서비스)"을 답 첫머리에 보장(11-23 사용자 의견 — 매뉴얼만으로는 8번 중 2번 빠짐)
      if (/출력물|인쇄물|현수막|배너/.test(lastUserText) && !english && !/상단·?\s?중앙/.test(reply.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n'))) reply = '상단·중앙 현수막은 기본으로 들어가요(서비스).\n\n' + reply;   // 첫 세 줄 안에 없으면(아래쪽에만 있어도) 맨 앞에
      // 대표번호는 손님이 전화·통화를 원하거나, 연락이 안 온다·급하다고 하거나, 번호를 안 남기겠다·삭제해 달라고 할 때만
      // (실제 상담 시험: 작별 인사·진행 상황 질문·이탈 손님 답 끝에 "대표번호로도 문의하실 수 있어요"가 습관처럼 붙던 일)
      const PHONE_OK = /전화|통화|연락\s?(이|을|도)?\s?(안|없|못|주)|급(해|하|한|히)|번호.{0,8}(싫|안\s?남|못\s?남|말고|부담)|남기기\s?(싫|어렵|부담)|삭제|지워|대표\s?번호|사무실\s?번호|고객\s?센터|(연락처|번호)\s?(좀|뭐|알려|어떻게|있)/;
      if (/1877-6901/.test(reply) && !PHONE_OK.test(lastUserText)) {
        reply = reply.split('\n').map((l) => {
          if (!/1877-6901/.test(l)) return l;
          const rest = l.split(/(?<=[.?!])\s+/).filter((s) => !/1877-6901/.test(s)).join(' ').trim();
          return rest || null;
        }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim() || reply;
      }
      // 연락처 카드: 이번에 금액을 막았으면(ask) 정해진 카드 문장 + 화면에 카드, 건너뛴 손님(range)은 처음 한 번만 안내 문장 + '견적서 받기' 버튼
      // (카드 문장에 '연락처'가 있어 다음 답부터는 연락처 재요청이 빠짐 — 한 번만 묻기와 같은 장치)
      let card = null;
      if (gate && !meta.lead) {
        const askNow = calcs.some((c) => c._gate === 'ask'), rangeNow = calcs.some((c) => c._gate === 'range');
        if (gate === 'ask' && (askNow || cardShown)) {
          // 카드를 이미 본 손님이 답하지 않고 질문을 이어 가면 큰 카드를 다시 띄우지 않고 작은 버튼 두 개만(시험 세션: 카드 반복 31/35)
          // 단, 손님이 진행하겠다고 하면 큰 카드를 다시 띄우고 모델의 연락처 요청 글은 그대로 둠
          // (그 글에서 연락처 줄만 빼면 "아래 두 가지만" 뒤에 한 줄만 남음 — 11-23과 같은 모양, CC3-01)
          const goNow = wantsGo || proceedAsk;
          card = cardShown && !goNow ? 'mini' : 'ask';
          // 그 밖에는 카드가 받으니 모델이 쓴 연락처 요청 문장을 뺌(카드와 이중 요청 — FC-FS-08)
          if (!goNow) reply = reply.split('\n').map((l) => {
            if (!CONTACT.test(l)) return l;
            if (/^\s*([-·•*]|\d+\.)\s/.test(l)) return null;
            return l.split(/(?<=[.?!])\s+/).filter((s) => !CONTACT.test(s)).join(' ').trim() || null;
          }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
          if (askNow && !cardShown) reply = (reply ? reply + '\n\n' : '') + (english ? CARD_LINE.en : CARD_LINE.ko);
        } else if (gate === 'range') {
          card = 'reopen';
          const rangeLineBefore = messages.some((m) => m.role === 'assistant' && (m.content.includes(RANGE_LINE.ko) || m.content.includes(RANGE_LINE.en)));
          if (rangeNow && !rangeLineBefore && !/\[견적서 받기\]|\[Get quote\]/.test(reply)) reply = (reply ? reply + '\n\n' : '') + (english ? RANGE_LINE.en : RANGE_LINE.ko);
        }
      }
      // 이미 접수한 대화에서 메뉴·수량을 바꿔 다시 계산했는데 모델이 추가 접수를 안 했으면, 담당자 문자에 옛 견적이 남지 않게 서버가 대신 보냄
      // (실제 상담 시험: 120개로 접수 → "140개로 견적 부탁"에 다시 계산만 하고 접수 갱신 없음)
      const lastCalc = calcs.filter((c) => c && c.status === 'ok').pop();
      // 부가세만 묻는 등 같은 금액으로 다시 계산한 경우는 보내지 않음(앞서 안내한 합계 줄 중 숫자가 같은 게 있으면)
      const digits = (s) => String(s || '').replace(/[^\d~]/g, '');
      const prevSums = messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || '')).join('\n').match(/(합계|Total)[^\n]*/g) || [];   // 영어 답은 "Total"
      const sameQuote = lastCalc && prevSums.some((l) => digits(l) === digits(lastCalc.summaryLine));
      // 같은 답에서 서로 다른 견적을 여럿 계산했으면 손님이 고르기 전의 비교(예: 발전기·현수막을 넣으면 얼마) → 자동 전달 안 함(HKM-FS-14)
      const shownOptions = new Set(calcs.filter((c) => c && c.status === 'ok').map((c) => c.summaryLine)).size;
      // 메뉴·인분이 앞서 보여 준 그대로면(현수막·발전기 같은 옵션만 넣어 본 계산) 손님이 바꾼 게 아님 → 자동 전달 안 함
      const prevBotText = messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || '')).join('\n');
      const sameItems = lastCalc && (lastCalc.items || []).length > 0 && (lastCalc.items || []).every((i) => new RegExp(`${i.servings}\\s?(인분|잔|개|명|servings?|cups?|portions?)`, 'i').test(prevBotText));
      if (leadBefore && !meta.lead && lastCalc && !sameQuote && shownOptions <= 1 && !sameItems) {
        const phones = userTexts.match(/010[-\s.]?\d{4}[-\s.]?\d{4}|01[16789][-\s.]?\d{3,4}[-\s.]?\d{4}/g) || [];
        const input = {
          contactName: '(앞 접수와 같은 손님)',
          phone: phones.length ? phones[phones.length - 1] : '',
          email: (userTexts.match(EMAIL_RE) || [])[0] || '',   // 이메일만 준 손님(번호 없음)
          menu: (lastCalc.items || []).map((i) => `${i.name} ${i.servings}`).join(', '),
          region: lastCalc.region || '',
          note: '손님이 접수 뒤 견적을 바꿈(챗봇이 바뀐 견적으로 자동 전달)',
          isUpdate: true,
        };
        const history = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
        const out = await handleLead(input, { botTexts: [...history, ...preTexts], calcs, history, sessionId });
        meta.tools.push({ name: 'submit_lead', input, status: out.status, auto: true });
        meta.lead = true;
        leadKind = leadKind || 'update';
      }
      // 손님이 번호·이메일을 줬는데 모델이 접수(submit_lead)를 빠뜨렸으면 서버가 대신 접수 — 접수 손실 막기
      // (회귀 재생 11-26: 번호를 받고 견적만 보여 준 뒤, 다음 답에서 도구 없이 "접수해 두었어요"라고 함)
      if (!leadBefore && !meta.lead && (PHONE_RE.test(userTexts) || EMAIL_RE.test(userTexts))) {
        const phones = userTexts.match(new RegExp(PHONE_RE.source, 'g')) || [];
        const input = {
          contactName: '미기재',
          phone: phones.length ? phones[phones.length - 1] : '',
          email: (userTexts.match(EMAIL_RE) || [])[0] || '',
          menu: lastCalc ? (lastCalc.items || []).map((i) => `${i.name} ${i.servings}`).join(', ') : '',
          region: lastCalc ? lastCalc.region || '' : '',
          note: '챗봇이 접수를 빠뜨려 서버가 대신 접수함 — 성함·세부 내용은 상담 기록에서 확인',
        };
        const history = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
        const out = await handleLead(input, { botTexts: [...history, ...preTexts], calcs, history, sessionId, card: { shown: cardShown || cardSkipped, skipped: cardSkipped } });
        meta.tools.push({ name: 'submit_lead', input, status: out.status, auto: true });
        meta.lead = true;
        leadKind = leadKind || 'new';
      }
      // 한국어로 돌아온 손님에게 앞 턴의 영어 장소 안내를 그대로 다시 쓰는 일(Haiku 회귀 1턴) → 정해 둔 한국어 원문으로 바꿈
      if (!english) reply = reply.split(VENUE_NOTICE_EN_FULL).join(VENUE_NOTICE_FULL).split(VENUE_NOTICE_EN_SHORT).join(VENUE_NOTICE_SHORT);
      // 이번 요청에서 접수했으면 답 끝에 정해진 접수 표시 줄(다음 턴의 '이미 접수됨' 판단 근거 + 손님에게도 분명히)
      reply = reply.replace(LEAD_MARK_ANY, '').replace(/\n{3,}/g, '\n\n').trim();   // 표시 줄은 서버만 붙임
      // 모델이 쓴 "✅ 접수가 완료됐어요" 같은 줄은 ✅만 빼고 글은 남김 — 접수 표시(✅)는 서버 줄 하나만(운영 시험 11-23: ✅ 줄 두 개)
      reply = reply.replace(/^([ \t]*)✅\s*/gm, '$1');
      // 모델이 접수 표시 문장을 그대로 썼으면(✅만 빠진 같은 문장) 줄째 뺌 — 서버 줄과 같은 문장이 두 번 보이던 일(FC-FS-05)
      const markTexts = LEAD_MARKS.map((t) => t.replace(/^✅\s*/, ''));
      reply = reply.split('\n').filter((l) => !markTexts.includes(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (leadKind) reply += '\n\n' + (english ? LEAD_MARK.en : leadKind === 'update' ? LEAD_MARK.koUpdate : LEAD_MARK.ko);
      // 상담 기록은 답을 먼저 보낸 뒤 저장 (손님 대기 시간 줄이기). Vercel이 응답 뒤에도 끝까지 기다리게 waitUntil 사용,
      // 그 기능이 없는 곳(로컬 시험 서버 등)에서는 예전처럼 저장하고 나서 보냄
      // 이번 답의 비용(달러) — 대화 기록(meta.usage)에 남겨 보드에서 대화별 비용을 볼 수 있게
      const pr = PRICE[MODEL.replace(/-\d{8}$/, '')];
      if (pr) usage.usd = Math.round(((usage.input * pr.in + usage.output * pr.out + usage.cacheWrite * pr.cw + usage.cacheRead * pr.cr) / 1e6) * 1e5) / 1e5;
      meta.usage = usage;
      const logP = logChat({ sessionId, page, userText: lastUser && lastUser.content, reply, meta }).catch(() => {});
      const vctx = globalThis[Symbol.for('@vercel/request-context')];
      const ctx = vctx && typeof vctx.get === 'function' ? vctx.get() : null;
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(logP); else await logP;
      // 음료 구성을 묻는 답이면 화면 아래(입력칸 위)에 '음료 고르기' 버튼을 띄우게 목록을 같이 보냄
      // (대화가 길면 메뉴는 위, 답은 아래라 손님이 위아래로 오가야 했음)
      const picker = drinkPicker(reply);
      return res.status(200).json(Object.assign({ reply, usage }, picker ? { picker } : {}, card ? { card } : {}));
    }

    // 도구를 여러 번 부르다 최종 답을 못 받고 끝난 경우: 이번 요청에서 이미 접수했으면 손님이 다시 보내 중복 접수되지 않게 접수됐다고 알림
    if (leadKind) {
      const done = english ? 'Your request has been received. Our staff will contact you soon.' : '접수는 됐어요. ' + contactWhen();
      return res.status(200).json({ reply: done + '\n\n' + (english ? LEAD_MARK.en : leadKind === 'update' ? LEAD_MARK.koUpdate : LEAD_MARK.ko) });
    }
    // 이 경로도 상담 기록에 남김(전에는 기록이 빠져 주간 점검에서도 안 보였음)
    await logChat({ sessionId, page, userText: lastUser && lastUser.content, reply: '(도구 반복 끝, 답 없음)', meta: Object.assign(meta, { usage, fallback: true }) }).catch(() => {});
    await alertFailure('error', { where: '도구 반복 끝(답 없음)', reason: `도구 ${meta.tools.length}회 뒤 최종 답 없음`, sessionId });
    return res.status(200).json({ reply: '죄송해요, 잠시 후 다시 시도해 주세요.' });
  } catch (e) {
    await alertFailure('error', { where: '서버 예외', reason: String((e && e.message) || e).slice(0, 300), sessionId: (req.body && req.body.sessionId) || '' });
    return res.status(500).json({ error: String(e) });
  }
};
