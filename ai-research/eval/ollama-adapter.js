// ai-research/eval/ollama-adapter.js
// Anthropic Messages API 요청을 Ollama /api/chat 요청으로 바꾸고, 응답을 다시 Anthropic 모양으로 돌려준다.
// 목적: api/chat.js를 한 줄도 고치지 않고 같은 시스템 프롬프트·도구·후처리로 로컬 모델을 시험하기 위함.
// 나중에 lib/llm.js 어댑터를 만들 때 이 변환 규칙을 그대로 옮기면 된다.

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

function toOllamaRequest(body, model, opts = {}) {
  const system = (body.system || []).map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n');
  const messages = [{ role: 'system', content: system }];
  const toolNames = {};   // tool_use_id → 도구 이름 (tool 메시지에 이름을 붙이려고)
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use');
      calls.forEach((c) => { toolNames[c.id] = c.name; });
      messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') messages.push({ role: 'tool', tool_name: toolNames[b.tool_use_id], content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
        else if (b.type === 'text') messages.push({ role: 'user', content: b.text });
      }
    }
  }
  return {
    model,
    messages,
    tools: (body.tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    stream: false,
    think: opts.think === true,
    keep_alive: '30m',
    options: { num_ctx: opts.numCtx || 32768, temperature: 0.3, num_predict: opts.numPredict || 1536 },
  };
}

let seq = 0;
function toAnthropicResponse(o) {
  if (o.error) return { error: { message: 'ollama: ' + o.error } };
  const msg = o.message || {};
  const content = [];
  // 생각 끄기가 안 먹는 모델이 <think>…</think>를 본문에 섞는 경우 제거
  const text = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (text) content.push({ type: 'text', text });
  for (const c of msg.tool_calls || []) {
    let args = c.function && c.function.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
    content.push({ type: 'tool_use', id: 'toolu_local_' + (++seq), name: c.function.name, input: args || {} });
  }
  return {
    content,
    stop_reason: (msg.tool_calls || []).length ? 'tool_use' : 'end_turn',
    usage: { input_tokens: o.prompt_eval_count || 0, output_tokens: o.eval_count || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    _local: { totalSec: (o.total_duration || 0) / 1e9, promptSec: (o.prompt_eval_duration || 0) / 1e9, evalSec: (o.eval_duration || 0) / 1e9 },
  };
}

async function callOllama(body, model, opts, realFetch) {
  const r = await realFetch(OLLAMA + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toOllamaRequest(body, model, opts)) });
  const o = await r.json().catch(() => ({ error: 'bad json (HTTP ' + r.status + ')' }));
  return toAnthropicResponse(o);
}

module.exports = { toOllamaRequest, toAnthropicResponse, callOllama };
