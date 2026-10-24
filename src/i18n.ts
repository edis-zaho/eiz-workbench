import de from './locales/de';
import en from './locales/en';
export type Locale='de'|'en';
export type MessageKey=keyof typeof de;
export const messages={de,en};
export function t(locale:Locale,key:MessageKey,values:Record<string,string|number>={}){
 return messages[locale][key].replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??`{${name}}`));
}
