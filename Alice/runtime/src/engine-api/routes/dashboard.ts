/**
 * Engine API — веб-дашборд статистики Алисы (read-only, localhost).
 *
 *   GET /dashboard       → HTML-страница с графиками (автообновление).
 *   GET /dashboard/data  → JSON со всеми метриками (страница опрашивает периодически).
 *
 * Только ЧТЕНИЕ состояния: поведение/личность/когницию не трогает. Источники:
 * граф (каналы/контакты/self), БД (tick_log/action_log) и диагностика (разнообразие голосов).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { actionLog, tickLog } from "../../db/schema.js";
import { analyzeVoiceDiversity } from "../../diagnostics/diversity.js";
import { safeDisplayName } from "../../graph/display.js";
import { createLogger } from "../../utils/logger.js";
import type { EngineApiDeps } from "../server.js";

const log = createLogger("dashboard");

/** Собирает все метрики в один JSON. Каждый блок защищён — частичный сбой не роняет дашборд. */
function collectData(deps: EngineApiDeps): Record<string, unknown> {
  const G = deps.G;

  // ── Каналы ────────────────────────────────────────────────────────────────
  const channels: Array<Record<string, unknown>> = [];
  try {
    for (const id of G.getEntitiesByType("channel")) {
      const a = G.getChannel(id) as unknown as Record<string, unknown>;
      const reach = Number(a.reachability_score ?? 1);
      channels.push({
        name: safeDisplayName(G, id),
        chatType: a.chat_type ?? null,
        unread: Number(a.unread ?? 0),
        role: String(a.alice_role ?? "subscriber"),
        pendingDirected: Number(a.pending_directed ?? 0),
        reachability: reach,
        unreachable: a.failure_type === "permanent" || reach <= 0,
        pressure: a.pressure != null ? Number(a.pressure) : null,
        currentTopic: a.current_topic_id ?? null,
      });
    }
    channels.sort((x, y) => Number(y.unread) - Number(x.unread));
  } catch (e) {
    log.warn("dashboard channels failed", { err: (e as Error).message });
  }

  // ── Контакты ──────────────────────────────────────────────────────────────
  const contacts: Array<Record<string, unknown>> = [];
  try {
    for (const id of G.getEntitiesByType("contact")) {
      contacts.push({
        name: safeDisplayName(G, id),
        tier: Number(G.getDynamic(id, "tier") ?? 0),
        lastSeen: G.getDynamic(id, "last_seen_ms") ?? null,
      });
    }
    contacts.sort((x, y) => Number(y.tier) - Number(x.tier));
  } catch (e) {
    log.warn("dashboard contacts failed", { err: (e as Error).message });
  }

  // ── Self (настроение/энергия/режим) ────────────────────────────────────────
  let self: Record<string, unknown> | null = null;
  try {
    if (G.has("self")) {
      self = {
        mood: G.getDynamic("self", "mood") ?? null,
        energy: G.getDynamic("self", "energy") ?? null,
        mode: G.getDynamic("self", "mode") ?? null,
        valence: G.getDynamic("self", "valence") ?? null,
        arousal: G.getDynamic("self", "arousal") ?? null,
      };
    }
  } catch (e) {
    log.warn("dashboard self failed", { err: (e as Error).message });
  }

  // ── БД-активность ───────────────────────────────────────────────────────────
  let db: Record<string, unknown> = { ok: false };
  try {
    const d = getDb();
    const ticks = d.select({ c: sql<number>`count(*)` }).from(tickLog).get()?.c ?? 0;
    const actions = d.select({ c: sql<number>`count(*)` }).from(actionLog).get()?.c ?? 0;
    const ok = d
      .select({ c: sql<number>`count(*)` })
      .from(actionLog)
      .where(eq(actionLog.success, true))
      .get()?.c ?? 0;
    const recent = d
      .select({ tick: actionLog.tick, voice: actionLog.voice, success: actionLog.success })
      .from(actionLog)
      .orderBy(desc(actionLog.id))
      .limit(40)
      .all();
    const byVoice = d
      .select({ voice: actionLog.voice, c: sql<number>`count(*)` })
      .from(actionLog)
      .groupBy(actionLog.voice)
      .all();
    db = {
      ok: true,
      ticks,
      actions,
      successRate: actions > 0 ? ok / actions : null,
      recent: recent.reverse(),
      byVoice,
    };
  } catch (e) {
    db = { ok: false, error: (e as Error).message };
  }

  // ── Разнообразие голосов / дрейф личности ───────────────────────────────────
  let voices: unknown = null;
  try {
    voices = analyzeVoiceDiversity();
  } catch (e) {
    log.warn("dashboard voices failed", { err: (e as Error).message });
  }

  return {
    ts: Date.now(),
    summary: {
      channels: channels.length,
      contacts: contacts.length,
      activeChannels: channels.filter((c) => Number(c.unread) > 0 || Number(c.pendingDirected) > 0)
        .length,
    },
    channels: channels.slice(0, 60),
    contacts: contacts.slice(0, 40),
    self,
    db,
    voices,
  };
}

/** Маршрут: /dashboard (страница) и /dashboard/data (JSON). */
export function handleDashboard(
  sub: string | undefined,
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
  if (sub === "data") {
    try {
      const data = collectData(deps);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Alice — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --bg:#0e1116; --card:#171c24; --line:#252c38; --tx:#e6edf3; --mut:#8b97a7; --acc:#7aa2ff; --good:#3fb950; --bad:#f85149; --warn:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:14px; padding:14px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:10; }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  header .dot { width:9px; height:9px; border-radius:50%; background:var(--good); box-shadow:0 0 8px var(--good); }
  header .upd { color:var(--mut); font-size:12px; margin-left:auto; }
  .wrap { padding:20px; max-width:1400px; margin:0 auto; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .k { color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  .card .v { font-size:26px; font-weight:700; margin-top:4px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:500; font-size:11px; text-transform:uppercase; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { padding:1px 8px; border-radius:20px; font-size:11px; }
  .pill.owner { background:#1f6feb33; color:#7aa2ff; } .pill.admin { background:#d2992233; color:#d29922; }
  .pill.sub { background:#30363d; color:var(--mut); }
  .gone { color:var(--bad); } .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--acc); }
  canvas { max-height:240px; }
  .err { color:var(--bad); font-size:12px; }
</style>
</head>
<body>
<header>
  <span class="dot"></span><h1>Alice — Dashboard</h1>
  <span class="upd" id="upd">загрузка…</span>
</header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div class="grid">
    <div class="panel"><h2>Голоса (распределение)</h2><canvas id="voiceChart"></canvas></div>
    <div class="panel"><h2>Активность — последние действия</h2><canvas id="actChart"></canvas></div>
  </div>
  <div class="panel"><h2>Действия по голосам</h2><canvas id="voiceActChart"></canvas></div>
  <div class="panel"><h2>Каналы</h2><div id="channels"></div></div>
  <div class="panel"><h2>Контакты (по tier)</h2><div id="contacts"></div></div>
</div>
<script>
let voiceChart, actChart, vaChart;
const $ = (id) => document.getElementById(id);
function card(k,v){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>'; }
function fmtPct(x){ return x==null?'—':(x*100).toFixed(0)+'%'; }
async function refresh(){
  let d; try { d = await (await fetch('/dashboard/data')).json(); } catch(e){ $('upd').textContent='offline'; return; }
  $('upd').textContent = 'обновлено ' + new Date(d.ts).toLocaleTimeString('ru');
  const v = d.voices || {};
  $('cards').innerHTML = [
    card('Тиков', d.db?.ticks ?? '—'),
    card('Действий', d.db?.actions ?? '—'),
    card('Успешность', fmtPct(d.db?.successRate)),
    card('Каналов', d.summary?.channels ?? '—'),
    card('Активных', d.summary?.activeChannels ?? '—'),
    card('Контактов', d.summary?.contacts ?? '—'),
    card('Энтропия голосов', v.normalizedEntropy!=null ? v.normalizedEntropy.toFixed(2) : '—'),
    card('Настроение', d.self?.mood ?? d.self?.valence ?? '—'),
  ].join('');
  // голоса
  const vf = (v.voiceFrequencies)||{}; const vlabels=Object.keys(vf); const vdata=vlabels.map(k=>vf[k]);
  const palette=['#7aa2ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf'];
  if(vlabels.length){
    if(!voiceChart){ voiceChart=new Chart($('voiceChart'),{type:'doughnut',data:{labels:vlabels,datasets:[{data:vdata,backgroundColor:palette}]},options:{plugins:{legend:{labels:{color:'#e6edf3'}}}}}); }
    else { voiceChart.data.labels=vlabels; voiceChart.data.datasets[0].data=vdata; voiceChart.update(); }
  }
  // активность
  const rec=(d.db?.recent)||[]; const al=rec.map(r=>'t'+r.tick); const ad=rec.map(r=>r.success?1:0);
  if(rec.length){
    const cols=rec.map(r=>r.success?'#3fb950':'#f85149');
    if(!actChart){ actChart=new Chart($('actChart'),{type:'bar',data:{labels:al,datasets:[{data:ad,backgroundColor:cols}]},options:{plugins:{legend:{display:false}},scales:{y:{display:false},x:{ticks:{color:'#8b97a7',maxTicksLimit:12}}}}}); }
    else { actChart.data.labels=al; actChart.data.datasets[0].data=ad; actChart.data.datasets[0].backgroundColor=cols; actChart.update(); }
  }
  // действия по голосам
  const bv=(d.db&&d.db.byVoice)||[]; const bvl=bv.map(x=>x.voice||'?'); const bvd=bv.map(x=>x.c);
  if(bv.length){
    if(!vaChart){ vaChart=new Chart($('voiceActChart'),{type:'bar',data:{labels:bvl,datasets:[{data:bvd,backgroundColor:'#bc8cff'}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{color:'#8b97a7'}},x:{ticks:{color:'#8b97a7'}}}}}); }
    else { vaChart.data.labels=bvl; vaChart.data.datasets[0].data=bvd; vaChart.update(); }
  }
  // каналы
  const ch=(d.channels)||[];
  $('channels').innerHTML = '<table><tr><th>Канал</th><th>Тип</th><th>Непрочит.</th><th>Роль</th><th>Pending</th><th>Достижим</th></tr>'+
    ch.map(c=>'<tr><td>'+(c.unreachable?'<span class="gone">'+esc(c.name)+' (нет)</span>':esc(c.name))+'</td><td>'+(c.chatType||'')+'</td><td class="num">'+c.unread+'</td><td><span class="pill '+(c.role==='owner'?'owner':c.role==='admin'?'admin':'sub')+'">'+c.role+'</span></td><td class="num">'+c.pendingDirected+'</td><td class="num">'+(c.unreachable?'✗':fmtPct(c.reachability))+'</td></tr>').join('')+'</table>';
  // контакты
  const ct=(d.contacts)||[];
  $('contacts').innerHTML = '<table><tr><th>Контакт</th><th>Tier</th></tr>'+
    ct.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="num">'+c.tier+'</td></tr>').join('')+'</table>';
}
function esc(s){ return String(s).replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m])); }
refresh(); setInterval(refresh, 5000);
</script>
</body>
</html>`;
