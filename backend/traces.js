// Run-level trace API built on Application Insights gen_ai / workflow spans.
const AGENT_RE = /^[\w.-]{1,100}$/;
const ID_RE = /^[a-f0-9]{32}$/i;
const MAX = 8000;

const clip = (s, n = MAX) => (s && s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} chars]` : s || '');
const parseJson = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);

function partText(p) {
  if (p.type === 'text') return p.content ?? '';
  if (p.type === 'tool_call') return `[tool_call] ${p.name}(${typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments)})`;
  if (p.type === 'tool_call_response') return `[tool_result] ${typeof p.response === 'string' ? p.response : JSON.stringify(p.response ?? p.result ?? '')}`;
  return `[${hostedName(p)}] ${JSON.stringify(p.arguments ?? p.response ?? '').slice(0, 300)}`;
}
function hostedName(p) {
  return p.tool_name || p.name || String(p.type).replace(/_(call|result)(_response)?$/, '').replace(/^search_tool$/, 'web_search');
}
const BASIC_PARTS = ['text', 'tool_call', 'tool_call_response'];
// Platform-hosted tools (e.g. web search) are only visible as parts inside the model output, not as their own spans.
function hostedCalls(raw) {
  const arr = parseJson(raw);
  if (!Array.isArray(arr)) return [];
  const byCall = new Map(); const out = [];
  arr.forEach((m) => (m.parts || []).forEach((p) => {
    if (BASIC_PARTS.includes(p.type)) return;
    const k = p.call_id || p.id || String(out.length);
    let h = byCall.get(k);
    if (!h) { h = { name: hostedName(p), callId: k, input: '', output: '', status: '' }; byCall.set(k, h); out.push(h); }
    h.status = p.status || h.status;
    if (p.result !== undefined || /_result$/.test(p.type)) {
      const act = p.result && p.result.action;
      if (act && (act.queries || act.query)) h.input = JSON.stringify({ queries: act.queries, query: act.query }, null, 2);
      h.output = JSON.stringify(p.result ?? p.response ?? '', null, 2);
    } else if (!h.input) h.input = JSON.stringify(p.arguments ?? '', null, 2);
  }));
  return out;
}
function msgText(raw, roles, textOnly) {
  const arr = parseJson(raw);
  if (!Array.isArray(arr)) return '';
  return arr.filter((m) => !roles || roles.includes(m.role))
    .map((m) => (m.parts || []).filter((p) => !textOnly || p.type === 'text').map(partText).join('\n')).join('\n\n').trim();
}
function sysText(raw) {
  const arr = parseJson(raw);
  return Array.isArray(arr) ? arr.map((p) => p.content ?? '').join('\n') : '';
}
function outputToolNames(raw) {
  const arr = parseJson(raw);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((m) => (m.parts || []).filter((p) => p.type !== 'text' && p.type !== 'tool_call' && p.type !== 'tool_call_response').map(hostedName));
}

function validateAgent(a) { if (!AGENT_RE.test(a || '')) throw Object.assign(new Error('bad agent'), { status: 400 }); return a; }

// Converts recorded spans into an ordered, normalized sequence of visual events. Nothing here is simulated:
// every step carries the span it came from, or is explicitly flagged as derived / uninstrumented.
const GAP_MS = 1500;
function buildPlayback({ root, wf, executors, userQuery, finalResponse, byId, excRows }) {
  const t0 = root.t;
  const off = (iso) => new Date(iso).getTime() - t0;
  const steps = []; let seq = 0;
  const push = (s) => steps.push({ status: 'ok', recorded: true, seq: seq++, ...s });
  const errFor = (spanId, startMs, endMs) => {
    const sp = byId.get(spanId); const parts = [];
    if (sp && sp.cd['error.type']) parts.push(sp.cd['error.type']);
    excRows.filter((x) => { const t = off(x.timestamp); return t >= startMs - 50 && t <= endMs + 1000; }).forEach((x) => parts.push(`${x.type}: ${x.message}`));
    return [...new Set(parts)].join('\n');
  };
  const nodes = [{ key: 'user', type: 'user', title: 'User Request', sub: userQuery }];
  const toolNodes = new Map();
  const model = executors.flatMap((e) => e.llmCalls).find((c) => c.model)?.model || 'model';
  executors.forEach((e, i) => {
    nodes.push({ key: `agent:${i}`, type: 'agent', title: e.name, index: i + 1, status: e.status, durationMs: e.durationMs, model: e.model, system: e.system });
    e.toolCalls.forEach((c) => {
      const k = `tool:${i}:${c.name}`;
      if (!toolNodes.has(k)) toolNodes.set(k, { key: k, type: 'tool', agent: i, title: c.name, sub: (c.description || '').split('\n')[0], calls: 0, totalMs: 0, hosted: false });
      const n = toolNodes.get(k); n.calls++; n.totalMs += c.durationMs;
    });
    e.llmCalls.forEach((c) => c.hostedCalls.forEach((h) => {
      const k = `tool:${i}:${h.name}`;
      if (!toolNodes.has(k)) toolNodes.set(k, { key: k, type: 'tool', agent: i, title: h.name, sub: 'Platform-hosted tool', calls: 0, totalMs: 0, hosted: true });
      toolNodes.get(k).calls++;
    }));
  });
  nodes.push(...toolNodes.values(), { key: 'model', type: 'model', title: model, sub: 'Foundry model deployment' }, { key: 'final', type: 'final', title: 'Final Response', sub: finalResponse });

  const first = executors[0];
  push({ kind: 'request', from: 'user', to: 'agent:0', startMs: 0, durationMs: Math.max(first ? off(first.start) : 0, 0), title: 'User request received',
    service: 'Hosted agent endpoint', operation: 'POST /responses', spanId: root.id, parentSpanId: root.parent || '', input: userQuery, output: '' });

  executors.forEach((e, i) => {
    const eStart = off(e.start), eEnd = eStart + e.durationMs;
    if (i > 0) {
      const p = executors[i - 1]; const pEnd = off(p.start) + p.durationMs;
      push({ kind: 'handoff', from: `agent:${i - 1}`, to: `agent:${i}`, startMs: pEnd, durationMs: Math.max(eStart - pEnd, 0), title: `Hand-off: ${p.name} → ${e.name}`,
        recorded: false, note: 'Inferred from executor start order, not a recorded causal edge. Use Solution Workspaces for concurrent or distributed traces.',
        service: 'Workflow engine', operation: 'edge_group.process', spanId: e.spanId, parentSpanId: e.parentSpanId, input: p.output, output: '' });
    }
    const a = `agent:${i}`;
    const items = [
      ...e.llmCalls.map((c, n) => ({ ...c, k: 'llm', n: n + 1 })),
      ...e.toolCalls.map((c) => ({ ...c, k: 'tool' })),
    ].sort((x, y) => new Date(x.start) - new Date(y.start));
    let cursor = eStart; const gap = (from, to) => {
      if (to - from > GAP_MS) push({ kind: 'gap', from: a, to: a, startMs: from, durationMs: to - from, status: 'unknown', recorded: false, title: `${e.name} – uninstrumented time`,
        service: 'No span recorded', operation: '—', spanId: '', parentSpanId: e.spanId, input: '', output: '', note: 'Time inside this agent not covered by any recorded model or tool span.' });
    };
    items.forEach((c) => {
      const s = off(c.start), end = s + c.durationMs;
      gap(cursor, s);
      const failed = c.success === false;
      const err = failed ? errFor(c.spanId, s, end) : '';
      if (c.k === 'llm') {
        push({ kind: 'llm', from: a, to: 'model', startMs: s, durationMs: c.durationMs, status: failed ? 'failed' : 'ok', title: `LLM call ${c.n} – ${c.model || model}`,
          service: 'Foundry model', operation: `chat ${c.model || ''}`.trim(), spanId: c.spanId, parentSpanId: c.parentSpanId, input: c.input, output: c.output,
          inputRaw: c.inputRaw, outputRaw: c.outputRaw, error: err, meta: { tokensIn: c.tokensIn, tokensOut: c.tokensOut, finish: c.finish } });
        c.hostedCalls.forEach((h) => push({ kind: 'tool', from: a, to: `tool:${i}:${h.name}`, startMs: end, durationMs: 0, recorded: false, title: `Hosted tool – ${h.name}`,
          service: 'Platform-hosted tool', operation: h.name, spanId: c.spanId, parentSpanId: c.parentSpanId, input: h.input, output: h.output,
          note: 'Reported inside the model response. It has no span of its own, so no separate timing is available.' }));
      } else {
        push({ kind: 'tool', from: a, to: `tool:${i}:${c.name}`, startMs: s, durationMs: c.durationMs, status: failed ? 'failed' : 'ok', title: `Tool call – ${c.name}`,
          service: 'Function tool', operation: c.name, spanId: c.spanId, parentSpanId: c.parentSpanId, input: c.args, output: c.result, error: err });
      }
      cursor = Math.max(cursor, end);
    });
    gap(cursor, eEnd);
    if (e.status === 'failed' && !steps.some((s) => s.status === 'failed' && s.from === a)) {
      push({ kind: 'error', from: a, to: a, startMs: eEnd, durationMs: 0, status: 'failed', title: `${e.name} failed`, service: 'Workflow engine', operation: `executor.process ${e.name}`,
        spanId: e.spanId, parentSpanId: e.parentSpanId, input: '', output: '', error: errFor(e.spanId, eStart, eEnd) || 'Executor span reported failure.' });
    }
  });

  const last = executors[executors.length - 1];
  const lastEnd = last ? off(last.start) + last.durationMs : 0;
  push({ kind: 'final', from: last ? `agent:${executors.length - 1}` : 'user', to: 'final', startMs: lastEnd, durationMs: Math.max(wf.t + wf.durationMs - t0 - lastEnd, 0),
    status: wf.success === false ? 'failed' : 'ok', title: wf.success === false ? (wf.single ? 'Agent run failed' : 'Workflow failed') : 'Final response produced', service: 'Hosted agent endpoint',
    operation: wf.single ? 'invoke_agent' : 'workflow.run', spanId: wf.id, parentSpanId: wf.parent, input: '', output: finalResponse });

  steps.sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  steps.forEach((s, i) => { s.id = i + 1; s.startMs = Math.round(s.startMs); delete s.seq; });
  return { startedAt: root.timestamp, totalMs: Math.max(wf.t + wf.durationMs - t0, ...steps.map((s) => s.startMs + s.durationMs)), nodes, steps };
}

module.exports = function build(aiQuery) {
  const anchorOf = (single) => (single ? `tostring(customDimensions['gen_ai.operation.name'])=='invoke_agent'` : `name=='workflow.run'`);

  async function summary(agent, days, single) {
    validateAgent(agent);
    days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
    const bin = days <= 2 ? '1h' : '1d';
    const base = `dependencies | where timestamp > ago(${days}d) and cloud_RoleName == '${agent}' | where ${anchorOf(single)}`;
    const [tot, series] = await Promise.all([
      aiQuery(`${base} | summarize total=count(), ok=countif(success==true), failed=countif(success==false), avgMs=avg(duration), p95Ms=percentile(duration,95)`),
      aiQuery(`${base} | summarize n=count(), failed=countif(success==false) by t=bin(timestamp, ${bin}) | order by t asc`),
    ]);
    return { days, totals: tot[0] || { total: 0, ok: 0, failed: 0, avgMs: 0, p95Ms: 0 }, series };
  }

  // Classify every instrumented role: graph workflow vs. single agent, with the workflow name when recorded.
  async function wfAgents(days) {
    days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
    const [agg, wfAttrs, edgeAttrs] = await Promise.all([
      aiQuery(`dependencies | where timestamp > ago(${days}d)
        | extend op=tostring(customDimensions['gen_ai.operation.name'])
        | summarize wfRuns=countif(name=='workflow.run'), agRuns=countif(op=='invoke_agent'), toolCalls=countif(op=='execute_tool'),
            lastSeen=max(timestamp), executors=make_set_if(name, name startswith 'executor.process ', 30),
            edgeSpans=countif(name startswith 'edge_group'), msgSpans=countif(name startswith 'message.send'),
            agentNames=make_set_if(tostring(customDimensions['gen_ai.agent.name']), op=='invoke_agent', 20)
          by role=cloud_RoleName
        | where wfRuns > 0 or agRuns > 0 | order by lastSeen desc`),
      aiQuery(`dependencies | where timestamp > ago(${days}d) and name=='workflow.run'
        | summarize arg_max(timestamp, cd=tostring(customDimensions)) by role=cloud_RoleName`),
      aiQuery(`dependencies | where timestamp > ago(${days}d) and name startswith 'edge_group'
        | summarize arg_max(timestamp, cd=tostring(customDimensions)), n=count(), types=make_set(tostring(customDimensions['edge_group.type']), 10) by role=cloud_RoleName`),
    ]);
    const wfBy = new Map(wfAttrs.map((r) => [r.role, parseJson(r.cd) || {}]));
    const edBy = new Map(edgeAttrs.map((r) => [r.role, { ...(parseJson(r.cd) || {}), types: r.types }]));
    const pick = (o, keys) => { for (const k of keys) if (o[k]) return String(o[k]); return ''; };
    return agg.filter((a) => a.role !== 'responsesapi').map((a) => {
      const wf = wfBy.get(a.role) || {};
      const ed = edBy.get(a.role) || {};
      const arr = (v) => (Array.isArray(v) ? v : parseJson(v) || []);
      const isWorkflow = a.wfRuns > 0;
      const execs = arr(a.executors).map((n) => n.slice('executor.process '.length));
      const edgeTypes = arr(ed.types).filter(Boolean);
      const lc = [...edgeTypes, ...execs].join(' ').toLowerCase();
      let pattern = 'Single agent';
      if (isWorkflow) {
        pattern = /magentic/.test(lc) ? 'Magentic orchestration' : /handoff/.test(lc) ? 'Handoff orchestration'
          : /group.?chat|orchestrator/.test(lc) ? 'Group chat orchestration'
          : /fan.?out|fan.?in|concurrent|aggregat/.test(lc) ? 'Concurrent (fan-out / fan-in)'
          : /switch|conditional/.test(lc) ? 'Branching graph workflow' : execs.length > 1 ? 'Sequential graph workflow' : 'Graph workflow';
      }
      return {
        role: a.role, kind: isWorkflow ? 'workflow' : 'agent', pattern, workflowName: pick(wf, ['workflow.name', 'workflow_name', 'workflow.id', 'workflow_id']),
        workflowAttrs: Object.keys(wf).filter((k) => /workflow/i.test(k)), edgeTypes,
        runs: isWorkflow ? a.wfRuns : a.agRuns, toolCalls: a.toolCalls, lastSeen: a.lastSeen, executors: execs, agentNames: arr(a.agentNames).filter(Boolean),
        edgeSpans: a.edgeSpans, evidence: isWorkflow ? `${a.wfRuns} workflow.run span(s), ${execs.length} executor(s)` : `${a.agRuns} invoke_agent span(s), no workflow.run`,
      };
    });
  }

  async function runs(agent, days, single) {
    validateAgent(agent);
    days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
    const anc = anchorOf(single);
    return aiQuery(`dependencies | where timestamp > ago(${days}d) and cloud_RoleName == '${agent}'
      | extend op=tostring(customDimensions['gen_ai.operation.name']), isAnchor=(${anc})
      | extend tok=iff(op=='chat', tolong(customDimensions['gen_ai.usage.input_tokens'])+tolong(customDimensions['gen_ai.usage.output_tokens']), long(0))
      | summarize start=minif(timestamp, isAnchor), durationMs=maxif(duration, isAnchor),
          fails=countif(isAnchor and success==false), wf=countif(isAnchor),
          tokens=sum(tok), toolCalls=countif(op=='execute_tool'), agents=dcountif(name, name startswith 'executor.process ')
        by runId=operation_Id
      | where wf > 0 | order by start desc | take 200`);
  }

  async function run(id) {
    if (!ID_RE.test(id || '')) throw Object.assign(new Error('bad run id'), { status: 400 });
    const [spanRows, logRows, excRows] = await Promise.all([
      aiQuery(`union dependencies, requests | where operation_Id == '${id}'
        | project timestamp, id, parent=operation_ParentId, itemType, name, durationMs=duration, success, cd=tostring(customDimensions)
        | order by timestamp asc | take 500`),
      aiQuery(`traces | where operation_Id == '${id}' and message !contains '/readiness' | order by timestamp asc
        | project timestamp, message | take 100`),
      aiQuery(`exceptions | where operation_Id == '${id}' | project timestamp, type, message=outerMessage | take 20`),
    ]);
    const spans = spanRows.map((s) => ({ ...s, cd: parseJson(s.cd) || {}, t: new Date(s.timestamp).getTime(), children: [] }));
    const byId = new Map(spans.map((s) => [s.id, s]));
    spans.forEach((s) => { const p = byId.get(s.parent); if (p) p.children.push(s); });
    const root = spans.find((s) => s.itemType === 'request') || spans.find((s) => !byId.has(s.parent));
    let wf = spans.find((s) => s.name === 'workflow.run');
    if (!wf) {
      // Not a graph workflow: treat the outermost invoke_agent span as a one-agent run.
      wf = spans.filter((s) => s.cd['gen_ai.operation.name'] === 'invoke_agent').sort((a, b) => a.t - b.t)[0];
      if (wf) wf.single = true;
    }
    if (!root || !wf) throw Object.assign(new Error('run not found'), { status: 404 });

    const reachable = [];
    (function walk(s, depth) { s.depth = depth; reachable.push(s); s.children.sort((a, b) => a.t - b.t).forEach((c) => walk(c, depth + 1)); })(root, 0);
    const descendants = (s) => { const out = []; (function w(x) { x.children.forEach((c) => { out.push(c); w(c); }); })(s); return out; };

    const execSpans = wf.single ? [wf] : wf.children.filter((c) => c.name.startsWith('executor.process '));
    const executors = execSpans.sort((a, b) => a.t - b.t).map((e, idx) => {
      const name = wf.single ? (e.cd['gen_ai.agent.name'] || e.name) : e.name.slice('executor.process '.length);
      const d = descendants(e);
      const llmCalls = d.filter((x) => x.cd['gen_ai.operation.name'] === 'chat').map((x) => ({
        spanId: x.id, parentSpanId: x.parent, hostedCalls: hostedCalls(x.cd['gen_ai.output.messages']),
        start: x.timestamp, durationMs: x.durationMs, success: x.success, model: x.cd['gen_ai.request.model'] || '',
        tokensIn: num(x.cd['gen_ai.usage.input_tokens']), tokensOut: num(x.cd['gen_ai.usage.output_tokens']),
        finish: x.cd['gen_ai.response.finish_reasons'] || '',
        input: clip(msgText(x.cd['gen_ai.input.messages'])), output: clip(msgText(x.cd['gen_ai.output.messages'])),
        outputText: clip(msgText(x.cd['gen_ai.output.messages'], null, true)),
        inputRaw: clip(x.cd['gen_ai.input.messages']), outputRaw: clip(x.cd['gen_ai.output.messages']),
        system: clip(sysText(x.cd['gen_ai.system_instructions'])), hostedTools: outputToolNames(x.cd['gen_ai.output.messages']),
      }));
      const toolCalls = d.filter((x) => x.cd['gen_ai.operation.name'] === 'execute_tool').map((x) => ({
        spanId: x.id, parentSpanId: x.parent, name: x.cd['gen_ai.tool.name'] || x.name, start: x.timestamp, durationMs: x.durationMs, success: x.success,
        description: clip(x.cd['gen_ai.tool.description'], 600), args: clip(x.cd['gen_ai.tool.call.arguments'], 3000),
        result: clip(x.cd['gen_ai.tool.call.result'], 4000),
      }));
      const lastLlm = llmCalls[llmCalls.length - 1];
      return {
        spanId: e.id, parentSpanId: e.parent, index: idx + 1, name, start: e.timestamp, durationMs: e.durationMs, status: e.success === false ? 'failed' : 'completed',
        model: llmCalls.find((c) => c.model)?.model || '',
        tokensIn: llmCalls.reduce((a, c) => a + c.tokensIn, 0), tokensOut: llmCalls.reduce((a, c) => a + c.tokensOut, 0),
        system: llmCalls.find((c) => c.system)?.system || '',
        input: clip(llmCalls[0]?.input || ''), inputRaw: llmCalls[0]?.inputRaw || '',
        output: clip([...llmCalls].reverse().find((c) => c.outputText)?.outputText || lastLlm?.output || ''), outputRaw: lastLlm?.outputRaw || '',
        llmCalls, toolCalls, hostedTools: [...new Set(llmCalls.flatMap((c) => c.hostedTools).filter((n) => !toolCalls.some((t) => t.name === n)))],
      };
    });

    const rootCd = root.cd || {};
    const latency = {};
    Object.entries(rootCd).forEach(([k, v]) => { if (k.startsWith('hosted_agent.latency.')) latency[k.slice('hosted_agent.latency.'.length)] = v; });
    const first = executors[0], last = executors[executors.length - 1];
    const preview = (s) => (s || '').replace(/\s+/g, ' ').replace(/^(None|null|\{\})$/, '').slice(0, 140);

    const timeline = [{ t: root.timestamp, kind: 'request', status: 'ok', title: 'Request received', detail: `POST /responses (${rootCd['azure.ai.agentserver.response_id'] || root.id})` },
      { t: wf.timestamp, kind: 'workflow', status: 'ok', title: 'Workflow started', detail: `${executors.length} agents: ${executors.map((e) => e.name).join(' → ')}` }];
    for (const e of executors) {
      timeline.push({ t: e.start, kind: 'agent', status: 'running', title: `${e.name} started`, detail: preview(e.input) });
      e.llmCalls.forEach((c, i) => timeline.push({ t: c.start, kind: 'llm', status: 'ok', title: `LLM call ${i + 1} (${c.model})`, detail: `${c.tokensIn} in / ${c.tokensOut} out tokens, ${(c.durationMs / 1000).toFixed(1)}s, finish: ${c.finish || 'n/a'}` }));
      e.toolCalls.forEach((c) => timeline.push({ t: c.start, kind: 'tool', status: c.success === false ? 'failed' : 'ok', title: `Tool: ${c.name}`, detail: preview(c.args) || 'no arguments' }));
      timeline.push({ t: new Date(new Date(e.start).getTime() + e.durationMs).toISOString(), kind: 'agent', status: e.status === 'failed' ? 'failed' : 'ok', title: `${e.name} completed`, detail: preview(e.output) });
    }
    timeline.push({ t: new Date(wf.t + wf.durationMs).toISOString(), kind: 'final', status: wf.success === false ? 'failed' : 'ok', title: wf.success === false ? 'Workflow failed' : 'Final response generated', detail: preview(last?.output) });
    timeline.sort((a, b) => new Date(a.t) - new Date(b.t));

    const userQuery = first ? (first.llmCalls[0]?.input || '').replace(/^\[tool_call\].*$/gm, '').trim() : '';
    const playback = buildPlayback({ root, wf, executors, userQuery, finalResponse: last?.output || '', byId, excRows });

    return {
      playback,
      runId: id, start: wf.timestamp, durationMs: wf.durationMs, success: wf.success !== false,
      requestId: rootCd['azure.ai.agentserver.x-request-id'] || '', responseId: rootCd['azure.ai.agentserver.response_id'] || '',
      sessionId: rootCd['azure.ai.agentserver.session_id'] || '', channel: rootCd['microsoft.channel.name'] || '',
      agentVersion: rootCd['gen_ai.agent.version'] || '', latency,
      workflowName: wf.cd['workflow.name'] || '', workflowId: wf.cd['workflow.id'] || '', single: !!wf.single,
      tokensIn: executors.reduce((a, e) => a + e.tokensIn, 0), tokensOut: executors.reduce((a, e) => a + e.tokensOut, 0),
      userQuery: first ? (first.llmCalls[0]?.input || '').replace(/^\[tool_call\].*$/gm, '').trim() : '',
      finalResponse: last?.output || '',
      executors, timeline,
      spans: reachable.map((s) => ({ id: s.id, parent: s.parent, name: s.name, start: s.timestamp, offsetMs: s.t - root.t, durationMs: s.durationMs, success: s.success !== false, depth: s.depth, kind: s.cd['gen_ai.operation.name'] || s.itemType })),
      logs: logRows.map((l) => ({ t: l.timestamp, message: l.message })),
    };
  }

  return { summary, runs, run, wfAgents };
};
