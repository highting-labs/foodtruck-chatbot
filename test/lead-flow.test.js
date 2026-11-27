// test/lead-flow.test.js — 상담 접수 흐름·견적 계산 회귀 시험
// 실행: node --test test/
// 바깥 서비스는 전부 가짜(fetch를 바꿔 끼움) — 모르는 주소로 나가면 시험이 실패한다. 실제 문자·시트·보드 DB에는 아무것도 가지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');

// 환경변수는 모듈을 읽기 전에(주소 상수가 읽는 시점에 정해짐). 전부 가짜 값.
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'test', CHAT_LOG_KEY: 'test-key', RL_OFF: '1',
  SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '0212345678', ALERT_TO: '01000000000',
  SHEET_WEBHOOK_URL: 'https://sheet.test/hook', SLACK_WEBHOOK_QUOTE: 'https://slack.test/quote',
});
delete process.env.SLACK_WEBHOOK_LEAD;

const handler = require('../api/chat.js');
const { calculateQuote } = require('../lib/quote-engine.js');
const { ownContacts, vetContact } = require('../lib/contact.js');

const MARK = '✅ 상담 접수 완료 — 담당자에게 전달됐어요';
const MARK_UPDATE = '✅ 추가 정보 전달 완료 — 담당자에게 전달됐어요';
const MARK_STORED = '✅ 상담 접수 완료 — 담당자가 확인 후 연락드려요';

// 모델 답 만들기
const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
let tid = 0;
const tool = (name, input) => ({ content: [{ type: 'tool_use', id: 't' + ++tid, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
const BASIC200 = { items: [{ name: '베이직세트(커피음료 7종)', servings: 200 }], region: '강남구' };

/** 가짜 바깥 서비스와 함께 대화 한 턴을 돌린다. */
async function run({ messages, script, solapi = 'ok', slackLead = null, sheet = 'ok', chatlog = 'ok', sessionId = 'test-session-0001' }) {
  const calls = { sms: [], slackLead: [], slackQuote: [], sheet: [], chatlog: [], model: 0 };
  const queue = [...script];
  if (slackLead) process.env.SLACK_WEBHOOK_LEAD = 'https://slack.test/lead'; else delete process.env.SLACK_WEBHOOK_LEAD;
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url), body = opt.body ? JSON.parse(opt.body) : null;
    if (u.startsWith('https://api.anthropic.com/')) { calls.model++; if (!queue.length) throw new Error('모델 답이 모자람'); return json(200, queue.shift()); }
    if (u.startsWith('https://api.solapi.com/')) { calls.sms.push(body.message.text); return solapi === 'ok' ? json(200, { statusCode: '2000' }) : json(400, { errorMessage: 'NotEnoughBalance' }); }
    if (u === 'https://slack.test/lead') { calls.slackLead.push(body.text); return json(slackLead === 'ok' ? 200 : 500, {}); }
    if (u === 'https://slack.test/quote') { calls.slackQuote.push(body.text); return json(200, {}); }
    if (u === 'https://sheet.test/hook') { calls.sheet.push(body); return json(sheet === 'ok' ? 200 : 500, {}); }
    if (u.startsWith('https://sb.test/rest/v1/rpc/chat_log_add')) { calls.chatlog.push(body.p_rows); return json(chatlog === 'ok' ? 200 : 500, {}); }
    if (u.startsWith('https://sb.test/rest/v1/rpc/capacity_check')) return json(500, {});   // 여유 조회는 실패로(없어도 접수는 됨)
    if (u.startsWith('https://sb.test/rest/v1/site_menus')) return json(500, {});            // 메뉴는 저장소의 스냅숏으로
    throw new Error('시험이 모르는 주소로 나감: ' + u);
  };
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  try { await handler({ method: 'POST', body: { messages, sessionId, page: 'test' }, headers: {} }, res); }
  finally { global.fetch = realFetch; }
  const logged = calls.chatlog.flat().find((r) => r.role === 'assistant');
  const leads = logged && logged.meta ? (logged.meta.tools || []).filter((t) => t.name === 'submit_lead') : [];
  return { reply: (res.body && res.body.reply) || '', body: res.body, code: res.code, calls, leads, meta: logged && logged.meta };
}
const lastLine = (s) => s.trim().split('\n').pop().trim();

// ───────── 견적 계산 회귀(계산기 결과가 바뀌면 여기서 걸림) ─────────
test('견적: 베이직세트 200잔 강남구 = 음식 70만 + 출장비 10만', async () => {
  const q = await calculateQuote(BASIC200);
  assert.equal(q.status, 'ok');
  assert.equal(q.foodValue, 700000);
  assert.equal(q.costs.출장비, 100000);
  assert.equal(q.subtotal, 800000);
  assert.equal(q.costs.최소주문맞춤, 0);
});

test('견적: 실속세트 50잔은 최소 주문 금액 미달(45만 원 모자람) — 동의 전에는 더하지 않음', async () => {
  const q = await calculateQuote({ items: [{ name: '실속세트(커피음료 2종)', servings: 50 }], region: '강남구' });
  assert.equal(q.status, 'below_minimum');
  assert.equal(q.minimum, 600000);
  assert.equal(q.short, 450000);
});

test('견적: 최소 주문 금액 맞춤은 동의(topUpAgreed)했을 때만 더해짐', async () => {
  const q = await calculateQuote({ items: [{ name: '실속세트(커피음료 2종)', servings: 50 }], region: '강남구', topUpAgreed: true });
  assert.equal(q.status, 'ok');
  assert.equal(q.costs.최소주문맞춤, 450000);
  assert.equal(q.foodValue + q.costs.최소주문맞춤, 600000);
  assert.equal(q.subtotal, 700000);
});

test('견적: 최소 인분(50) 미만은 계산하지 않음', async () => {
  const q = await calculateQuote({ items: [{ name: '베이직세트(커피음료 7종)', servings: 30 }], region: '강남구' });
  assert.equal(q.status, 'below_min_servings');
});

test('견적: 인원을 200 → 250으로 바꾸면 음식값만 그만큼 늘어남', async () => {
  const a = await calculateQuote(BASIC200);
  const b = await calculateQuote({ items: [{ name: '베이직세트(커피음료 7종)', servings: 250 }], region: '강남구' });
  assert.equal(b.foodValue - a.foodValue, 3500 * 50);
  assert.equal(b.costs.출장비, a.costs.출장비);
});

test('견적: 전기가 없으면 자가발전기 비용이 붙고, 말하지 않았으면 붙지 않음', async () => {
  const none = await calculateQuote(BASIC200);
  const off = await calculateQuote(Object.assign({}, BASIC200, { powerAvailable: false }));
  assert.equal(none.costs.자가발전기, 0);
  assert.ok(off.costs.자가발전기 > 0);
  assert.equal(off.subtotal - none.subtotal, off.costs.자가발전기);
});

// ───────── 연락처 판정 ─────────
test('연락처 판정: 남의 번호로 말한 것은 손님 연락처가 아님', () => {
  const u = (content) => [{ role: 'user', content }];
  assert.deepEqual(ownContacts(u('관리실 번호는 02-123-4567이에요')).phones, []);
  assert.deepEqual(ownContacts(u('베이직세트 200잔 강남구 견적 주세요. 행사장 관리실 번호는 02-123-4567이에요')).phones, []);   // 앞 문장의 "견적 주세요"에 속지 않음
  assert.deepEqual(ownContacts(u('현장 담당자분 번호는 010-5555-0188입니다. 이쪽으로 연락 주세요.')).phones, ['010-5555-0188']);
  assert.deepEqual(ownContacts(u('관리실 번호는 02-123-4567이에요. 견적서는 메일로 보내 주세요.')).phones, []);
  assert.deepEqual(ownContacts(u('친구 010-2222-3333 한테 들었어요')).phones, []);
  assert.deepEqual(ownContacts(u('I need 200 cups in Gangnam-gu. The venue office number is 02-123-4567.')).phones, []);   // 실제 모델 시험에서 대신 접수되던 문장
  assert.deepEqual(ownContacts(u("My friend's phone number is 010-2222-3333")).phones, []);
  assert.deepEqual(ownContacts(u('My office number is 02-123-4567')).phones, ['02-123-4567']);
  assert.deepEqual(ownContacts(u('You can reach me at 010-5555-0144')).phones, ['010-5555-0144']);
  assert.deepEqual(ownContacts(u('The venue manager number is 010-5555-0144, please call him')).phones, ['010-5555-0144']);
  assert.deepEqual(ownContacts(u('010-2222-3333은 경비실이에요')).phones, []);
  assert.deepEqual(ownContacts(u('010-2222-3333 이 번호로는 연락하지 마세요')).phones, []);
  assert.deepEqual(ownContacts(u('010-5555-0199')).phones, ['010-5555-0199']);
  assert.deepEqual(ownContacts(u('베이직세트 200잔이요. 제 번호는 010-5555-0199')).phones, ['010-5555-0199']);
  assert.deepEqual(ownContacts(u('현장 담당자분 010-5555-0199로 연락 주세요')).phones, ['010-5555-0199']);   // 그 번호로 연락해 달라고 하면 연락처
  assert.deepEqual(ownContacts(u('담당자 김대리 010-5555-0199 입니다')).phones, ['010-5555-0199']);          // 회사 담당자 번호는 연락처
  assert.deepEqual(ownContacts(u('견적서 받을 곳: 010-5555-0199')).phones, ['010-5555-0199']);               // 연락처 카드
  assert.deepEqual(ownContacts(u('대표님 생신 행사예요. 010-5555-0199')).phones, ['010-5555-0199']);
  assert.deepEqual(ownContacts(u('친구 결혼식이에요. 메일은 a.b@example.com')).emails, ['a.b@example.com']);
});

test('연락처 판정: 남의 번호도 챗봇이 확인하고 손님이 그렇다고 하면 연락처', () => {
  const m = [{ role: 'user', content: '관리실 번호는 02-123-4567이에요' },
    { role: 'assistant', content: '견적서와 확인 연락을 이 번호로 드리면 될까요? 아니면 다른 연락처를 남겨 주시겠어요?' },
    { role: 'user', content: '네 그 번호로 주세요' }];
  assert.deepEqual(ownContacts(m).phones, ['02-123-4567']);
  m[2].content = '아니요 제 번호는 010-5555-0199예요';
  assert.deepEqual(ownContacts(m).phones, ['010-5555-0199']);
});

test('접수 검사: 자릿수·손님 글에 없는 번호·이메일 모양', () => {
  const m = [{ role: 'user', content: '연락처 0101111111, 메일 a.b@example.com' }];
  assert.equal(vetContact({}, m).status, 'need_contact');
  assert.equal(vetContact({ phone: '0101111111' }, m).status, 'check_phone');
  assert.equal(vetContact({ phone: '010-1111-1111' }, m).status, 'check_phone');        // 모델이 숫자를 보탠 번호
  assert.equal(vetContact({ email: 'a.b@example' }, m).status, 'check_email');
  assert.equal(vetContact({ email: 'other@example.com' }, m).status, 'check_email');     // 손님 글에 없는 주소
  assert.deepEqual(vetContact({ phone: '010-1111-1111', email: 'a.b@example.com' }, m), { status: null, dropPhone: true, dropEmail: false });
  assert.equal(vetContact({ phone: '0101111111' }, m).reason, 'length');
  assert.equal(vetContact({ phone: '010-1111-1111' }, m).reason, 'mismatch');
  // 한글로 적은 번호는 정상 번호(11-27 회귀 FS-05: 계속 거절돼 접수 손실)
  const ko = [{ role: 'user', content: '제 번호는 공일공 공공공공 일일공오 입니다' }];
  assert.equal(vetContact({ phone: '010-0000-1105' }, ko).status, null);
  assert.equal(vetContact({ phone: '010-0000-1106' }, ko).status, 'check_phone');
  assert.equal(vetContact({ phone: '010-1234-5678' }, [{ role: 'user', content: '010 일이삼사 5678' }]).status, null);
  const ok = [{ role: 'user', content: '010 5555 0199 입니다' }];
  assert.equal(vetContact({ phone: '010-5555-0199' }, ok).status, null);
  assert.equal(vetContact({ phone: '02-123-4567' }, [{ role: 'user', content: '관리실 번호는 02-123-4567' }]).status, 'confirm_contact');
});

// ───────── 접수 흐름 ─────────
test('정상 번호로 접수: 문자 1건·시트 1건·"전달됐어요" 표시, 가정한 값이 구분돼 남음', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '010-5555-0199', region: '강남구', menu: '베이직세트 200잔', drinkChoice: '기본 구성(임시) · 담당자 확인' }), text('**합계 800,000원**\n접수했어요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.equal(r.calls.sheet.length, 1);
  assert.equal(lastLine(r.reply), MARK);
  assert.match(r.calls.sms[0], /연락처: 010-5555-0199/);
  assert.match(r.calls.sms[0], /견적: 800,000원/);
  assert.equal(r.leads.length, 1);
  assert.deepEqual(r.leads[0].delivery, { alert: 'ok', channel: 'sms', sheet: 'ok' });
  assert.equal(r.meta.leadState, 'delivered');
  assert.equal(r.leads[0].fields.said.phone, '010-5555-0199');
  assert.equal(r.leads[0].fields.computed.subtotal, 800000);
});

test('전기·현수막을 말하지 않은 접수: 알림에 "확인 필요", 기록에는 가정한 값·확인할 것으로 구분', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' }],
    // 모델이 묻지도 듣지도 않은 현수막 값(빈 배열)을 넣어도 서버가 뺌
    script: [tool('calculate_quote', Object.assign({}, BASIC200, { sideBanners: [] })), tool('submit_lead', { contactName: '미기재', phone: '010-5555-0199', menu: '베이직세트 200잔', drinkChoice: '기본 구성(임시) · 담당자 확인' }), text('접수했어요.')],
  });
  assert.match(r.calls.sms[0], /전기: 확인 필요\(있다고 보고 계산\)/);
  assert.match(r.calls.sms[0], /현수막: 확인 필요\(상단·중앙 기본\)/);
  assert.match(r.calls.sms[0], /견적서 빈 칸: .*전기, 출력물\(현수막\)/);
  const f = r.leads[0].fields;
  assert.deepEqual(f.assumed, ['전기 220V 연결 가능', '현수막 상단·중앙만', '음료 기본 구성', '배식 3시간']);
  assert.ok(f.needsCheck.includes('전기') && f.needsCheck.includes('출력물(현수막)') && f.needsCheck.includes('주소'));
  assert.equal(f.said.drinkChoice, undefined);
});

test('손님이 전기 없음·좌우 현수막을 말한 접수: 가정으로 적지 않음', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구, 전기는 없고 좌우 현수막도 해주세요. 010-5555-0199' }],
    script: [tool('calculate_quote', Object.assign({}, BASIC200, { powerAvailable: false, sideBanners: ['좌', '우'] })), tool('submit_lead', { contactName: '미기재', phone: '010-5555-0199', menu: '베이직세트 200잔' }), text('접수했어요.')],
  });
  assert.match(r.calls.sms[0], /전기: 없음\(자가발전기 포함\)/);
  assert.match(r.calls.sms[0], /현수막: 상단·중앙 \+ 좌·우/);
  assert.ok(!r.leads[0].fields.assumed.includes('전기 220V 연결 가능'));
  assert.ok(!r.leads[0].fields.assumed.includes('현수막 상단·중앙만'));
});

test('잘못된 번호(10자리 010): 모델이 숫자를 보태 접수하려 해도 접수 안 됨, 접수 표시 없음', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적, 연락처 0101111111' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '010-1111-1111', menu: '베이직세트 200잔' }), text('번호가 한 자리 빠진 것 같아요. 다시 확인해 주시겠어요?')],
  });
  assert.equal(r.calls.sms.length, 0);
  assert.equal(r.calls.sheet.length, 0);
  assert.ok(!r.reply.includes('✅'));
  assert.equal(r.leads[0].status, 'check_phone');
  // 보드가 접수 연락처로 읽는 input에는 받아들이지 않은 번호가 없음
  assert.equal(r.leads[0].input.phone, undefined);
  assert.deepEqual(r.leads[0].rejected, { phone: '010-1111-1111' });
});

test('보드 연동 계약: 접수 기록의 기존 칸(name·input·status)과 접수 판정 값(submitted·received)은 그대로', async () => {
  const ok = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script() });
  const failed = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), solapi: 'fail' });
  for (const [r, status] of [[ok, 'submitted'], [failed, 'received']]) {
    const t = r.leads[0];
    assert.equal(t.name, 'submit_lead');
    assert.equal(t.status, status);
    assert.equal(t.input.phone, '010-5555-0199');
    assert.equal(t.input.menu, '베이직세트 200잔');
    assert.equal(r.meta.lead, true);
    assert.ok(r.meta.tools.some((x) => x.name === 'calculate_quote'));
  }
});

test('한글로 적은 번호: 모델이 숫자로 바꿔 접수하면 접수됨', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 견적서 받을 곳: 공일공 공공공공 일일공오' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '010-0000-1105', menu: '베이직세트 200잔' }), text('접수했어요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /연락처: 010-0000-1105/);
  assert.equal(lastLine(r.reply), MARK);
});

test('남의 번호만 말한 대화: 서버가 대신 접수하지 않고, 연락처 카드 단계 그대로', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구요. 행사장 관리실 번호는 02-123-4567이에요' }],
    script: [tool('calculate_quote', BASIC200), text('베이직세트 200잔, 강남구로 확인했어요.')],
  });
  assert.equal(r.calls.sms.length, 0);
  assert.equal(r.calls.sheet.length, 0);
  assert.ok(!r.reply.includes('✅'));
  assert.ok(!/800,000/.test(r.reply), '연락처 전에는 금액을 보여 주지 않음');
  assert.match(r.reply, /견적서를 받으실 연락처/);
});

test('남의 번호를 모델이 접수하려 하면 먼저 확인하게 하고, 손님이 그렇다고 하면 접수', async () => {
  const first = [{ role: 'user', content: '베이직세트 200잔 강남구요. 행사장 관리실 번호는 02-123-4567이에요' }];
  const a = await run({ messages: first, script: [tool('submit_lead', { contactName: '미기재', phone: '02-123-4567', menu: '베이직세트 200잔' }), text('견적서와 확인 연락을 이 번호로 드리면 될까요? 아니면 다른 연락처를 남겨 주시겠어요?')] });
  assert.equal(a.calls.sms.length, 0);
  assert.equal(a.leads[0].status, 'confirm_contact');
  const b = await run({
    messages: [...first, { role: 'assistant', content: a.reply }, { role: 'user', content: '네 그 번호로 주세요' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '02-123-4567', menu: '베이직세트 200잔' }), text('접수했어요.')],
  });
  assert.equal(b.calls.sms.length, 1);
  assert.match(b.calls.sms[0], /연락처: 02-123-4567/);
  assert.equal(lastLine(b.reply), MARK);
});

test('연락처 없는 접수 시도: 접수 안 됨', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구로 상담 신청할게요' }],
    script: [tool('submit_lead', { contactName: '홍길동', menu: '베이직세트 200잔' }), text('연락처를 남겨 주시겠어요?')],
  });
  assert.equal(r.calls.sms.length, 0);
  assert.equal(r.calls.sheet.length, 0);
  assert.ok(!r.reply.includes('✅'));
  assert.equal(r.leads[0].status, 'need_contact');
  assert.match(r.reply, /연락처/, '모델 답이 연락처 요청 한 문장뿐이어도 빈 답이 나가지 않음');
});

test('번호를 받았는데 모델이 접수를 빠뜨리면 서버가 대신 접수(1건만)', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' }],
    script: [tool('calculate_quote', BASIC200), text('**합계 800,000원**')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /서버가 대신 접수/);
  assert.equal(lastLine(r.reply), MARK);
});

test('중복 접수: 같은 답에서 같은 내용을 두 번 접수해도 알림은 1건', async () => {
  const lead = { contactName: '미기재', phone: '010-5555-0199', menu: '베이직세트 200잔' };
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', lead), tool('submit_lead', lead), text('접수했어요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.equal(r.calls.sheet.length, 1);
  assert.equal(r.leads.filter((l) => l.duplicate).length, 1);
});

test('중복 접수: 이미 접수한 대화의 다음 접수는 새 접수가 아니라 "추가 정보"', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' },
      { role: 'assistant', content: '**합계 800,000원**\n접수했어요.\n\n' + MARK },
      { role: 'user', content: '이름은 홍길동입니다' }],
    script: [tool('submit_lead', { contactName: '홍길동', phone: '010-5555-0199', menu: '베이직세트 200잔' }), text('성함 전달했어요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /^\[푸드트럭하우스 챗봇 상담 · 추가 정보/);
  assert.equal(lastLine(r.reply), MARK_UPDATE);
});

test('접수 뒤 인원 변경: 모델이 다시 접수하지 않아도 바뀐 견적이 자동 전달됨', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' },
      { role: 'assistant', content: '- 베이직세트 3,500원 × 200잔 — 700,000원\n- 출장비(강남구) — 100,000원\n**합계 800,000원** (부가세 별도)\n\n' + MARK },
      { role: 'user', content: '250잔으로 바꿔 주세요' }],
    script: [tool('calculate_quote', { items: [{ name: '베이직세트(커피음료 7종)', servings: 250 }], region: '강남구' }), text('**합계 975,000원** (부가세 별도)')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /견적 변경\(자동 전달\)/);
  assert.match(r.calls.sms[0], /800,000원 → 975,000원/);
  assert.match(r.calls.sms[0], /연락처: 010-5555-0199/);
  assert.equal(lastLine(r.reply), MARK_UPDATE);
});

test('최소 주문 금액 미달인데 고르기 전에 접수: 알림에 "손님 선택 전" 표시, 금액을 더하지 않음', async () => {
  const r = await run({
    messages: [{ role: 'user', content: '실속세트 50잔 견적, a.b@example.com 으로 보내주세요' }],
    script: [tool('calculate_quote', { items: [{ name: '실속세트(커피음료 2종)', servings: 50 }] }), tool('submit_lead', { contactName: '미기재', email: 'a.b@example.com', menu: '실속세트 50잔' }), text('접수했어요. 두 가지 중 골라 주세요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /최소 주문 금액 미달\(450,000원 모자람\) · 손님 선택 전/);
  assert.ok(!/최소 주문 금액 맞춤 \+/.test(r.calls.sms[0]));
  assert.deepEqual(r.leads[0].fields.computed, { status: 'below_minimum', minimum: 600000, short: 450000 });
});

// ───────── 알림·기록 실패 ─────────
const LEAD_TURN = {
  messages: [{ role: 'user', content: '베이직세트 200잔 강남구 견적 주세요. 010-5555-0199' }],
  script: () => [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '010-5555-0199', menu: '베이직세트 200잔' }), text('접수했어요.')],
};

test('문자 실패 + 슬랙 접수 채널 성공: 전달된 것으로 봄', async () => {
  const r = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), solapi: 'fail', slackLead: 'ok' });
  assert.equal(r.calls.slackLead.length, 1);
  assert.equal(lastLine(r.reply), MARK);
  assert.equal(r.leads[0].delivery.channel, 'slack');
});

test('문자·슬랙 알림 실패 + 시트 기록 성공: "전달됐어요" 대신 "확인 후 연락", 장애 알림에는 손님 번호 없음', async () => {
  const r = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), solapi: 'fail' });
  assert.equal(lastLine(r.reply), MARK_STORED);
  assert.deepEqual(r.leads[0].delivery, { alert: 'fail', sheet: 'ok' });
  assert.equal(r.meta.leadState, 'stored');
  assert.equal(r.calls.slackQuote.length, 1);
  assert.match(r.calls.slackQuote[0], /접수 문자 발송 실패/);
  assert.match(r.calls.slackQuote[0], /구글 시트 기록: 됨/);
  assert.ok(!/5555/.test(r.calls.slackQuote[0]));
});

test('시트 기록 실패 + 문자 성공: 접수는 전달됨, 기록 실패가 남음', async () => {
  const r = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), sheet: 'fail' });
  assert.equal(lastLine(r.reply), MARK);
  assert.equal(r.leads[0].delivery.sheet, 'fail');
  assert.equal(r.calls.sms.length, 1);
});

test('알림·시트 실패 + 상담 기록 성공: 접수는 남았으므로 "확인 후 연락"', async () => {
  const r = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), solapi: 'fail', sheet: 'fail' });
  assert.equal(lastLine(r.reply), MARK_STORED);
  assert.equal(r.meta.leadState, 'pending');
  assert.match(r.calls.slackQuote[0], /구글 시트 기록: 실패/);
});

test('알림·시트·상담 기록 모두 실패: 접수됐다고 하지 않고 다시 보내 달라고 안내', async () => {
  const r = await run({ messages: LEAD_TURN.messages, script: LEAD_TURN.script(), solapi: 'fail', sheet: 'fail', chatlog: 'fail' });
  assert.ok(!r.reply.includes('✅'));
  assert.ok(!/접수했어요/.test(r.reply));
  assert.match(r.reply, /전달되지 않았어요/);
  assert.match(r.reply, /1877-6901/);
  assert.equal(r.body.leadFailed, true);
  assert.equal(r.calls.slackQuote.length, 2);   // 문자 실패 알림 + 모두 실패 알림
});

// ───────── 영어 대화 ─────────
const EN_TURN = {
  messages: [{ role: 'user', content: 'Hello, I need a quote for 200 cups of the basic coffee set in Gangnam. My phone number is 010-5555-0199' }],
  script: () => [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: 'N/A', phone: '010-5555-0199', menu: 'Basic set 200 cups' }), text('**Total 800,000 KRW**\nYour request is in.')],
};

test('영어 대화: 접수 표시가 영어로, 알림 실패 때는 "received"', async () => {
  const ok = await run({ messages: EN_TURN.messages, script: EN_TURN.script() });
  assert.equal(lastLine(ok.reply), '✅ Your request has been sent to our staff.');
  assert.equal(ok.calls.sms.length, 1);
  const stored = await run({ messages: EN_TURN.messages, script: EN_TURN.script(), solapi: 'fail' });
  assert.equal(lastLine(stored.reply), '✅ Your request has been received. Our staff will check and contact you.');
});

test('영어 대화: 알림·시트·상담 기록 모두 실패하면 영어로 실패 안내, 다음 턴에 다시 접수 가능', async () => {
  const r = await run({ messages: EN_TURN.messages, script: EN_TURN.script(), solapi: 'fail', sheet: 'fail', chatlog: 'fail' });
  assert.ok(!r.reply.includes('✅'));
  assert.match(r.reply, /could not be delivered/);
  const again = await run({
    messages: [...EN_TURN.messages, { role: 'assistant', content: r.reply }, { role: 'user', content: 'Please send it again' }],
    script: EN_TURN.script(),
  });
  assert.equal(again.calls.sms.length, 1);
  assert.match(again.calls.sms[0], /^\[푸드트럭하우스 챗봇 상담 신청\]/);
});

test('영어 대화: 남의 번호(venue)로 말한 것은 대신 접수하지 않음', async () => {
  const r = await run({
    messages: [{ role: 'user', content: 'I need 200 cups of the basic coffee set in Gangnam. The venue number is 02-123-4567' }],
    script: [tool('calculate_quote', BASIC200), text('Got it: basic set, 200 cups, Gangnam.')],
  });
  assert.equal(r.calls.sms.length, 0);
  assert.ok(!r.reply.includes('✅'));
});

test('모두 실패한 다음 턴: 접수 표시가 없으므로 다시 접수됨(새 접수로)', async () => {
  const r = await run({
    messages: [...LEAD_TURN.messages, { role: 'assistant', content: '죄송해요, 지금 상담 신청이 담당자에게 전달되지 않았어요. 잠시 후 다시 보내 주시거나 대표번호 1877-6901로 연락 주세요.' }, { role: 'user', content: '다시 접수해 주세요' }],
    script: [tool('calculate_quote', BASIC200), tool('submit_lead', { contactName: '미기재', phone: '010-5555-0199', menu: '베이직세트 200잔' }), text('접수했어요.')],
  });
  assert.equal(r.calls.sms.length, 1);
  assert.match(r.calls.sms[0], /^\[푸드트럭하우스 챗봇 상담 신청\]/);
  assert.equal(lastLine(r.reply), MARK);
});
