// lib/capacity.js
// 손님이 말한 날짜에 우리 차·집기 여유가 있는지 보드에 물어봄 (보드 DB 함수 capacity_check — 단계만 돌려주고 행사·고객 정보는 안 줌)
//   open  = 직영 여유 → 보통 응대(전화로 넘기지 않음)
//   tight = 빠듯 → 보통 응대
//   busy  = 외주 예상(차 대부분 나감 또는 필요한 집기 모자람) → 보통 응대(견적서 정보까지 끝까지, 11-20 사무실 답)
// 손님에게는 여유·외주 이야기를 절대 하지 않음
const SB_URL = process.env.CAP_SUPABASE_URL || process.env.SUPABASE_URL || 'https://vopoinbleggjqdbrxwpc.supabase.co';
const SB_KEY = process.env.CAP_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_HDlbxhnF0l4okkeZXmg7wg_m_Krjqds';

async function capacityCheck(date, menuText, powerOff) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/capacity_check`, {
      method: 'POST', signal: ctl.signal,
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_date: date, p_menu: String(menuText || ''), p_power_off: !!powerOff }),
    });
    if (!r.ok) return null;                       // 함수가 아직 없거나 오류면 판단 없이 평소대로
    const j = await r.json();
    return j && j.level ? j : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// 봇에게 줄 응대 안내 (손님에게 그대로 쓰지 말 것)
function capacityGuide(cap) {
  if (!cap) return null;
  // 사무실 답(11-20): 바쁜 날일수록 넘기지 말고 견적서를 끝까지 짜야 함 → 응대 깊이는 평소와 같게
  if (cap.level === 'busy') return "[봇에게] 그날 직영 여유가 적어요 — 응대는 평소와 같게 견적서 정보까지 끝까지 받으세요. '그날 바쁘다/일정이 찼다/외주' 같은 말은 절대 하지 말 것. 손님이 진행 가능하냐고 물어도 다른 날과 똑같이 '그날 차량 배정은 담당자가 바로 확인해 드려요'까지만(\"가능해요\"라고 장담하지 않음 — 11-24 사용자 방침, 다른 날 답과 달라지지 않게)";
  return null;
}

module.exports = { capacityCheck, capacityGuide };
