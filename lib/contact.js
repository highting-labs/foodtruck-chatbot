// lib/contact.js
// 손님 연락처 판정 — 대화에 나온 번호·이메일 중 "손님에게 연락할 곳"만 골라낸다.
// (11-27: 대화에 나온 아무 번호나 손님 연락처로 보고 자동 접수하던 일 — 관리실·친구 번호처럼 남의 번호가 섞임)
// 숫자 계산·견적과는 무관. api/chat.js가 연락처 카드 단계·자동 접수·접수 검사에 쓴다.

const PHONE_SRC = '\\+?82[-\\s.]?\\(?0?\\)?[-\\s.]?10[-\\s.]?\\d{4}[-\\s.]?\\d{4}|010[-\\s.]?\\d{4}[-\\s.]?\\d{4}|01[16789][-\\s.]?\\d{3,4}[-\\s.]?\\d{4}|0[2-6]\\d?[-\\s.]?\\d{3,4}[-\\s.]?\\d{4}';   // 휴대폰(010은 8자리) + 회사 유선(02·031 등)
const EMAIL_SRC = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const PHONE_RE = new RegExp(PHONE_SRC);
const EMAIL_RE = new RegExp(EMAIL_SRC);
const CARD_SUBMIT = '견적서 받을 곳: ';   // 화면 연락처 카드가 보내는 말(index.html과 같은 문구)

// 남의 번호로 말한 것: "관리실 번호는 02-…", "친구 010-…", "010-…은 경비실이에요"
// 직함(대리·팀장 등)·"담당자"는 넣지 않음 — 회사 담당자 번호는 연락받을 곳인 경우가 많음
const WHO = '(관리\\s?(실|사무소|사무실|인|소장)|경비실|안내\\s?데스크|(현장|장소|대관|건물|시설)\\s?(담당자?|관리자?|책임자?)(분|님)?|거래처|(다른|타|그|저쪽)\\s?업체|주최\\s?측|건물주|친구|지인|동료|남편|아내|와이프|어머니|아버지|엄마|아빠|venue|building manager|my friend)';
const THIRD_BEFORE = new RegExp(WHO + '(의|쪽)?\\s?(휴대폰|핸드폰|전화|연락처|번호|폰|number|phone)?\\s?(번호|연락처)?\\s?(은|는|가|이|도|:|is)?\\s*$', 'i');
// 영어: "the venue office number is 02-…", "my friend's phone: 010-…" — 사이에 낱말이 끼는 일이 많아 따로 봄("my office number"는 손님 번호일 수 있어 office만으로는 보지 않음)
const THIRD_BEFORE_EN = /\b(venue|building|facility|site|front desk|reception|security|organi[sz]er|landlord|friend|colleague|wife|husband)('s)?(\s[a-z]+){0,2}\s(number|phone|contact|line)\s?(is|:|-)?\s*$/i;
const THIRD_AFTER =new RegExp('^\\s?(은|는|이|가)?\\s?' + WHO, 'i');
// 그 번호로 연락해 달라는 말이 같이 있으면 남의 번호여도 연락받을 곳
const CONTACT_ME = /(연락|전화|문자|회신|견적서?)\s?(을|를|은|는)?\s?(주|부탁|바랍|바라|드리면|해\s?주|줘|달라|보내)|(이|그)\s?(번호|쪽|분)(으)?로|제\s?(번호|연락처|폰|핸드폰|휴대폰)|내\s?번호|call (me|him|her|them|this)|reach (me|him|her|them)|contact (me|him|her|them)|send (it|the quote)/i;
// 연락하지 말라는 말이 붙으면 무조건 남의 번호
const DONT = /연락\s?(하지|은\s?하지|안\s?하|주지)|전화\s?(하지|주지)|말고|빼고|don'?t (call|contact)|do not (call|contact)/i;
// 챗봇이 "이 번호로 연락드리면 될까요?"라고 확인했고 손님이 그렇다고 하면 그때 연락처로 인정
const CONFIRM_Q = /번호로\s?[^.?!\n]{0,25}(될까요|괜찮|맞을까요|맞나요)|다른 연락처/;
const AFFIRM = /^\s*(네|넵|예|응|맞아|맞습|그래|좋아|ㅇㅇ|yes|yeah|ok|okay)|(그|이)\s?번호(로|가|도)|그쪽으로/i;
const DENY = /아니|아뇨|말고|no\b|don'?t/i;

const digits = (s) => String(s || '').replace(/\D/g, '');
// 국제 형식(+82 10 …, 82-10-…, +82 (0)10 …)은 국내 형식(010…)으로 바꿔 비교 — 11-27 고정 세트: +82로 준 정상 번호를 "자릿수가 틀렸다"며 거절함
const local = (s) => digits(s).replace(/^820?(?=1[016789]\d{7,8}$)/, '0');

/**
 * 대화에서 손님 연락처를 고른다.
 * @param {Array<{role:string, content:any}>} messages
 * @returns {{phones:string[], emails:string[], others:string[]}} others = 남의 번호로 말해 연락처로 보지 않은 것
 */
function ownContacts(messages) {
  const phones = [], emails = [];
  let others = [];
  const put = (v) => (v.includes('@') ? emails : phones).push(v);
  (messages || []).forEach((m, i) => {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') return;
    const t = m.content;
    const prev = messages[i - 1];
    if (others.length && prev && prev.role === 'assistant' && CONFIRM_Q.test(String(prev.content || '')) && AFFIRM.test(t) && !DENY.test(t)) { others.forEach(put); others = []; }
    const re = new RegExp(`${PHONE_SRC}|${EMAIL_SRC}`, 'g');
    let x;
    while ((x = re.exec(t))) {
      const end = x.index + x[0].length;
      // 같은 문장 안에서만 봄 — 앞 문장의 "견적 주세요"를 "이 번호로 연락 달라"로 읽던 일(11-27 실제 모델 시험)
      const before = t.slice(Math.max(0, x.index - 30), x.index).split(/[.!?。]\s+|\n/).pop();
      const rest = t.slice(end, end + 60).split(/(?<=[.!?。])\s+|\n/);
      const after = (rest[0] || '').slice(0, 30);
      // 바로 다음 문장이 "이쪽으로 연락 주세요"처럼 그 번호를 가리키면 같이 봄
      const next = /^\s*(이|그)\s?(번호|쪽|분)(으)?(로|께|에게|한테)\s?[^.?!\n]{0,12}(연락|전화|문자|보내|주세요)/.test(rest[1] || '') ? rest[1] : '';
      const around = before + ' ' + after + ' ' + next;
      const third = !t.startsWith(CARD_SUBMIT) && (DONT.test(after.slice(0, 20))
        || ((THIRD_BEFORE.test(before) || THIRD_BEFORE_EN.test(before) || THIRD_AFTER.test(after)) && !CONTACT_ME.test(around)));
      if (third) others.push(x[0]); else put(x[0]);
    }
  });
  return { phones, emails, others };
}

/**
 * 접수(submit_lead)에 적힌 연락처를 검사한다. 값은 고치지 않고 판정만 돌려준다.
 * @returns {{status:null|'need_contact'|'check_phone'|'check_email'|'confirm_contact', dropPhone?:boolean, dropEmail?:boolean}}
 *   check_phone: 010인데 11자리가 아니거나, 손님 글에 없는 번호(모델이 숫자를 보탬)
 *   check_email: 이메일 모양이 아니거나 손님 글에 없는 주소
 *   confirm_contact: 손님이 남의 번호로 말한 번호 — 이 번호로 연락해도 되는지 먼저 확인
 *   dropPhone/dropEmail: 다른 쪽 연락처가 멀쩡하면 이상한 쪽만 빼고 접수
 */
function vetContact(input, messages) {
  const p = input || {};
  const d = local(p.phone), e = String(p.email || '').trim();
  if (!d && !e) return { status: 'need_contact' };
  const userAll = (messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
  // 손님이 번호를 한글로 적기도 함("공일공 공공공공 일일공오") — 한글 숫자도 숫자로 바꿔 대조(11-27 회귀: 한글로 적은 정상 번호가 계속 거절돼 접수 손실)
  const KO = { 공: 0, 영: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
  const ud = digits(userAll), udKo = digits(userAll.replace(/[공영일이삼사오육륙칠팔구]{3,}/g, (run) => [...run].map((c) => KO[c]).join('')));   // 세 글자 이상 이어진 것만("메일"의 '일' 같은 글자는 숫자로 보지 않음)
  const own = ownContacts(messages);
  const lengthBad = !!d && ((/^010/.test(d) && d.length !== 11) || d.length < 9 || d.length > 11);
  const mismatch = !!d && !lengthBad && ![ud, udKo].some((u) => u.includes(d) || u.includes(d.slice(1)));
  const phoneBad = lengthBad || mismatch;
  const phoneOther = !!d && !phoneBad && !own.phones.some((x) => local(x) === d) && own.others.some((x) => local(x) === d);
  const emailBad = !!e && (!new RegExp(`^${EMAIL_SRC}$`).test(e) || !userAll.toLowerCase().includes(e.toLowerCase()));
  const phoneOk = !!d && !phoneBad && !phoneOther, emailOk = !!e && !emailBad;
  if (phoneOk || emailOk) return { status: null, dropPhone: !!d && !phoneOk, dropEmail: !!e && !emailOk };
  if (phoneOther) return { status: 'confirm_contact' };
  if (d) return { status: 'check_phone', reason: lengthBad ? 'length' : 'mismatch' };   // 자릿수 문제와 손님 글 불일치는 안내가 다름
  return { status: 'check_email' };
}

module.exports = { PHONE_RE, EMAIL_RE, PHONE_SRC, EMAIL_SRC, CARD_SUBMIT, ownContacts, vetContact };
