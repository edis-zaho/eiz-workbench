import type de from './de';
const en:Record<keyof typeof de,string>={
 start:'Start', product:'Product', contacts:'Contacts', messages:'Replies', results:'Results',
 models:'Models & costs', backups:'Backups', operations:'Operations',
 title:'Your product. Your contacts. Your decision.',
 intro:'Start with your own customer workspace. Review sources and audiences before approving messages.',
 create:'New customer', open:'Open customer workspace', select:'Select customer',
 local:'Data is stored locally. Only selected content is sent to Gmail or your model provider.',
 setup:'Setup', steps:'Product and sources → Personas and angles → Contacts → Messages → Results',
 count:'{count} customer workspaces', language:'Language',
 languageNote:'Navigation and onboarding are bilingual. Detailed workflow screens are currently in German.'
};
export default en;
