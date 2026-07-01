// Guard: raw tool-call syntax must never reach the citizen.
// Prod bug (+96892888715): asking «خدمات الشرطة» returned the literal
//   <tool_code>{"name":"get_entity_services","arguments":{"entity":"Royal Oman Police"}}</tool_code>
// because Qwen emitted the tool call as TEXT in `content` instead of the
// structured tool_calls field. We now (a) recover + execute it in llm.js, and
// (b) strip any residual in sanitizeReply.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTextToolCalls, tryParseToolJson } from '../lib/llm.js';
import { sanitizeReply } from '../lib/agent.js';

test('extractTextToolCalls recovers the exact prod <tool_code> block', () => {
  const content = '<tool_code>\n{"name": "get_entity_services", "arguments": {"entity": "Royal Oman Police"}}\n</tool_code>';
  const { tool_calls, content: cleaned } = extractTextToolCalls(content);
  assert.ok(tool_calls && tool_calls.length === 1, 'a tool call is recovered');
  assert.equal(tool_calls[0].function.name, 'get_entity_services');
  assert.deepEqual(JSON.parse(tool_calls[0].function.arguments), { entity: 'Royal Oman Police' });
  assert.equal(cleaned, null, 'nothing left to show the user');
});

test('extractTextToolCalls recovers a bare tool-JSON (no wrapper)', () => {
  const { tool_calls } = extractTextToolCalls('{"name":"search_services","arguments":{"q":"police"}}');
  assert.ok(tool_calls);
  assert.equal(tool_calls[0].function.name, 'search_services');
});

test('extractTextToolCalls leaves ordinary text untouched', () => {
  const { tool_calls, content } = extractTextToolCalls('مرحبا، كيف حالك؟');
  assert.equal(tool_calls, null);
  assert.equal(content, 'مرحبا، كيف حالك؟');
});

test('extractTextToolCalls keeps surrounding text and strips only the block', () => {
  const { tool_calls, content } = extractTextToolCalls('حسناً <tool_code>{"name":"x","arguments":{}}</tool_code> تمام');
  assert.ok(tool_calls);
  assert.doesNotMatch(content, /tool_code/);
  assert.match(content, /حسناً/);
  assert.match(content, /تمام/);
});

test('sanitizeReply strips a leaked <tool_code> block (safety net)', () => {
  const out = sanitizeReply('<tool_code>\n{"name":"get_entity_services","arguments":{"entity":"ROP"}}\n</tool_code>', 'خدمات الشرطة');
  assert.doesNotMatch(out || '', /tool_code|get_entity_services/);
});

test('sanitizeReply drops a whole-reply bare tool-JSON', () => {
  const out = sanitizeReply('{"name":"search_services","arguments":{"q":"x"}}', 'x');
  assert.equal((out || '').trim(), '');
});

test('sanitizeReply leaves a normal reply intact', () => {
  const out = sanitizeReply('🔎 وجدت 3 خدمات قد تناسبك', 'x');
  assert.match(out, /وجدت 3 خدمات/);
});
