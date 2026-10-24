// Standard direct-API prices verified against these official model pages.
// Templates are explicit user choices, never an automatic provider fallback.
export const modelTemplates=[
 {id:'openai-mini',name:'OpenAI · GPT-4.1 mini',provider:'openai',model:'gpt-4.1-mini-2025-04-14',
  input:0.4,output:1.6,cached:0.1,reasoning:null,inputBound:1047576,
  source:'https://developers.openai.com/api/docs/models/gpt-4.1-mini',checkedAt:'2026-10-20T00:00:00.000Z'},
 {id:'anthropic-haiku',name:'Anthropic · Claude Haiku 4.5',provider:'anthropic',model:'claude-haiku-4-5-20251001',
  input:1,output:5,cached:0.1,reasoning:5,inputBound:200000,
  source:'https://platform.claude.com/docs/en/models/haiku-4-5/overview',checkedAt:'2026-10-20T00:00:00.000Z'}
] as const;
