// Trace Playback: animates the normalized event sequence in run.playback (built server-side from real
// Application Insights spans). The UI never executes anything; it only replays what was recorded.
const PB = { pb: null, steps: [], T: [], total: 0, pos: 0, playing: false, speed: 1, raf: 0, last: 0, cur: -1, phase: '', cardTab: 'Input', auto: true,
  evTab: 'Overview', ioTab: 'Input', held: new Set(), L: null, paths: new Map(), pcache: '', ncache: '', scale: 1 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ez = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const mmss = (ms) => { const s = Math.round(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const pbWall = (ms) => { const d = new Date(new Date(PB.pb.startedAt).getTime() + ms); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const pbKind = { request: ['👤', 'Request'], handoff: ['🔀', 'Hand-off'], llm: ['💬', 'Model call'], tool: ['🧩', 'Tool call'], gap: ['◌', 'Uninstrumented'], error: ['⚠', 'Error'], final: ['✅', 'Final response'] };

function pbStop() { cancelAnimationFrame(PB.raf); PB.playing = false; }

function pbTiming(steps) {
  let t = 0;
  return steps.map((s) => {
    const two = s.kind === 'llm' || s.kind === 'tool';
    const dur = two ? (s.durationMs ? clamp(s.durationMs * 0.1, 2400, 4800) : 2600)
      : s.kind === 'gap' ? clamp(s.durationMs * 0.08, 1200, 2400) : s.kind === 'error' ? 2200 : 1300;
    const o = { start: t, dur, two }; t += dur; return o;
  });
}

// ---------- layout
function pbLayout(nodes) {
  const PAD = 20, AW = 186, AH = 118, AY = 170, TY = 392, TW = 128, TH = 84, MY = 14, MH = 64, GAP = 44, UW = 150, FW = 160;
  const pos = {}; const agents = nodes.filter((n) => n.type === 'agent');
  let x = PAD;
  pos.user = { x, y: AY + 7, w: UW, h: 104 }; x += UW + GAP;
  agents.forEach((a, i) => {
    const tools = nodes.filter((n) => n.type === 'tool' && n.agent === i);
    const tw = Math.max(tools.length * (TW + 10) - 10, 0);
    const colW = Math.max(AW + 16, tw); const cx = x + colW / 2;
    pos[a.key] = { x: cx - AW / 2, y: AY, w: AW, h: AH, cx };
    tools.forEach((t, j) => { const tx = cx - tw / 2 + j * (TW + 10); pos[t.key] = { x: tx, y: TY, w: TW, h: TH, cx: tx + TW / 2 }; });
    x += colW + GAP;
  });
  pos.final = { x, y: AY + 7, w: FW, h: 104 };
  const first = pos[agents[0].key], lastA = pos[agents[agents.length - 1].key];
  pos.model = { x: first.x - 20, y: MY, w: lastA.x + AW + 20 - (first.x - 20), h: MH };
  const W = x + FW + PAD, H = TY + TH + 20, mid = AY + AH / 2, paths = {};
  const lab = (k, text, lx, ly, a) => { paths[k].label = { text, x: lx, y: ly, a }; };
  paths.req = { d: `M${pos.user.x + UW} ${mid} L${pos['agent:0'].x - 3} ${mid}` };
  agents.forEach((a, i) => {
    const p = pos[a.key];
    if (i > 0) { const q = pos[agents[i - 1].key]; paths[`h${i}`] = { d: `M${q.x + AW} ${mid} L${p.x - 3} ${mid}` }; }
    paths[`m${i}:o`] = { d: `M${p.cx - 36} ${AY} L${p.cx - 36} ${MY + MH + 3}` }; lab(`m${i}:o`, 'Prompt', p.cx - 42, 118, 'end');
    paths[`m${i}:b`] = { d: `M${p.cx + 36} ${MY + MH} L${p.cx + 36} ${AY - 3}`, ret: true }; lab(`m${i}:b`, 'Completion', p.cx + 42, 118, 'start');
    nodes.filter((n) => n.type === 'tool' && n.agent === i).forEach((t) => {
      const q = pos[t.key]; const y0 = AY + AH;
      paths[`${t.key}:o`] = { d: `M${p.cx - 16} ${y0} C${p.cx - 16} ${y0 + 60} ${q.cx - 16} ${TY - 60} ${q.cx - 16} ${TY - 3}` };
      paths[`${t.key}:b`] = { d: `M${q.cx + 16} ${TY} C${q.cx + 16} ${TY - 60} ${p.cx + 16} ${y0 + 60} ${p.cx + 16} ${y0 + 3}`, ret: true };
      lab(`${t.key}:o`, 'Call', q.cx - 22, TY - 46, 'end'); lab(`${t.key}:b`, 'Result', q.cx + 22, TY - 46, 'start');
    });
  });
  paths.fin = { d: `M${lastA.x + AW} ${mid} L${pos.final.x - 3} ${mid}` };
  return { pos, paths, W, H, agents };
}

// Path keys a step travels: out (call) and optional back (return)
function pbPathKeys(s) {
  const ai = (k) => parseInt(String(k).split(':')[1], 10);
  if (s.kind === 'request') return { out: 'req' };
  if (s.kind === 'handoff') return { out: `h${ai(s.to)}` };
  if (s.kind === 'final') return { out: 'fin' };
  if (s.kind === 'llm') return { out: `m${ai(s.from)}:o`, back: `m${ai(s.from)}:b` };
  if (s.kind === 'tool') return { out: `${s.to}:o`, back: `${s.to}:b` };
  return {};
}

// ---------- view skeleton
function vPlayback() {
  const r = S.run;
  if (!r) return `<div class="card"><p class="sub" style="padding:40px">Loading trace from Application Insights…</p></div>`;
  if (!r.playback) return `<div class="card">This trace has no playback data. Restart the server to pick up the latest API.</div>`;
  return `<div class="card pbinfo">
    <div><span>Trace ID (operation_Id)</span><b class="mono">${esc(r.runId)}</b><button class="cp" data-cp="${esc(r.runId)}" title="Copy">⧉</button></div>
    <div><span>Response ID</span><b class="mono">${esc((r.responseId || r.requestId || '—').slice(0, 22))}</b></div>
    <div><span>Started At</span><b>${fmtDT(r.playback.startedAt)}</b></div>
    <div><span>Duration</span><b>${fmtS(r.durationMs)}</b></div>
    <div><span>Status</span><b class="pill ${r.success ? 'ok' : 'failed'}">${r.success ? '✓ Completed' : '✕ Failed'}</b></div>
    <div class="pbpick">
      <input id="pbid" placeholder="Paste trace / operation ID" maxlength="32" spellcheck="false"><button class="btn ghost" id="pbload">Load</button></div></div>
  <div class="card pbctl"><button class="btn" id="pbplay">▶ Play</button><button class="btn ghost sq" id="pbstop" title="Stop">■</button><button class="btn ghost sq" id="pbrestart" title="Restart">↻</button>
    <input type="range" id="pbscrub" min="0" value="0" step="1"><span class="mono" id="pbtime">00:00 / 00:00</span>
    <span class="pbspeed">Playback speed ${[0.5, 1, 2, 4].map((v) => `<button class="spd" data-spd="${v}">${v}×</button>`).join('')}</span></div>
  <div class="card pbmain"><div class="pbhead"><div><h2>Agent Execution Flow</h2><p class="sub">${r.executors.length} hosted agents, ${r.playback.steps.length} recorded events · every animation step maps to a span in Application Insights</p></div>
    <div class="legend"><span><i style="background:#8b3cf0"></i>Agent</span><span><i style="background:#16a5a5"></i>Tool / Connector</span><span><i style="background:#1a6cf0"></i>Model</span><span><i class="dash"></i>Hosted tool (derived)</span><span><i class="glow"></i>Current playback event</span></div></div>
    <div class="pbrow"><div class="pbwrap" id="pbwrap"><div class="pbcanvas" id="pbcanvas"></div></div><div class="pbcard" id="pbcard"></div></div></div>
  <div class="pbbottom"><div class="card"><div class="pbh"><div><h2>Trace Events Timeline</h2><p class="sub">Spans from Application Insights in execution order</p></div><span class="pill ok">${r.playback.steps.length} events</span></div><div class="pbtl" id="pbtl"></div></div>
    <div class="card" id="pbdet"></div><div class="card" id="pbio"></div></div>`;
}

// ---------- mount
function pbMount() {
  const r = S.run; if (!r || !r.playback) return;
  PB.pb = r.playback; PB.steps = PB.pb.steps; PB.T = pbTiming(PB.steps);
  const lastT = PB.T[PB.T.length - 1]; PB.total = lastT.start + lastT.dur;
  Object.assign(PB, { pos: 0, cur: -1, phase: '', held: new Set(), auto: true, cardTab: 'Input', evTab: 'Overview', ioTab: 'Input', pcache: '', ncache: '', playing: false });
  const L = PB.L = pbLayout(PB.pb.nodes);
  const nodeHtml = PB.pb.nodes.map((n) => {
    const p = L.pos[n.key]; const st = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px`;
    const snip = (t) => esc((t || '').replace(/\s+/g, ' ').slice(0, 46));
    if (n.type === 'user') return `<div class="pbn user" data-k="${n.key}" style="${st}"><i>👤</i><b>User Request</b><small>${snip(n.sub) ? '"' + snip(n.sub) + '…"' : ''}</small><em class="st"></em></div>`;
    if (n.type === 'final') return `<div class="pbn final" data-k="${n.key}" style="${st}"><i>📄</i><b>Final Response</b><small>Structured answer</small><em class="st"></em></div>`;
    if (n.type === 'model') return `<div class="pbn model" data-k="${n.key}" style="${st}"><i>🧠</i><div><b>${esc(n.title)}</b><small>${esc(n.sub)}</small></div><em class="st"></em></div>`;
    if (n.type === 'tool') return `<div class="pbn tool ${n.hosted ? 'hosted' : ''}" data-k="${n.key}" style="${st}"><i>${n.hosted ? '🌐' : '🧩'}</i><b>${esc(n.title)}</b><small>${esc(n.hosted ? 'Hosted tool (no own span)' : (n.sub || 'Function tool').slice(0, 44))}</small><em class="st"></em></div>`;
    return `<div class="pbn agent" data-k="${n.key}" style="${st}"><span class="bdg">🤖</span><span class="num">${n.index}</span><b>${esc(n.title)}</b><small>${esc(execDesc({ system: n.system }))}</small><em class="st"></em></div>`;
  }).join('');
  const paths = Object.entries(L.paths).map(([k, p]) => `<path data-p="${k}" class="pbp ${p.ret ? 'ret' : ''}" d="${p.d}" marker-end="url(#pbarr)"/>`
    + (p.label ? `<text x="${p.label.x}" y="${p.label.y}" text-anchor="${p.label.a}" class="pbl">${p.label.text}</text>` : '')).join('');
  $('#pbcanvas').style.cssText = `width:${L.W}px;height:${L.H}px`;
  $('#pbcanvas').innerHTML = `<svg class="pbsvg" width="${L.W}" height="${L.H}"><defs><marker id="pbarr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>${paths}</svg>
    ${nodeHtml}<svg class="pbsvg top" width="${L.W}" height="${L.H}"><circle id="pbdot" r="8" cx="-50" cy="-50"/></svg><div class="pbhint" id="pbhint">▶ Press Play to replay this recorded run</div>`;
  L.agents.forEach(() => {});
  PB.paths = new Map([...document.querySelectorAll('#pbcanvas path[data-p]')].map((el) => [el.dataset.p, el]));
  $('#pbscrub').max = Math.round(PB.total);
  pbBuildTimeline();
  pbBind(); pbFit(); pbApply();
  if (S.pbT) { pbSeek(S.pbT); S.pbT = 0; }
  if (S.pbPlay) { S.pbPlay = false; pbToggle(); }
}

function pbFit() {
  const w = $('#pbwrap'); if (!w || !PB.L) return;
  const k = clamp((w.clientWidth - 4) / PB.L.W, 0.55, 1); PB.scale = k;
  const c = $('#pbcanvas'); c.style.transform = `scale(${k})`; c.style.transformOrigin = 'top left';
  w.style.height = Math.ceil(PB.L.H * k) + 'px';
}
window.addEventListener('resize', () => { if (S.view === 'playback') pbFit(); });
document.addEventListener('keydown', (e) => {
  if (S.view !== 'playback' || !PB.pb || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); pbToggle(); }
  if (e.code === 'ArrowRight') pbStep(1);
  if (e.code === 'ArrowLeft') pbStep(-1);
});

// ---------- controls
function pbToggle() {
  if (PB.playing) { pbStop(); pbApply(); return; }
  if (PB.pos >= PB.total) { PB.pos = 0; PB.held.clear(); }
  PB.playing = true; PB.last = performance.now(); PB.raf = requestAnimationFrame(pbFrame); pbApply();
}
function pbSeek(ms) { PB.pos = clamp(ms, 0, PB.total); PB.held.clear(); pbApply(); }
function pbStep(d) { const i = clamp(Math.max(PB.cur, 0) + d, 0, PB.steps.length - 1); pbSeek(PB.T[i].start + 1); }

function pbBind() {
  $('#pbplay').onclick = pbToggle;
  $('#pbstop').onclick = () => { pbStop(); pbSeek(0); };
  $('#pbrestart').onclick = () => { pbStop(); PB.pos = 0; PB.held.clear(); pbToggle(); };
  $('#pbscrub').oninput = (e) => pbSeek(+e.target.value);
  document.querySelectorAll('.spd').forEach((b) => b.onclick = () => { PB.speed = +b.dataset.spd; pbApply(); });
  document.querySelectorAll('.cp').forEach((b) => b.onclick = () => navigator.clipboard?.writeText(b.dataset.cp));
  const load = () => { const v = $('#pbid').value.trim(); if (/^[a-f0-9]{32}$/i.test(v)) { S.runId = v.toLowerCase(); loadRun(); } else $('#pbid').classList.add('bad'); };
  $('#pbload').onclick = load; $('#pbid').onkeydown = (e) => { if (e.key === 'Enter') load(); }; $('#pbid').oninput = (e) => e.target.classList.remove('bad');
}

// ---------- frame loop
function pbFrame(ts) {
  const dt = Math.min(ts - PB.last, 100); PB.last = ts;
  if (PB.playing) {
    PB.pos += dt * PB.speed;
    const fi = PB.steps.findIndex((s, i) => s.status === 'failed' && !PB.held.has(i) && PB.pos >= PB.T[i].start + PB.T[i].dur * 0.75);
    if (fi >= 0) { PB.held.add(fi); PB.pos = PB.T[fi].start + PB.T[fi].dur * 0.75; PB.playing = false; }
    if (PB.pos >= PB.total) { PB.pos = PB.total; PB.playing = false; }
  }
  pbApply();
  if (PB.playing) PB.raf = requestAnimationFrame(pbFrame);
}

function pbAt(pos) {
  let i = PB.T.findIndex((t) => pos < t.start + t.dur);
  if (i < 0) i = PB.T.length - 1;
  const t = PB.T[i], f = clamp((pos - t.start) / t.dur, 0, 1);
  const phase = t.two ? (f < 0.3 ? 'out' : f < 0.7 ? 'dwell' : 'back') : (PB.steps[i].kind === 'gap' || PB.steps[i].kind === 'error') ? 'pulse' : 'out';
  return { i, f, phase };
}
function pbReal(i, f) { const s = PB.steps[i]; return s.startMs + f * s.durationMs; }

function pbApply() {
  if (!PB.pb) return;
  const { i, f, phase } = pbAt(PB.pos); const s = PB.steps[i], keys = pbPathKeys(s);
  const stepChanged = i !== PB.cur;
  PB.cur = i; PB.phase = phase;
  if (stepChanged) { PB.auto = true; pbBuildDetails(); pbBuildIO(); pbMarkTimeline(); }
  const want = s.kind === 'final' || phase === 'back' ? 'Output' : s.kind === 'gap' || s.kind === 'error' ? 'Details' : 'Input';
  if (stepChanged || (PB.auto && PB.cardTab !== want)) { if (PB.auto) PB.cardTab = want; pbCard(); }

  // path classes
  const cls = new Map();
  PB.steps.forEach((x, j) => {
    if (j > i) return;
    const k = pbPathKeys(x);
    if (j < i) { if (k.out) cls.set(k.out, 'done'); if (k.back) cls.set(k.back, 'done'); }
  });
  if (keys.out) cls.set(keys.out, phase === 'out' ? 'hot' : 'done');
  if (keys.back && phase === 'back') cls.set(keys.back, 'hot');
  const pc = [...cls].join('|');
  if (pc !== PB.pcache) { PB.pcache = pc; PB.paths.forEach((el, k) => { el.setAttribute('class', `pbp ${PB.L.paths[k].ret ? 'ret' : ''} ${cls.get(k) || ''}`); }); }

  // dot
  const dot = $('#pbdot'); let pk = null, prog = 0;
  if (phase === 'out') { pk = keys.out; prog = s.kind === 'llm' || s.kind === 'tool' ? f / 0.3 : f; }
  else if (phase === 'dwell') { pk = keys.out; prog = 1; }
  else if (phase === 'back') { pk = keys.back; prog = (f - 0.7) / 0.3; }
  const pel = pk && PB.paths.get(pk);
  if (pel) { const len = pel.getTotalLength(); const pt = pel.getPointAtLength(len * ez(clamp(prog, 0, 1))); dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y); dot.setAttribute('class', phase === 'dwell' ? 'rest' : (pk.endsWith(':b') ? 'ret' : '')); }
  else { dot.setAttribute('cx', -50); dot.setAttribute('cy', -50); }

  pbNodes(i, f, phase, s);
  const real = pbReal(i, f);
  $('#pbscrub').value = Math.round(PB.pos);
  $('#pbtime').textContent = `${mmss(real)} / ${mmss(PB.pb.totalMs)}`;
  $('#pbplay').textContent = PB.playing ? '⏸ Pause' : PB.pos >= PB.total ? '↻ Replay' : '▶ Play';
  $('#pbplay').classList.toggle('on', PB.playing);
  document.querySelectorAll('.spd').forEach((b) => b.classList.toggle('on', +b.dataset.spd === PB.speed));
  $('#pbhint').style.display = PB.pos > 0 ? 'none' : 'block';
}

function pbNodes(i, f, phase, s) {
  const T = PB.T, steps = PB.steps, pos = PB.pos, state = {};
  const done = (j) => pos >= T[j].start + T[j].dur;
  PB.pb.nodes.forEach((n) => {
    let st = 'idle', txt = '';
    if (n.type === 'user') { st = pos >= T[0].start ? 'done' : 'idle'; txt = st === 'done' ? '✓ Sent' : 'Waiting'; }
    else if (n.type === 'final') { const j = steps.length - 1; st = done(j) ? (steps[j].status === 'failed' ? 'failed' : 'done') : 'idle'; txt = st === 'done' ? '✓ Completed' : st === 'failed' ? '✕ Failed' : 'Waiting'; }
    else if (n.type === 'agent') {
      const a = steps.findIndex((x) => x.to === n.key && (x.kind === 'request' || x.kind === 'handoff'));
      const l = steps.findIndex((x) => x.from === n.key && (x.kind === 'handoff' || x.kind === 'final'));
      const fl = steps.findIndex((x, j) => x.status === 'failed' && x.from === n.key && pos >= T[j].start + T[j].dur * 0.5);
      if (a >= 0 && !done(a)) { st = 'idle'; txt = 'Waiting'; }
      else if (fl >= 0) { st = 'failed'; txt = '✕ Failed'; }
      else if (l >= 0 && pos >= T[l].start) { st = 'done'; txt = `✓ Completed · ${fmtS(n.durationMs)}`; }
      else { st = 'run'; txt = '● Running'; }
    } else if (n.type === 'tool') {
      const used = steps.map((x, j) => ({ x, j })).filter((o) => o.x.to === n.key && pos >= T[o.j].start + T[o.j].dur * 0.7);
      st = used.length ? 'done' : 'idle'; txt = used.length ? `✓ ${used.length}/${n.calls} call${n.calls > 1 ? 's' : ''}${n.hosted ? '' : ' · ' + fmtS(n.totalMs)}` : 'Not called yet';
    } else if (n.type === 'model') {
      const used = steps.filter((x, j) => x.to === 'model' && pos >= T[j].start + T[j].dur * 0.7).length; st = used ? 'done' : 'idle'; txt = used ? `✓ ${used} completion${used > 1 ? 's' : ''}` : 'Not called yet';
    }
    const active = (s.from === n.key || s.to === n.key) && !done(i);
    const tgt = s.to === n.key && s.from !== s.to && phase !== 'pulse' && !done(i);
    const pulse = phase === 'pulse' && s.from === n.key;
    state[n.key] = `${st}${active ? ' act' : ''}${tgt ? ' tgt' : ''}${pulse ? (s.kind === 'error' ? ' errp' : ' unk') : ''}|${txt}`;
  });
  const sig = JSON.stringify(state);
  if (sig === PB.ncache) return; PB.ncache = sig;
  document.querySelectorAll('#pbcanvas .pbn').forEach((el) => {
    const [c, t] = state[el.dataset.k].split('|'); el.className = el.className.replace(/\s(idle|done|run|failed|act|tgt|unk|errp)\b/g, '') + ' ' + c;
    el.querySelector('.st').textContent = t;
  });
}

// ---------- panels
const pbTag = (s) => s.status === 'failed' ? ['Failed', 'failed'] : s.kind === 'gap' ? ['Uninstrumented', 'unk'] : !s.recorded ? ['Derived from model output', 'derived'] : ['Recorded span', 'ok'];
function pbBlock(text, max = 400) {
  if (!text) return '<div class="pbempty">No data was recorded for this part of the event.</div>';
  const lines = String(text).split('\n').slice(0, max);
  return `<div class="code"><pre>${lines.map((l, i) => `<div><b>${i + 1}</b><span>${esc(l)}</span></div>`).join('')}</pre></div>`;
}
function pbKV(s) {
  const row = (k, v, mono) => `<span>${k}</span><div class="${mono ? 'mono' : ''}">${v}</div>`;
  const [tg, tc] = pbTag(s);
  return `<div class="kv pbkv">${row('Event Name', esc(s.title))}${row('Timestamp', pbWall(s.startMs))}${row('Duration', s.recorded || s.kind === 'gap' ? fmtS(s.durationMs) : 'n/a (no span)')}
    ${row('Parent Span', esc(s.parentSpanId || '—'), 1)}${row('Span ID', esc(s.spanId || '—'), 1)}${row('Service', esc(s.service))}${row('Operation', esc(s.operation), 1)}${row('Type', pbKind[s.kind][1])}
    ${s.meta ? row('Tokens', `${s.meta.tokensIn} in / ${s.meta.tokensOut} out · finish: ${esc(s.meta.finish || 'n/a')}`) : ''}
    ${row('Status', `<span class="pill ${tc === 'failed' ? 'failed' : tc === 'ok' ? 'ok' : 'unk'}">${tg}</span>`)}</div>
    ${s.note ? `<div class="pbnote">ℹ ${esc(s.note)}</div>` : ''}${s.error ? `<div class="pbnote err">✕ ${esc(s.error)}</div>` : ''}`;
}

function pbCard() {
  const s = PB.steps[PB.cur], n = PB.steps.length, [tg, tc] = pbTag(s);
  const body = PB.cardTab === 'Details' ? pbKV(s) : pbBlock(PB.cardTab === 'Input' ? s.input : s.output, 16);
  $('#pbcard').innerHTML = `<div class="pbch"><span>Recorded event ${String(PB.cur + 1).padStart(2, '0')} of ${n}</span><span><button class="ghost sq" data-nav="-1">‹</button><button class="ghost sq" data-nav="1">›</button></span></div>
    <div class="pbct"><i>${pbKind[s.kind][0]}</i><b>${esc(s.title)}</b><span class="pill ${tc === 'failed' ? 'failed' : tc === 'ok' ? 'ok' : 'unk'}">${tg}</span></div>
    <div class="pbmini"><div>🕒 ${pbWall(s.startMs)}</div><div>⏱ ${s.recorded || s.kind === 'gap' ? fmtS(s.durationMs) : 'n/a'}</div><div>⚙ ${esc(s.operation)}</div><div>☁ ${esc(s.service)}</div></div>
    <div class="tabs">${['Input', 'Output', 'Details'].map((t) => `<div class="${t === PB.cardTab ? 'on' : ''}" data-ct="${t}">${t}</div>`).join('')}</div>${body}
    ${s.error && PB.cardTab !== 'Details' ? `<div class="pbnote err">✕ ${esc(s.error)}</div>` : ''}${s.note && PB.cardTab !== 'Details' ? `<div class="pbnote">ℹ ${esc(s.note)}</div>` : ''}`;
  document.querySelectorAll('[data-ct]').forEach((el) => el.onclick = () => { PB.auto = false; PB.cardTab = el.dataset.ct; pbCard(); });
  document.querySelectorAll('[data-nav]').forEach((el) => el.onclick = () => pbStep(+el.dataset.nav));
}

function pbBuildTimeline() {
  const ic = (s) => s.status === 'failed' ? '<i class="ti bad">✕</i>' : s.kind === 'gap' ? '<i class="ti unk">◌</i>' : !s.recorded ? '<i class="ti drv">◐</i>' : '<i class="ti ok">✓</i>';
  $('#pbtl').innerHTML = `<table><tr><th>#</th><th>Timestamp</th><th>Duration</th><th>Event</th><th>Status</th></tr>${PB.steps.map((s, i) => `<tr data-ti="${i}"><td><span class="no">${s.id}</span></td><td class="mono">${pbWall(s.startMs)}</td><td>${s.recorded || s.kind === 'gap' ? fmtS(s.durationMs) : '—'}</td><td>${esc(s.title)}</td><td>${ic(s)}</td></tr>`).join('')}</table>`;
  document.querySelectorAll('tr[data-ti]').forEach((el) => el.onclick = () => pbSeek(PB.T[+el.dataset.ti].start + 1));
}
function pbMarkTimeline() {
  document.querySelectorAll('tr[data-ti]').forEach((el) => { const j = +el.dataset.ti; el.classList.toggle('cur', j === PB.cur); el.classList.toggle('past', j < PB.cur); });
  const row = $(`tr[data-ti="${PB.cur}"]`), box = $('#pbtl');
  if (row && box) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + 20);
}

function pbBuildDetails() {
  const s = PB.steps[PB.cur];
  const raw = JSON.stringify(s, null, 2);
  const body = PB.evTab === 'Overview' ? pbKV(s) : PB.evTab === 'Input' ? pbBlock(s.input) : PB.evTab === 'Output' ? pbBlock(s.output) : pbBlock(raw);
  const [tg, tc] = pbTag(s);
  $('#pbdet').innerHTML = `<div class="pbh"><h2>Event Details</h2><span class="pill ${tc === 'failed' ? 'failed' : tc === 'ok' ? 'ok' : 'unk'}">${tg}</span></div>
    <div class="tabs">${['Overview', 'Input', 'Output', 'Raw JSON'].map((t) => `<div class="${t === PB.evTab ? 'on' : ''}" data-et="${t}">${t}</div>`).join('')}</div><div class="pbscr">${body}</div>`;
  document.querySelectorAll('[data-et]').forEach((el) => el.onclick = () => { PB.evTab = el.dataset.et; pbBuildDetails(); });
}
function pbBuildIO() {
  const s = PB.steps[PB.cur];
  if (!s.input && s.output) PB.ioTab = 'Output'; else if (!s.output && s.input) PB.ioTab = 'Input';
  const txt = PB.ioTab === 'Input' ? s.input : s.output;
  $('#pbio').innerHTML = `<div class="pbh"><h2>Input / Output</h2><button class="btn ghost" id="pbcopy">⧉ Copy</button></div>
    <div class="tabs">${['Input', 'Output'].map((t) => `<div class="${t === PB.ioTab ? 'on' : ''}" data-it="${t}">${t === 'Input' ? 'Input (Request)' : 'Output (Response)'}</div>`).join('')}</div><div class="pbscr">${pbBlock(txt)}</div>`;
  document.querySelectorAll('[data-it]').forEach((el) => el.onclick = () => { PB.ioTab = el.dataset.it; pbBuildIO(); });
  $('#pbcopy').onclick = () => navigator.clipboard?.writeText(txt || '');
}
