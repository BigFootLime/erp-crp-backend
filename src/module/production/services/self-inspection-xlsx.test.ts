import {describe,it,expect} from 'vitest';
import {fromBufferPromise,type Entry} from 'yauzl';
import {renderSelfInspectionXlsx} from './self-inspection-xlsx';
import type {SelfInspectionSnapshot} from './self-inspection-pdf';

describe('MD07-E Excel preparation',()=>{
  it('writes the OF identity as text and retains the print layout and blank measurements',async()=>{
    const snapshot:SelfInspectionSnapshot={of:{id:1,numero:'OF-TEST-1',quantite_lancee:50},version:{indice:'A'},
      plan:{code:'MD07-E',version:1,label:'Fiche'},characteristics:[],source_hash:'a'.repeat(64),layout_version:'MD07-E'};
    snapshot.version={indice:'A',version_interne:5};snapshot.variation='Gauche';
    snapshot.identity={client_code:'001',reference:'=IMPORT("x")',designation:'Plaque <test> & support',affairs:['AFF-2026-0002']};
    const bytes=await renderSelfInspectionXlsx(snapshot);
    const zip=await fromBufferPromise(bytes,{lazyEntries:true,autoClose:false});const files=new Map<string,string>();
    try {await new Promise<void>((resolve,reject)=>{
      zip.on('error',reject);zip.on('end',resolve);zip.on('entry',(entry:Entry)=>zip.openReadStream(entry,(error,stream)=>{
        if(error||!stream){reject(error);return;}const parts:Buffer[]=[];
        stream.on('data',(part:Buffer)=>parts.push(part));stream.on('error',reject);stream.on('end',()=>{files.set(entry.fileName,Buffer.concat(parts).toString());zip.readEntry()});
      }));zip.readEntry();
    });} finally{zip.close();}
    const sheet=files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('Plaque &lt;test&gt; &amp; support');expect(sheet).toContain('=IMPORT("x")');
    expect(sheet).toContain('Gauche');expect(sheet).toContain(snapshot.of.numero);
    expect(sheet).toMatch(/r="F3"[^>]*t="inlineStr"[^>]*>.*?>5</);
    expect(sheet).toContain('paperSize="9"');expect(files.get('xl/workbook.xml')).toContain('Print_Area');
    expect(sheet).not.toMatch(/<(?:\w+:)?f[ >]/);
    expect(sheet).toContain('MD07-E');
    expect([...files.keys()].some(name=>name.startsWith('xl/media/'))).toBe(true);
  });
});
