// Responses JSON mode checks input messages, not the separate instructions field.
exports.prepare=({binding:b,prompt,outputSchema,json})=>({body:{model:b.model,instructions:prompt.system,input:json&&!outputSchema&&!/json/i.test(prompt.user)?prompt.user+'\n\nReturn the requested result as JSON.':prompt.user,store:false,max_output_tokens:b.maxOutputTokens,...(outputSchema?{text:{format:{type:'json_schema',name:'workbench_output',strict:true,schema:outputSchema}}}:json?{text:{format:{type:'json_object'}}}:{})},headersWithoutSecret:{}});
exports.parse=d=>{
 const content=(d.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]);
 return {status:content.some(x=>x.type==='refusal')?'refused':d.status==='completed'?'completed':'incomplete',text:content.filter(x=>x.type==='output_text').map(x=>x.text).join('\n'),usage:d.usage,providerRequestId:d.id||null,finishReason:d.incomplete_details?.reason||d.status||null};
};
