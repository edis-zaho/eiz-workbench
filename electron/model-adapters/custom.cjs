exports.prepare=({binding:b,prompt,outputSchema,json})=>{
 if(outputSchema)throw Error('Striktes Schema ist am kompatiblen Endpunkt nicht bestätigt. JSON-Text mit Fachprüfung verwenden.');
 return {body:{model:b.model,messages:[{role:'system',content:prompt.system},{role:'user',content:prompt.user}],max_tokens:b.maxOutputTokens,stream:false,...(json?{response_format:{type:'json_object'}}:{})},headersWithoutSecret:{}};
};
exports.parse=d=>{const c=d.choices?.[0];return {status:c?.message?.refusal||c?.finish_reason==='content_filter'?'refused':c?.finish_reason==='stop'?'completed':'incomplete',text:typeof c?.message?.content==='string'?c.message.content:'',usage:d.usage,providerRequestId:d.id||null,finishReason:c?.finish_reason||null};};
