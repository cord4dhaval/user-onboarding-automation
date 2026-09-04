"use strict";exports.id=9096,exports.ids=[9096],exports.modules={13622:(a,b,c)=>{function d(a,b){var c,d;let i={...b.color,accentText:h(b.color.accent,b.color.accentText)},j={...{bg:"#0E0F12",surface:"#16181D",text:"#EDEEF1",muted:"#9AA1AC",border:"#282C33",accent:k((c=i).accent,.22),accentText:h(k(c.accent,.22),c.accentText),gradient:c.gradient},...b.darkColor??{}},l=b.font,p=b.shape,[q,r,s,t,u]=l.scale,v=a.blocks.find(a=>"preheader"===a.kind),w=[],x=!1;for(let c of a.blocks)switch(c.kind){case"preheader":break;case"heading":{let a=1===c.level?q:2===c.level?r:s;w.push(e(`
          <h${c.level} class="dm-ink" style="margin:0;font-family:${n(l.headingStack)};font-size:${a}px;line-height:${l.headingLeading};font-weight:${l.headingWeight};letter-spacing:-0.02em;color:${i.text};">${o(c.text)}</h${c.level}>
        `,p.space));break}case"text":w.push(e(function(a,b,c,d){return a.split(/\n{2,}/).map(a=>a.trim()).filter(Boolean).map((a,e)=>`<p class="dm-ink" style="margin:${14*(0!==e)}px 0 0;font-family:${n(c.bodyStack)};font-size:${d}px;line-height:${c.bodyLeading};color:${b.text};">${o(a)}</p>`).join("")}(c.text,i,l,t),p.space));break;case"list":w.push(e(function(a,b,c,d){let e=a.items.map(e=>{let f="check"===a.style?`<span style="color:${b.accent};font-weight:700;">&#10003;</span>`:"strike"===a.style?`<span class="dm-muted" style="color:${b.muted};">&#8211;</span>`:`<span style="color:${b.accent};">&#8226;</span>`,g="strike"===a.style?`<span class="dm-muted" style="color:${b.muted};text-decoration:line-through;">${o(e)}</span>`:o(e);return`<tr>
        <td width="22" valign="top" style="padding:0 0 10px;font-family:${n(c.bodyStack)};font-size:${d}px;line-height:${c.bodyLeading};">${f}</td>
        <td valign="top" class="dm-ink" style="padding:0 0 10px;font-family:${n(c.bodyStack)};font-size:${d}px;line-height:${c.bodyLeading};color:${b.text};">${g}</td>
      </tr>`}).join("");return`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${e}</table>`}(c,i,l,t),p.space));break;case"card":w.push(e(function(a,b,c,d,e,f){let h=a.title?`<tr><td colspan="2" class="dm-ink" style="padding:0 0 14px;font-family:${n(c.headingStack)};font-size:${d+2}px;font-weight:${c.headingWeight};letter-spacing:-0.01em;color:${b.text};">${o(a.title)}</td></tr>`:"",i=a.rows.map(a=>`<tr>
        <td class="dm-muted" style="padding:0 0 4px;font-family:${n(c.bodyStack)};font-size:${e}px;line-height:1.4;color:${b.muted};">${o(a.label)}</td>
      </tr>
      <tr>
        <td class="dm-ink" style="padding:0 0 14px;font-family:${n(c.bodyStack)};font-size:${d}px;line-height:1.45;color:${b.text};font-weight:600;">${o(a.value)}</td>
      </tr>`).join(""),j=a.accent?`border:1px solid ${b.accent};`:`border:1px solid ${b.border};`;return`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="dm-soft dm-rule" style="background:${a.accent?g(b.accent):"transparent"};${j}border-radius:${f.radius}px;padding:20px 20px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${h}${i}</table>
    </td>
  </tr></table>`}(c,i,l,t,u,p),p.space));break;case"callout":w.push(e(`
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="dm-soft" style="background:${g(i.accent)};border-radius:${p.radius}px;padding:16px 18px;font-family:${n(l.bodyStack)};font-size:${t-1}px;line-height:${l.bodyLeading};color:${i.text};">${o(c.text)}</td>
          </tr></table>
        `,p.space));break;case"divider":w.push(e(`
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="dm-rule" style="border-top:1px solid ${i.border};font-size:0;line-height:0;">&nbsp;</td>
          </tr></table>
        `,p.space));break;case"image":{let a=Math.min(c.width??600-2*p.pad,600-2*p.pad),b=`<img src="${n(c.url)}" alt="${n(c.alt)}" width="${a}" style="display:block;width:100%;max-width:${a}px;height:auto;border:0;border-radius:${p.radius}px;" />`;w.push(e(c.href?`<a href="${n(c.href)}" style="text-decoration:none;">${b}</a>`:b,p.space));break}case"cta":x?w.push(e(`
            <p style="margin:0;font-family:${n(l.bodyStack)};font-size:${t}px;line-height:${l.bodyLeading};color:${i.text};"><a href="${n(c.url)}" style="color:${i.accent};font-weight:600;">${o(c.text)}</a></p>
          `,p.space)):(w.push(e(function(a,b,c,d,e){let g=m(a.text),h=n(a.url),i=d.buttonRadius;return`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="${Math.min(50,Math.round(i/48*100))}%" stroke="f" fillcolor="${b.accent}">
  <w:anchorlock/>
  <center style="color:${b.accentText};font-family:Arial,sans-serif;font-size:${e}px;font-weight:bold;">${g}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${h}" class="cta" style="display:inline-block;background:${b.accent};${f(b)}color:${b.accentText};font-family:${n(c.bodyStack)};font-size:${e}px;font-weight:600;line-height:1;text-decoration:none;padding:16px 30px;border-radius:${i}px;mso-hide:all;">${g}&nbsp;&#8594;</a>
<!--<![endif]-->
</td></tr></table>`}(c,i,l,p,t),p.space+6)),x=!0);break;case"optout":w.push(function(a,b,c,d){let e=b.footer,f=b.font,g=e.social.length?`<p style="margin:0 0 10px;font-family:${n(f.bodyStack)};font-size:${d}px;">${e.social.map(a=>`<a href="${n(a.url)}" style="color:${c.muted};text-decoration:underline;margin-right:14px;">${m(a.label)}</a>`).join("")}</p>`:"",h=[e.legalName,e.address,e.disclaimer].filter(Boolean).map(a=>`<p class="dm-muted" style="margin:0 0 4px;font-family:${n(f.bodyStack)};font-size:${d}px;line-height:1.5;color:${c.muted};">${m(a)}</p>`).join("");return`<tr><td style="padding:14px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="dm-rule" style="border-top:1px solid ${c.border};padding:18px 0 0;">
        ${g}${h}
        <p class="dm-muted" style="margin:8px 0 0;font-family:${n(f.bodyStack)};font-size:${d}px;line-height:1.5;color:${c.muted};">
          Not useful? <a href="${n(a)}" style="color:${c.muted};text-decoration:underline;">Unsubscribe</a>.
        </p>
      </td>
    </tr></table>
  </td></tr>`}(c.url,b,i,u))}let y=b.logo?e(function(a){let b=a.logo,c=`<img src="${n(b.light)}" alt="${n(b.alt||a.footer.legalName)}" width="${b.width}" style="display:block;width:${b.width}px;max-width:${b.width}px;height:auto;border:0;" />`;return b.href?`<a href="${n(b.href)}" style="text-decoration:none;">${c}</a>`:c}(b),p.space+6):b.footer.legalName?e(`<p class="dm-ink" style="margin:0;font-family:${n(l.headingStack)};font-size:${s}px;font-weight:${l.headingWeight};letter-spacing:-0.01em;color:${i.text};">${m(b.footer.legalName)}</p>`,p.space+6):"",z=p.topRule?`<tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:${i.accent};${f(i)}">&nbsp;</td></tr>`:"";return`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${m(a.subject??"")}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  a:not(.cta){color:${i.accent};}
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;}
    .pad{padding-left:22px !important;padding-right:22px !important;}
    .h1{font-size:${Math.round(.8*q)}px !important;}
  }
  @media (prefers-color-scheme:dark){
    .dm-ground{background:${j.bg} !important;}
    .dm-card{background:${j.surface} !important;}
    .dm-ink{color:${j.text} !important;}
    .dm-muted{color:${j.muted} !important;}
    .dm-rule{border-color:${j.border} !important;}
    .dm-soft{background:${g(j.accent,!0)} !important;color:${j.text} !important;}
    /* The button is an anchor too. Without this exclusion the link colour repaints its
       label in the accent, on the accent, and the words disappear. */
    a:not(.cta){color:${j.accent} !important;}
    .cta{background:${j.accent} !important;color:${j.accentText} !important;}
  }
</style>
</head>
<body class="dm-ground" style="margin:0;padding:0;background:${i.bg};">
${(d=v)&&"preheader"===d.kind?`<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;height:0;width:0;">${m(d.text)}${"&#8199;&#65279;&#847; ".repeat(30)}</div>`:""}
<table role="presentation" class="dm-ground" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${i.bg};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="wrap dm-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${i.surface};border-radius:${p.radius+4}px;overflow:hidden;box-shadow:0 1px 2px rgba(16,17,20,.04),0 18px 44px -32px rgba(16,17,20,.35);">
      ${z}
      <tr><td class="pad" style="padding:${p.pad}px ${p.pad}px ${p.pad-8}px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${y}
          ${w.join("\n")}
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`}function e(a,b){return`<tr><td style="padding:0 0 ${b}px;">${a.trim()}</td></tr>`}function f(a){return a.gradient.length<2?"":`background-image:linear-gradient(90deg,${a.gradient.join(",")});`}function g(a,b=!1){let[c,d,e]=l(a),f=b?22:255,h=b?.16:.08,i=a=>Math.round(a*h+f*(1-h));return`#${[i(c),i(d),i(e)].map(a=>a.toString(16).padStart(2,"0")).join("")}`}function h(a,b){return i(a,b)>=4.5?b:i(a,"#ffffff")>=i(a,"#101114")?"#ffffff":"#101114"}function i(a,b){let[c,d]=[j(a),j(b)].sort((a,b)=>b-a);return(c+.05)/(d+.05)}function j(a){let b=a=>{let b=a/255;return b<=.03928?b/12.92:((b+.055)/1.055)**2.4},[c,d,e]=l(a);return .2126*b(c)+.7152*b(d)+.0722*b(e)}function k(a,b){let[c,d,e]=l(a),f=a=>Math.round(a+(255-a)*b);return`#${[f(c),f(d),f(e)].map(a=>a.toString(16).padStart(2,"0")).join("")}`}function l(a){let b=a.replace("#","").slice(0,6).padEnd(6,"0");return[0,2,4].map(a=>parseInt(b.slice(a,a+2),16)||0)}function m(a){return a.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function n(a){return m(String(a))}function o(a){let b=m(a);return(b=(b=(b=b.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(a,b,c)=>`<a href="${c.replace(/"/g,"&quot;")}" style="text-decoration:underline;">${b}</a>`)).replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")).replace(/(^|[\s(])_([^_]+)_/g,"$1<em>$2</em>")).replace(/\n/g,"<br />")}c.d(b,{renderHtml:()=>d})},60675:(a,b,c)=>{function d(a){return/^\s*(hi|hey|hello|dear)\b[^.!?]{0,40}[,:—-]?\s*$/i.test(a.split("\n")[0]??"")}function e(a,b){return a.replace(/\{\{(\w+)\}\}/g,(a,c)=>b[c]??a)}function f(a,b,c){let f=c?.subject,g=[],h=!1,i=!1;for(let j of a){let a=String(j.type),k=a=>"string"==typeof a?e(a,b):void 0;if("subject"===a){f??=k(j.fallback);continue}if("preheader"===a){let a=c?.preheader??k(j.fallback);a&&g.push({kind:"preheader",text:e(a,b)});continue}if("text"===a){let a=k(j.fixed);a&&(d(a)&&(i=!0),g.push({kind:"text",text:a}));continue}if("slot"===a){let a="string"==typeof j.name?j.name:void 0,f=a?c?.slots?.[a]:void 0;if(!f&&!a&&!h){let a=c?.slotText??(c?.bodyMd&&!c.fromBlocks?c.bodyMd:void 0);a&&(f=i?function(a){let b=a.split("\n"),c=b[0]??"";return d(c)||/^\s*[A-Z][a-z]+,\s*$/.test(c)?b.slice(1).join("\n").replace(/^\s+/,""):a}(a):a,h=!0)}(f??=k(j.fallback))&&g.push({kind:"text",text:e(f,b)});continue}if("heading"===a){let a="string"==typeof j.slot?j.slot:void 0,d=k(j.fixed)??(a?c?.slots?.[a]:void 0)??k(j.fallback);d&&g.push({kind:"heading",level:Number(j.level??1),text:e(d,b)});continue}if("list"===a&&Array.isArray(j.items)){let a=j.items.map(a=>e(String(a),b)).filter(Boolean);if(a.length){let b=String(j.style??"bullet");g.push({kind:"list",style:b,items:a})}continue}if("card"===a&&Array.isArray(j.rows)){let a=j.rows.map(a=>({label:e(String(a.label??""),b),value:e(String(a.value??""),b)}));a.length&&g.push({kind:"card",title:k(j.title),rows:a,accent:!!j.accent});continue}if("callout"===a){let a=k(j.fixed);a&&g.push({kind:"callout",text:a});continue}if("divider"===a){g.push({kind:"divider"});continue}if("image"===a&&"string"==typeof j.url){g.push({kind:"image",url:e(j.url,b),alt:"string"==typeof j.alt?e(j.alt,b):"",width:"number"==typeof j.width?j.width:void 0,href:"string"==typeof j.href?e(j.href,b):void 0});continue}if("cta"===a&&"string"==typeof j.fixed&&"string"==typeof j.url){g.push({kind:"cta",text:e(j.fixed,b),url:e(j.url,b)});continue}if("system"===a&&"opt_out_block"===j.fixed){g.push({kind:"optout",url:b.opt_out_url});continue}}return{subject:function(a,b){let c=b.first_name;if(!a||!c||"there"!==c)return a;let d=a.replace(RegExp(`^${c}\\s*[,:—-]\\s*`,"i"),"");return d===a?a:d.charAt(0).toUpperCase()+d.slice(1)}(f,b),blocks:g}}function g(a,b,c){let d,e,g,h=f(a,b,c),i=[];for(let a of h.blocks)switch(a.kind){case"preheader":g??=a.text;break;case"heading":case"text":case"callout":i.push(a.text);break;case"list":i.push(a.items.map(a=>`• ${a}`).join("\n"));break;case"card":i.push([a.title,...a.rows.map(a=>`${a.label}: ${a.value}`)].filter(Boolean).join("\n"));break;case"divider":break;case"image":a.alt&&i.push(a.alt);break;case"cta":d=a.text,e=a.url,i.push(`${a.text}: ${a.url}`);break;case"optout":i.push(`
—
Not useful? Unsubscribe: ${a.url}`)}let j=[];for(let a of["first_name","company"])b[a]&&"there"!==b[a]&&j.push(a);let k=i.join("\n\n").trim();return{subject:h.subject,bodyMd:k,preheader:g,ctaText:d,ctaUrl:e,personalizationUsed:j,claimsMade:c?.claimsMade??[],wordCount:k.split(/\s+/).filter(Boolean).length,fromBlocks:!(c?.slotText||c?.bodyMd)||c.fromBlocks,slotText:c?.slotText}}function h(a,b,c,d){return{to:b,from:c,subject:a.subject,bodyText:a.bodyMd,bodyHtml:d??a.bodyHtml}}c.d(b,{I:()=>h,renderTemplate:()=>g,resolveBlocks:()=>f})}};