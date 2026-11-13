import { inflateSync } from "node:zlib";

/** Reads PDFKit text through the embedded font's ToUnicode map, including Inter. */
const winAnsi = new TextDecoder("windows-1252");

export function pdfPageTexts(bytes: Buffer): string[] {
  const raw=bytes.toString("latin1");
  const objects=new Map([...raw.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)].map(m=>[Number(m[1]),m[2]]));
  const stream=(object:string):string=>{
    // PDF streams are binary. A compressed stream may legitimately end in 0x0A or
    // 0x0D, so delimiter-based capture silently drops its last byte and corrupts
    // the ToUnicode map. Honour the explicit byte length when it is available.
    const header=/\/Length\s+(\d+)[\s\S]*?stream\r?\n/.exec(object);
    const encoded=header
      ? Buffer.from(object.slice(header.index + header[0].length, header.index + header[0].length + Number(header[1])),"latin1")
      : (()=>{const m=/stream\r?\n([\s\S]*?)\r?\n?endstream/.exec(object);return m?Buffer.from(m[1],"latin1"):Buffer.alloc(0);})();
    if(!encoded.length)return "";
    try{return inflateSync(encoded).toString("latin1");}catch{return encoded.toString("latin1");}
  };
  const unicode=(hex:string):string=>{
    const b=Buffer.from(hex.replace(/\s/g,""),"hex");let s="";for(let i=0;i+1<b.length;i+=2)s+=String.fromCharCode(b.readUInt16BE(i));return s;
  };
  const fonts=new Map<string,Map<number,string>>();
  for(const ref of raw.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)){
    const font=objects.get(Number(ref[2]))??"",mapRef=/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font);if(!mapRef)continue;
    const cmap=stream(objects.get(Number(mapRef[1]))??""),mapping=new Map<number,string>();
    for(const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi))mapping.set(parseInt(m[1],16),unicode(m[2]));
    for(const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)){
      for(const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(?:<([\da-f]+)>|\[([\s\S]*?)\])/gi)){
        const first=parseInt(m[1],16),last=parseInt(m[2],16);
        const values=m[4]!==undefined?[...m[4].matchAll(/<([\da-f\s]*)>/gi)].map(v=>unicode(v[1])):null;
        for(let id=first;id<=last;id++){
          if(values){mapping.set(id,values[id-first]??"");}
          else if(m[3])mapping.set(id,String.fromCodePoint(parseInt(m[3],16)+id-first));
        }
      }
    }
    fonts.set(ref[1],mapping);
  }
  const pages:string[]=[];
  for(const object of objects.values()){
    const body=stream(object);if(!/\bBT\b/.test(body)||!/\/F\d+\s/.test(body))continue;
    let font="",text="";
    for(const token of body.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([\da-f\s]+)>|\(((?:\\.|[^\\)])*)\)/gi)){
      if(token[1]){font=token[1];continue;}
      if(token[2]){
        const hex=token[2].replace(/\s/g,""),map=fonts.get(font);
        if(map){for(let i=0;i+3<hex.length;i+=4)text+=map.get(parseInt(hex.slice(i,i+4),16))??"";}
        else text += winAnsi.decode(Buffer.from(hex, "hex"));
      }else text+=(token[3]??"").replace(/\\([()\\])/g,"$1");
    }
    pages.push(text);
  }
  return pages;
}
