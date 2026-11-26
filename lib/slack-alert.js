// lib/slack-alert.js
// 운영 장애를 슬랙으로 바로 알림: 접수 문자 발송 실패, 손님에게 오류 답이 나간 경우.
// (11-23: 솔라피 잔액 0원으로 접수 문자가 몇 주간 안 나간 걸 아무도 몰랐음 — 주간 점검만으로는 늦음)
// 환경변수 SLACK_WEBHOOK_QUOTE(슬랙 Incoming Webhook)가 없으면 건너뜀. 실패·지연(3초)해도 예외를 던지지 않음.
// 장애 알림에는 손님 이름·번호를 넣지 않음(대화 id·요약만) — 원문은 보드 상담 기록에서 확인.
// 접수 알림(postLead): 환경변수 SLACK_WEBHOOK_LEAD가 있으면 담당자 문자와 같은 내용을 담당자 채널로 보냄(연락처 포함 — 담당자만 있는 채널에 연결할 것). 없으면 건너뜀.

// 슬랙은 & < > 를 특수 표기로 읽음 — 오류 문구가 <!channel> 전체 호출·가짜 링크가 되지 않게 바꿈
const slackSafe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function postAlert(text, url = process.env.SLACK_WEBHOOK_QUOTE, max = 1500) {
  if (!url) return { ok: false, skipped: true };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: slackSafe(String(text).slice(0, max)) }),   // 자른 뒤 바꿔야 &amp; 같은 표기가 중간에 안 잘림
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) console.warn('slack alert failed: HTTP', r.status);   // 주소는 남기지 않음
    return { ok: r.ok };
  } catch (e) {
    console.warn('slack alert failed:', (e && e.name) || 'error');
    return { ok: false };
  }
}

// kind: 'sms'(접수 문자 실패) | 'error'(손님에게 오류 답)
function alertFailure(kind, { where, reason, sessionId, summary } = {}) {
  const head = kind === 'sms'
    ? '🚨 [견적 챗봇] 접수 문자 발송 실패 — 접수는 구글 시트·보드 상담 기록에 남아 있으니 담당자가 직접 확인해 주세요'
    : '🚨 [견적 챗봇] 손님에게 오류 답이 나감';
  const lines = [head, `경로: ${where || '-'}`, `이유: ${reason || '-'}`];
  if (sessionId) lines.push(`대화 id: ${sessionId}`);
  if (summary) lines.push(`내용: ${summary}`);
  return postAlert(lines.join('\n'));
}

// 새 접수를 담당자 슬랙 채널로(문자와 같은 내용)
const postLead = (text) => postAlert(text, process.env.SLACK_WEBHOOK_LEAD, 3000);

module.exports = { alertFailure, postLead };
