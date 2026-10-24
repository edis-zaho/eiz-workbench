const n=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const sum=(...values)=>values.some(v=>n(v)===null)?null:n(values.reduce((a,b)=>a+b,0));
function normalizeModelUsage(protocol,raw){
 const r=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 let inputTokens=null,outputTokens=null,cachedInputTokens=null,reasoningTokens=null;
 if(protocol==='openai-responses'){
  inputTokens=n(r.input_tokens);outputTokens=n(r.output_tokens);cachedInputTokens=n(r.input_tokens_details?.cached_tokens);reasoningTokens=n(r.output_tokens_details?.reasoning_tokens);
 }else if(protocol==='openai-chat-completions'){
  inputTokens=n(r.prompt_tokens);outputTokens=n(r.completion_tokens);cachedInputTokens=n(r.prompt_tokens_details?.cached_tokens);reasoningTokens=n(r.completion_tokens_details?.reasoning_tokens);
 }else if(protocol==='gemini-generate-content'){
  inputTokens=n(r.promptTokenCount);reasoningTokens=n(r.thoughtsTokenCount??0);outputTokens=sum(r.candidatesTokenCount,reasoningTokens);cachedInputTokens=n(r.cachedContentTokenCount??0);
 }else if(protocol==='anthropic-messages'){
  inputTokens=sum(r.input_tokens,r.cache_read_input_tokens??0,r.cache_creation_input_tokens??0);outputTokens=n(r.output_tokens);cachedInputTokens=n(r.cache_read_input_tokens??0);reasoningTokens=null;
 }else throw Error('Unbekanntes Usage-Protokoll.');
 return {inputTokens,outputTokens,cachedInputTokens,reasoningTokens,raw:structuredClone(r)};
}
module.exports={normalizeModelUsage};
