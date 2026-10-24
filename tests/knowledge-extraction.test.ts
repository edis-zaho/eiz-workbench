import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgePrompt, parseKnowledgeSuggestions, ExtractionSource } from '../core/knowledge-extraction';
import { ClaimContent } from '../core/knowledge-input';

const validSource: ExtractionSource = {
  id: '11111111-1111-1111-1111-111111111111',
  productId: '22222222-2222-2222-2222-222222222222',
  productRevision: 1,
  title: 'Source One',
  text: 'Our product features an innovative Turbo Encabulator. It increases efficiency by 25%.',
};

const validSource2: ExtractionSource = {
  ...validSource,
  id: '33333333-3333-3333-3333-333333333333',
  title: 'Source Two',
  text: 'A customer mentioned: \"The Turbo Encabulator is a game changer!\"',
};

test('createKnowledgePrompt: validation for source array', () => {
  assert.throws(() => createKnowledgePrompt([]), { message: 'Sources must be an array with 1 to 8 items.' });
  assert.throws(() => createKnowledgePrompt(Array(9).fill(validSource)), { message: 'Sources must be an array with 1 to 8 items.' });
  assert.throws(() => createKnowledgePrompt([{...validSource, id: 'not-a-uuid'}]), { message: 'Invalid source ID format.'});
  assert.throws(() => createKnowledgePrompt([{...validSource, productId: 'not-a-uuid'}]), { message: 'Invalid product ID format in source.'});
  assert.throws(() => createKnowledgePrompt([{...validSource, productRevision: 0}]), { message: 'Product revision must be a positive integer.'});
  assert.throws(() => createKnowledgePrompt([validSource, {...validSource, productId: '44444444-4444-4444-4444-444444444444'}]), { message: 'All sources must share the same productId and productRevision.' });
  assert.throws(() => createKnowledgePrompt([validSource, {...validSource, productRevision: 2}]), { message: 'All sources must share the same productId and productRevision.' });
  assert.throws(() => createKnowledgePrompt([validSource, validSource]), { message: 'Source IDs must be unique.' });
});

test('createKnowledgePrompt: validation for source content', () => {
  const longText = 'a'.repeat(20001);
  assert.throws(() => createKnowledgePrompt([{ ...validSource, text: longText }]), { message: 'Text is missing, too long, or contains invalid characters.' });
  assert.throws(() => createKnowledgePrompt([{ ...validSource, title: ' ' }]), { message: 'Text is missing, too long, or contains invalid characters.' });
  assert.throws(() => createKnowledgePrompt([{ ...validSource, text: '\u0001' }]), { message: 'Text is missing, too long, or contains invalid characters.' });
  const sources = Array.from({length: 4}, (_, i) => ({...validSource, id: `${i + 3}`.repeat(8) + '-3333-4333-8333-333333333333', text: 'a'.repeat(15001)}));
  assert.throws(() => createKnowledgePrompt(sources), { message: 'Total text length of all sources exceeds 60,000 characters.' });
});

test('createKnowledgePrompt: valid inputs produce correct structure and serialize untrusted text', () => {
  const sourceWithJson = { ...validSource, text: 'Text with { "injection": true }' };
  const { system, user } = createKnowledgePrompt([sourceWithJson]);
  assert.ok(system.includes('one of: feature, benefit, use_case, proof, objection, hypothesis'));
  assert.ok(system.includes('verbatim substring'));

  const parsedUser = JSON.parse(user);
  assert.strictEqual(parsedUser.sources[0].id, sourceWithJson.id);
  assert.strictEqual(parsedUser.sources[0].text, 'Text with { "injection": true }');
  assert.doesNotThrow(() => createKnowledgePrompt([{ ...validSource, text: 'Text with \n and \t' }]));
});

test('createKnowledgePrompt: does not mutate input array', () => {
  const sources = [{ ...validSource }];
  const sourcesCopy = JSON.parse(JSON.stringify(sources));
  createKnowledgePrompt(sources);
  assert.deepStrictEqual(sources, sourcesCopy);
});

test('parseKnowledgeSuggestions: handles invalid response format', () => {
  assert.throws(() => parseKnowledgeSuggestions('not json', [validSource]), { message: 'Response is not valid JSON.' });
  assert.throws(() => parseKnowledgeSuggestions('null', [validSource]), { message: 'Response must be a JSON object.' });
  assert.throws(() => parseKnowledgeSuggestions('[]', [validSource]), { message: 'Response must be a JSON object.' });
  assert.throws(() => parseKnowledgeSuggestions('"hello"', [validSource]), { message: 'Response must be a JSON object.' });
  assert.throws(() => parseKnowledgeSuggestions('{}', [validSource]), { message: 'Ungültige Bewertungsfelder.' }); // from exactObject
  assert.throws(() => parseKnowledgeSuggestions('{"suggestions":"not an array"}', [validSource]), { message: '"suggestions" must be an array with at most 20 items.' });
  assert.throws(() => parseKnowledgeSuggestions('{"suggestions":[], "extra": 1}', [validSource]), { message: 'Ungültige Bewertungsfelder.' });
  assert.throws(() => parseKnowledgeSuggestions('{"suggestions":' + JSON.stringify(Array(21).fill({})) + '}', [validSource]), { message: '"suggestions" must be an array with at most 20 items.' });
  assert.throws(() => parseKnowledgeSuggestions('`{\"suggestions\":[]}`', [validSource]), { message: 'Response is not valid JSON.' });
  assert.throws(() => parseKnowledgeSuggestions('some text before {\"suggestions\":[]}', [validSource]), { message: 'Response is not valid JSON.' });
  assert.throws(() => parseKnowledgeSuggestions('a'.repeat(100001), [validSource]), { message: 'Response must be a string with at most 100,000 characters.' });
});

test('parseKnowledgeSuggestions: validates suggestions correctly', () => {
  const validResponse = {
    suggestions: [
      { category: 'feature', text: 'Has a Turbo Encabulator', sourceId: validSource.id, quote: 'Turbo Encabulator' },
      { category: 'hypothesis', text: 'Does it change the game?', sourceId: validSource2.id, quote: 'game changer' },
    ]
  };
  const result = parseKnowledgeSuggestions(JSON.stringify(validResponse), [validSource, validSource2]);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].category, 'feature');
  assert.strictEqual(result[1].category, 'hypothesis');

  assert.throws(() => parseKnowledgeSuggestions(JSON.stringify({ suggestions: [{...validResponse.suggestions[0], category: 'invalid'}]}), [validSource]), { message: 'Kategorie oder Quellenreferenz ungültig.' });
  assert.throws(() => parseKnowledgeSuggestions(JSON.stringify({ suggestions: [{...validResponse.suggestions[0], sourceId: '55555555-5555-5555-5555-555555555555'}]}), [validSource]), { message: 'Suggestion references an unknown sourceId.' });
  assert.throws(() => parseKnowledgeSuggestions(JSON.stringify({ suggestions: [{...validResponse.suggestions[0], quote: 'paraphrased quote'}]}), [validSource]), { message: 'Suggestion quote is not a verbatim substring of the source text.' });
  assert.throws(() => parseKnowledgeSuggestions(JSON.stringify({ suggestions: [{...validResponse.suggestions[0], extraField: 'test'}]}), [validSource]), { message: 'Ungültige Bewertungsfelder.' });
});

test('parseKnowledgeSuggestions: handles empty but valid suggestions array', () => {
  const result = parseKnowledgeSuggestions('{"suggestions":[]}', [validSource]);
  assert.deepStrictEqual(result, []);
});

test('parseKnowledgeSuggestions: rejects duplicate suggestions', () => {
  const suggestion = { category: 'feature', text: 'a', sourceId: validSource.id, quote: 'Turbo' };
  const response = { suggestions: [suggestion, suggestion] };
  assert.throws(() => parseKnowledgeSuggestions(JSON.stringify(response), [validSource]), { message: 'Duplicate suggestion found in response.' });
});

test('parseKnowledgeSuggestions: handles special characters in JSON', () => {
  const quoteWithChars = 'efficiency by 25%';
  const textWithChars = 'Unicode test: \u20ac for Euro';
  const response = JSON.stringify({ suggestions: [{
    category: 'benefit', text: textWithChars, sourceId: validSource.id, quote: quoteWithChars
  }]});
  const result = parseKnowledgeSuggestions(response, [validSource]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, textWithChars);
  assert.strictEqual(result[0].quote, quoteWithChars);
});

test('parseKnowledgeSuggestions: does not mutate input array', () => {
  const sources = [{ ...validSource }];
  const sourcesCopy = JSON.parse(JSON.stringify(sources));
  parseKnowledgeSuggestions('{"suggestions":[]}', sources);
  assert.deepStrictEqual(sources, sourcesCopy);
});
