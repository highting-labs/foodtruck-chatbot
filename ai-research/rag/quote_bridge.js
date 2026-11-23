// ai-research/rag/quote_bridge.js — RAG PoC가 기존 견적 엔진(lib/quote-engine.js)으로 금액을 계산하게 하는 다리.
// stdin: calculate_quote 입력 JSON → stdout: 계산 결과 JSON.  운영 DB는 막고 lib/menu-snapshot.json으로 계산한다.
globalThis.fetch = async () => { throw new Error('network blocked (quote_bridge)'); };
const path = require('path');
const { calculateQuote } = require(path.join(__dirname, '..', '..', 'lib', 'quote-engine.js'));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', async () => {
  try {
    const out = await calculateQuote(JSON.parse(buf || '{}'));
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 'error', error: String(e) }));
  }
});
