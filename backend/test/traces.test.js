const { test } = require('node:test');
const assert = require('node:assert/strict');
const build = require('../traces');
const traceId = 'a'.repeat(32);
function row(id, parent, name, itemType, durationMs, cd, offset = 0, success = true) {
  return { id, parent, name, itemType, durationMs, cd: JSON.stringify(cd), timestamp: new Date(Date.UTC(2026, 10, 14) + offset).toISOString(), success };
}
test('existing single hosted-agent run retains model calls, tools, IO and recorded playback', async () => {
  const messages = (role, content) => JSON.stringify([{ role, parts: [{ type: 'text', content }] }]);
  const spans = [row('root', '', 'POST /responses', 'request', 1000, {}),
    row('agent', 'root', 'invoke_agent assistant', 'dependency', 900, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'assistant' }, 10),
    row('chat', 'agent', 'chat model', 'dependency', 100, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'test-model',
      'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20,
      'gen_ai.input.messages': messages('user', 'Question'), 'gen_ai.output.messages': messages('assistant', 'Answer') }, 20),
    row('tool', 'agent', 'execute_tool lookup', 'dependency', 100, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', 'gen_ai.tool.call.arguments': '{}', 'gen_ai.tool.call.result': 'value' }, 150)];
  const service = build(async (query) => query.startsWith('union ') ? spans : []);
  const run = await service.run(traceId);
  assert.equal(run.single, true); assert.equal(run.executors.length, 1);
  assert.equal(run.executors[0].name, 'assistant'); assert.equal(run.executors[0].toolCalls[0].name, 'lookup');
  assert.equal(run.userQuery, 'Question'); assert.equal(run.finalResponse, 'Answer');
  assert.equal(run.tokensIn, 100); assert.equal(run.tokensOut, 20);
  assert.deepEqual(run.playback.steps.filter((s) => s.recorded).map((s) => s.kind), ['request', 'llm', 'tool', 'final']);
  assert.ok(!run.playback.steps.some((s) => s.kind === 'handoff'));
});
test('optional-looking query failures are surfaced instead of silently returning empty exceptions or edge evidence', async () => {
  const service = build(async (query) => { if (query.startsWith('exceptions') || query.includes("name startswith 'edge_group'")) throw new Error('Telemetry query denied'); return []; });
  await assert.rejects(service.run(traceId), /Telemetry query denied/);
  await assert.rejects(service.wfAgents(7), /Telemetry query denied/);
});
