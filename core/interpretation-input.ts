export const replyTypes = ['unclear','interest','rejection','out_of_office','automatic','wrong_person','other'] as const;
export type InterpretationContent = {
  replyType:typeof replyTypes[number]; technicalQuestion:'yes'|'no'|'unknown';
  materialRequest:'yes'|'no'|'unknown'; meetingIntent:'yes'|'no'|'unknown';
  requiresHumanReview:boolean; rationale:string; withdrawn:boolean;
};
export const emptyInterpretation = ():InterpretationContent => ({replyType:'unclear',technicalQuestion:'unknown',materialRequest:'unknown',meetingIntent:'unknown',requiresHumanReview:true,rationale:'',withdrawn:false});
export function exactObject(value:any,keys:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('Ungültige Bewertungsfelder.');
}
export function cleanText(value:unknown,max:number):string {
  if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||!value.trim())throw new Error('Text fehlt oder enthält ungültige Zeichen.');
  return value.trim();
}
export function interpretationContent(value:any):InterpretationContent {
  exactObject(value,['replyType','technicalQuestion','materialRequest','meetingIntent','requiresHumanReview','rationale','withdrawn']);
  if(!replyTypes.includes(value.replyType)||['technicalQuestion','materialRequest','meetingIntent'].some(k=>!['yes','no','unknown'].includes(value[k]))||typeof value.requiresHumanReview!=='boolean'||typeof value.withdrawn!=='boolean')throw new Error('Ungültige Bewertung.');
  return {replyType:value.replyType,technicalQuestion:value.technicalQuestion,materialRequest:value.materialRequest,meetingIntent:value.meetingIntent,requiresHumanReview:value.requiresHumanReview,rationale:cleanText(value.rationale,2000),withdrawn:value.withdrawn};
}
