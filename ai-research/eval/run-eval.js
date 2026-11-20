// ai-research/eval/run-eval.js — 같은 질문을 Claude 또는 로컬 모델(Ollama)로 돌려 자동 채점한다.
//   node ai-research/eval/run-eval.js ollama:qwen3.5:4b [OUT폴더] [Q01,Q02]
//   node ai-research/eval/run-eval.js claude [OUT폴더]         (ANTHROPIC_API_KEY 필요: 환경변수 또는 EVAL_ENV_FILE의 그 이름 한 줄만 읽음)
// ★ api/chat.js는 고치지 않는다. 바깥 연결은 Claude API / 로컬 Ollama만 허용.
//   문자·구글시트·대화 기록 모듈은 가로채고, 운영 Supabase(메뉴판·날짜 여유·호출 횟수)는 막아서 menu-snapshot.json으로 동작한다.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { callOllama } = require('./ollama-adapter.js');

const REPO = path.resolve(__dirname, '..', '..');
const [backend = 'ollama:qwen3.5:4b', outDir = path.join(REPO, '..', 'eval-out'), only] = process.argv.slice(2);
const isClaude = backend === 'claude';
const localModel = isClaude ? null : backend.replace(/^ollama:/, '');

// 1) 키는 이름 하나만 읽고 값은 출력하지 않음
if (isClaude && !process.env.ANTHROPIC_API_KEY && process.env.EVAL_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.EVAL_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, '');
  }
}
if (isClaude && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY 없음'); process.exit(3); }
if (!isClaude) process.env.ANTHROPIC_API_KEY = 'local-not-used';

// 2) 실제 발송 설정 제거 + 호출 횟수 제한 끔
for (const k of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'ALERT_TO', 'KAKAO_PFID', 'KAKAO_TEMPLATE_ID', 'SHEET_WEBHOOK_URL', 'CHAT_LOG_KEY']) delete process.env[k];
process.env.RL_OFF = '1';

// 3) 바깥 연결: Anthropic(claude일 때만) / Ollama로 번역(로컬일 때) / 나머지는 네트워크 오류로 막음
const realFetch = globalThis.fetch;
const blocked = [];
let lastLocal = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/')) {
    if (isClaude) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    const out = await callOllama(body, localModel, { think: process.env.EVAL_THINK === '1' }, realFetch);
    lastLocal = out._local;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  blocked.push(u.replace(/\?.*$/, ''));
  throw new Error('blocked by eval harness');
};

// 4) 문자·시트·대화 기록 가로채기
const captured = { leads: [], sheet: [], metas: [] };
function stub(rel, exports) {
  const p = path.join(REPO, rel);
  const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports;
  require.cache[p] = m;
}
stub('lib/lead-notify.js', { sendLeadAlert: async (t) => { captured.leads.push(t); return { ok: true }; } });
stub('lib/sheet-log.js', { logLead: async (r) => { captured.sheet.push(r); return { ok: true }; } });
stub('lib/chat-log.js', { logChat: async (x) => { captured.metas.push(x && x.meta); return { ok: true }; } });

const handler = require(path.join(REPO, 'api', 'chat.js'));
const { getMenuData, menuPromptText } = require(path.join(REPO, 'lib', 'menu-source.js'));

function callHandler(messages, sid) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method: 'POST', headers: {}, socket: {}, body: { messages, sessionId: sid, page: 'eval' } }, res)
      .catch((e) => resolve({ code: 'crash', body: { error: String(e) } }));
  });
}

// 공식 단가(100만 토큰당 달러, 2026-11-19 단가 페이지 확인). Haiku 5.5는 프롬프트 10만 토큰 이하 기준
const OFFICIAL_PRICE = {
  'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.10 },
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 },
};
function usdOf(u) {
  const p = u && OFFICIAL_PRICE[String(u.model || '').replace(/-\d{8}$/, '')];
  if (!p) return 0;
  return ((u.input || 0) * p.in + (u.output || 0) * p.out + (u.cacheWrite || 0) * p.cw + (u.cacheRead || 0) * p.cr) / 1e6;
}

const won = (s) => (String(s).match(/\d{1,3}(?:,\d{3})+|\d+\s*만\s*원/g) || [])
  .map((x) => (/만/.test(x) ? Number(x.replace(/\D/g, '')) * 10000 : Number(x.replace(/,/g, ''))));

(async () => {
  const qs = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')).cases
    .filter((c) => !only || only.split(',').includes(c.id));
  const { SYSTEM_KNOWLEDGE } = require(path.join(REPO, 'lib', 'knowledge.js'));
  const menuNums = new Set(won(menuPromptText(await getMenuData()) + '\n' + SYSTEM_KNOWLEDGE));   // 메뉴판 + 규칙 글(최소 주문액 600,000원 등)
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const c of qs) {
    const messages = [];
    const turns = [];
    const toolsUsed = [];
    for (const text of c.turns) {
      messages.push({ role: 'user', content: text });
      captured.metas.length = 0; lastLocal = null;
      const t0 = Date.now();
      const out = await callHandler([...messages], 'eval-' + c.id + '-000000');
      const sec = (Date.now() - t0) / 1000;
      const b = out.body || {};
      const reply = b.reply || `(오류 ${out.code}: ${b.error || ''})`;
      const meta = captured.metas[0] || {};
      (meta.tools || []).forEach((t) => toolsUsed.push(t));
      turns.push({ user: text, reply, code: out.code, sec, usage: b.usage || meta.usage || null, local: lastLocal, tools: meta.tools || [] });
      if (b.reply) messages.push({ role: 'assistant', content: b.reply });
      else break;
    }
    // 채점
    const allReply = turns.map((t) => t.reply).join('\n');
    const lastReply = turns[turns.length - 1].reply;
    // 도구 결과 안의 모든 숫자(JSON 숫자는 쉼표가 없어 정규식으로 못 읽음 → 재귀로 모음) + 글자 속 "123,000원"
    const nums = (o, acc = []) => { if (typeof o === 'number') acc.push(o); else if (o && typeof o === 'object') Object.values(o).forEach((v) => nums(v, acc)); else if (typeof o === 'string') acc.push(...won(o)); return acc; };
    const toolNums = new Set(nums(toolsUsed));
    // 대화 기록(meta)엔 vatIncluded가 없어서 부가세 포함 금액을 직접 더함(엔진과 같은 반올림)
    toolsUsed.forEach((t) => {
      [t.subtotal, t.rangeLow, t.rangeHigh].forEach((x) => typeof x === 'number' && toolNums.add(Math.round(x * 1.1)));
      if (Array.isArray(t.items)) toolNums.add(t.items.reduce((a, i) => a + (Number(i.amount) || 0), 0));   // 음식값 합계
    });
    const bigNums = won(allReply).filter((n) => n >= 100000);
    const unknownNums = bigNums.filter((n) => !toolNums.has(n) && !menuNums.has(n));
    const e = c.expect;
    const score = {
      error: turns.some((t) => t.code !== 200),
      toolOk: e.tool ? toolsUsed.some((t) => t.name === e.tool) : null,
      noHallucinatedAmount: unknownNums.length === 0,
      unknownNums,
      includeOk: e.mustInclude.every((re) => new RegExp(re).test(lastReply)),
      excludeOk: e.mustNotInclude.every((re) => !new RegExp(re).test(allReply)),
      koreanOk: c.type === '영어 손님' ? !/[가-힣]{6,}/.test(lastReply.replace(/떡볶이|서울/g, '')) : /[가-힣]/.test(lastReply),
      chars: lastReply.length,
      sec: turns.reduce((a, t) => a + t.sec, 0),
      inTok: turns.reduce((a, t) => a + ((t.usage && (t.usage.input + (t.usage.cacheRead || 0) + (t.usage.cacheWrite || 0))) || 0), 0),
      outTok: turns.reduce((a, t) => a + ((t.usage && t.usage.output) || 0), 0),
      // 비용은 공식 단가로 토큰에서 직접 계산(코드 PRICE에는 Haiku가 없고, Sonnet 5.5 캐시 읽기가 $0.20으로 적혀 있음 — PR #23)
      usd: isClaude ? turns.reduce((a, t) => a + usdOf(t.usage), 0) : 0,
    };
    score.pass = !score.error && score.toolOk !== false && score.noHallucinatedAmount && score.includeOk && score.excludeOk && score.koreanOk;
    results.push({ id: c.id, type: c.type, backend, score, turns });
    console.log(`${c.id} ${c.type} pass=${score.pass} tool=${score.toolOk} amt=${score.noHallucinatedAmount} inc=${score.includeOk} exc=${score.excludeOk} lang=${score.koreanOk} ${score.sec.toFixed(1)}s`);
  }
  const file = path.join(outDir, `eval_${backend.replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({ backend, at: new Date().toISOString(), blocked: [...new Set(blocked)], results }, null, 2));
  const n = results.length, p = results.filter((r) => r.score.pass).length;
  const tool = results.filter((r) => r.score.toolOk !== null);
  console.log(`\n${backend}: 통과 ${p}/${n}, 도구 ${tool.filter((r) => r.score.toolOk).length}/${tool.length}, 금액 환각 없음 ${results.filter((r) => r.score.noHallucinatedAmount).length}/${n}, 평균 ${(results.reduce((a, r) => a + r.score.sec, 0) / n).toFixed(1)}초/문항` + (isClaude ? `, 비용 $${results.reduce((a, r) => a + r.score.usd, 0).toFixed(4)}` : ''));
  console.log('저장:', file);
  process.exit(0);
})();
