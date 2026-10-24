import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeModelUsage,priceModelUsage} from '../core/model-usage';
test('reasoning already included in OpenAI output is not added twice; Gemini thoughts are separate',()=>{
 const p:any={currency:'USD',protocol:'openai-responses',inputMicrosPerMillion:1000000,outputMicrosPerMillion:2000000,cachedInputMicrosPerMillion:500000,reasoningMicrosPerMillion:null};
 const u=normalizeModelUsage('openai-responses',{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:30}});
 assert.equal(priceModelUsage(u,p)?.micros,190);
 const g=normalizeModelUsage('gemini-generate-content',{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30});
 assert.equal(g.outputTokens,50);
 const a=normalizeModelUsage('anthropic-messages',{input_tokens:10,cache_read_input_tokens:20,output_tokens:5});
 assert.equal(a.inputTokens,30);
 assert.equal(priceModelUsage(normalizeModelUsage('openai-responses',{}),p),null);
 assert.equal(priceModelUsage({...u,inputTokens:-1},p),null);
});
