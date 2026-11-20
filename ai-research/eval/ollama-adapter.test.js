// node --test ai-research/eval/  — 네트워크 없이 변환 규칙만 확인
const test = require('node:test');
const assert = require('node:assert');
const { toOllamaRequest, toAnthropicResponse } = require('./ollama-adapter.js');

const body = {
  system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'calculate_quote', description: 'd', input_schema: { type: 'object', properties: {} } }],
  messages: [
    { role: 'user', content: '떡볶이 100인분 서울' },
    { role: 'assistant', content: [{ type: 'text', text: '계산할게요' }, { type: 'tool_use', id: 't1', name: 'calculate_quote', input: { region: '서울' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"subtotal":500000}' }] },
  ],
};

test('system 블록은 한 system 메시지로 합친다', () => {
  const r = toOllamaRequest(body, 'm');
  assert.strictEqual(r.messages[0].role, 'system');
  assert.strictEqual(r.messages[0].content, 'A\n\nB');
});

test('tool_use → assistant.tool_calls, tool_result → role tool + 도구 이름', () => {
  const r = toOllamaRequest(body, 'm');
  assert.deepStrictEqual(r.messages[2].tool_calls, [{ function: { name: 'calculate_quote', arguments: { region: '서울' } } }]);
  assert.deepStrictEqual(r.messages[3], { role: 'tool', tool_name: 'calculate_quote', content: '{"subtotal":500000}' });
});

test('도구 정의는 function 형식, input_schema → parameters', () => {
  const r = toOllamaRequest(body, 'm');
  assert.strictEqual(r.tools[0].type, 'function');
  assert.deepStrictEqual(r.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.strictEqual(r.stream, false);
});

test('Ollama tool_calls 응답 → stop_reason tool_use, 문자열 arguments도 파싱', () => {
  const a = toAnthropicResponse({ message: { content: '', tool_calls: [{ function: { name: 'submit_lead', arguments: '{"phone":"010-0000-1234"}' } }] }, prompt_eval_count: 10, eval_count: 5 });
  assert.strictEqual(a.stop_reason, 'tool_use');
  assert.deepStrictEqual(a.content[0].input, { phone: '010-0000-1234' });
  assert.strictEqual(a.usage.input_tokens, 10);
});

test('본문에 섞인 <think> 제거, 일반 답은 end_turn', () => {
  const a = toAnthropicResponse({ message: { content: '<think>x</think>안녕하세요' } });
  assert.strictEqual(a.stop_reason, 'end_turn');
  assert.deepStrictEqual(a.content, [{ type: 'text', text: '안녕하세요' }]);
});

test('Ollama 오류는 Anthropic error 모양으로', () => {
  assert.ok(toAnthropicResponse({ error: 'model not found' }).error.message.includes('model not found'));
});
