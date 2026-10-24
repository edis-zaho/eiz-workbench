import {t,type Locale} from './i18n';
export function Start({locale,count,create,open,disabled}:{locale:Locale;count:number;create:()=>void;open:()=>void;disabled:boolean}){
 return <section className="card setting public-start"><h1>{t(locale,'title')}</h1><p>{t(locale,'intro')}</p>
 <p>{t(locale,'steps')}</p><p>{t(locale,'count',{count})}</p>
 <div className="button-row"><button className="primary" disabled={disabled} onClick={create}>{t(locale,'create')}</button>
 {count>0&&<button className="secondary" onClick={open}>{t(locale,'open')}</button>}</div>
 <p>{t(locale,'local')}</p><small>{t(locale,'languageNote')}</small></section>;
}
