exports.prepare=({binding:b,prompt,outputSchema,json})=>({body:{systemInstruction:{parts:[{text:prompt.system}]},contents:[{role:'user',parts:[{text:prompt.user}]}],generationConfig:{maxOutputTokens:b.maxOutputTokens,...(json||outputSchema?{responseMimeType:'application/json'}:{}),...(outputSchema?{responseJsonSchema:outputSchema}:{})}},headersWithoutSecret:{}});
exports.parse=d=>{
 const c=d.candidates?.[0],finish=c?.finishReason||d.promptFeedback?.blockReason||null;
 return {status:['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','RECITATION'].includes(finish)||d.promptFeedback?.blockReason?'refused':finish==='STOP'?'completed':'incomplete',text:(c?.content?.parts||[]).filter(x=>!x.thought&&typeof x.text==='string').map(x=>x.text).join('\n'),usage:d.usageMetadata,providerRequestId:d.responseId||null,finishReason:finish};
};
