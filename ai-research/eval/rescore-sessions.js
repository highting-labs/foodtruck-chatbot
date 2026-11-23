// ai-research/eval/rescore-sessions.js — '근거 없는 금액' 채점을 한 곳에서 한다.
//   node ai-research/eval/rescore-sessions.js <시험장 sessions 폴더>      기존 Claude 대화 기록(KK-* 실제 상담 익명본 제외)
//   node ai-research/eval/rescore-sessions.js <eval_*.json 파일>          run-eval.js 결과(로컬·Claude)
// 근거 = 메뉴판 + 규칙 글(knowledge.js) + 이 대화에서 지금까지 나온 도구 결과(+부가세 포함·음식값 합계) + 손님이 직접 말한 숫자
// 대화 원문은 출력하지 않는다. SHOW_NUMS=1이면 걸린 숫자만 stderr로.
const fs = require('fs');
const path = require('path');
globalThis.fetch = async () => { throw new Error('blocked'); };
const ROOT = path.join(__dirname, '..', '..');
const { getMenuData, menuPromptText } = require(path.join(ROOT, 'lib', 'menu-source.js'));
const { SYSTEM_KNOWLEDGE } = require(path.join(ROOT, 'lib', 'knowledge.js'));

const won = (s) => (String(s).match(/\d{1,3}(?:,\d{3})+|\d+\s*만\s*원/g) || [])
  .map((x) => (/만/.test(x) ? Number(x.replace(/\D/g, '')) * 10000 : Number(x.replace(/,/g, ''))));
const nums = (o, acc = []) => { if (typeof o === 'number') acc.push(o); else if (o && typeof o === 'object') Object.values(o).forEach((v) => nums(v, acc)); else if (typeof o === 'string') acc.push(...won(o)); return acc; };

function scoreConversation(turns, baseNums) {
  const seen = new Set(baseNums);
  const out = [];
  for (const t of turns) {
    const tools = t.tools || [];
    nums(tools).forEach((n) => seen.add(n));
    won(t.user || '').forEach((n) => seen.add(n));
    (String(t.user || '').match(/\d+\s*만/g) || []).forEach((x) => seen.add(Number(x.replace(/\D/g, '')) * 10000));
    tools.forEach((x) => {
      [x.subtotal, x.rangeLow, x.rangeHigh].forEach((v) => typeof v === 'number' && seen.add(Math.round(v * 1.1)));
      if (Array.isArray(x.items)) seen.add(x.items.reduce((a, i) => a + (Number(i.amount) || 0), 0));
    });
    const big = won(t.reply || '').filter((n) => n >= 100000);
    const bad = big.filter((n) => !seen.has(n));
    out.push({ hasAmount: big.length > 0, bad, noTool: tools.length === 0, calc: tools.some((x) => x.name === 'calculate_quote') });
  }
  return out;
}

async function baseNumbers() { return won(menuPromptText(await getMenuData()) + '\n' + SYSTEM_KNOWLEDGE); }

function summarize(per) {
  const flat = per.flat();
  const amt = flat.filter((x) => x.hasAmount), bad = flat.filter((x) => x.bad.length);
  return { convs: per.length, turns: flat.length, calcTurns: flat.filter((x) => x.calc).length, turnsWithBigAmount: amt.length,
    turnsWithUnsupportedAmount: bad.length, unsupportedWithoutAnyTool: bad.filter((x) => x.noTool).length,
    convsWithUnsupportedAmount: per.filter((c) => c.some((x) => x.bad.length)).length,
    unsupportedRateAmongAmountTurns: +(bad.length / Math.max(1, amt.length)).toFixed(3) };
}

module.exports = { scoreConversation, baseNumbers, summarize };

if (require.main === module) (async () => {
  const target = process.argv[2];
  const base = await baseNumbers();
  const per = [];
  if (fs.statSync(target).isDirectory()) {
    for (const f of fs.readdirSync(target)) {
      if (!f.endsWith('.json') || /KK-/.test(f)) continue;
      let s; try { s = JSON.parse(fs.readFileSync(path.join(target, f), 'utf8')); } catch (e) { continue; }
      if (!Array.isArray(s.turns)) continue;
      const r = scoreConversation(s.turns, base); per.push(r);
      if (process.env.SHOW_NUMS) r.forEach((x) => x.bad.length && console.error(f.slice(0, 14), x.bad.join(' ')));
    }
  } else {
    const j = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const c of j.results) {
      const r = scoreConversation(c.turns, base); per.push(r);
      if (process.env.SHOW_NUMS) r.forEach((x) => x.bad.length && console.error(c.id, x.bad.join(' ')));
    }
  }
  console.log(JSON.stringify(summarize(per), null, 1));
})();
