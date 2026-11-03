import {crc32,deflateRawSync} from 'node:zlib';
import {fromBufferPromise,type Entry} from 'yauzl';
import {MD07_E_TEMPLATE} from './md07-e-template';
import type {SelfInspectionSnapshot} from './self-inspection-pdf';

const xmlText=(value:unknown)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/** Only packages our immutable template. User data is written as text, never as formulas. */
function zipEntries(entries:Array<{name:string;data:Buffer}>):Buffer {
  const content:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8'),data=deflateRawSync(entry.data),crc=crc32(entry.data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);
    local.copy(directory,8,6,28);directory.writeUInt32LE(offset,42);
    content.push(local,name,data);central.push(directory,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...content,directory,end]);
}

export async function renderSelfInspectionXlsx(snapshot:SelfInspectionSnapshot):Promise<Buffer> {
  const zip=await fromBufferPromise(Buffer.from(MD07_E_TEMPLATE,'base64'),{lazyEntries:true,autoClose:false});
  const entries:Array<{name:string;data:Buffer}>=[];
  try {
    await new Promise<void>((resolve,reject)=>{
      zip.once('error',reject);zip.once('end',resolve);
      zip.on('entry',(entry:Entry)=>{
        zip.openReadStream(entry,(error,stream)=>{
          if(error||!stream){reject(error??new Error('MD07_TEMPLATE_READ'));return;}
          const chunks:Buffer[]=[];stream.on('data',(part:Buffer)=>chunks.push(part));stream.once('error',reject);
          stream.once('end',()=>{entries.push({name:entry.fileName,data:Buffer.concat(chunks)});zip.readEntry();});
        });
      });zip.readEntry();
    });
  } finally {zip.close();}
  const sheet=entries.find(entry=>entry.name==='xl/worksheets/sheet1.xml');
  if(!sheet)throw new Error('MD07_TEMPLATE_SHEET');
  let xml=sheet.data.toString('utf8');
  const cells:Record<string,unknown>={A3:snapshot.of.numero,B3:snapshot.identity?.designation,C3:snapshot.identity?.reference,
    D3:snapshot.version.indice_externe_original??snapshot.version.indice,F3:snapshot.version.version_interne,
    H3:snapshot.variation,I3:snapshot.identity?.client_code,J3:snapshot.identity?.affairs.join(' / ')};
  for(const [address,value] of Object.entries(cells)){
    const regex=new RegExp(`<((?:[\\w]+:)?c)\\b([^>]*?\\br="${address}"[^>]*?)(?:\\s*/>|>[\\s\\S]*?</(?:[\\w]+:)?c>)`);
    if(!regex.test(xml))throw new Error('MD07_TEMPLATE_CELL_'+address);
    xml=xml.replace(regex,(_all,tag:string,attributes:string)=>{
      const prefix=tag.slice(0,-1),attrs=attributes.replace(/\s+t="[^"]*"/g,'').replace(/\/$/,'');
      return `<${tag}${attrs} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${xmlText(value)}</${prefix}t></${prefix}is></${tag}>`;
    });
  }
  sheet.data=Buffer.from(xml,'utf8');
  return zipEntries(entries);
}
