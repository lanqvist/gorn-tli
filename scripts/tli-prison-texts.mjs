// Decode localized client strings using their original binary index.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const root=path.resolve(process.argv[2]||'out/tartarus-client');
const entries=JSON.parse(fs.readFileSync(path.join(root,'extracted.json')));
const latest=new Map();for(const e of entries)latest.set(e.path,e);
const prefix='../../../UE_game/Content/Script/Data/';
class Reader {
  constructor(b,p=0){this.b=b;this.p=p;}
  u32(){const n=this.b.readUInt32LE(this.p);this.p+=4;return n;}
  u16(){const n=this.b.readUInt16LE(this.p);this.p+=2;return n;}
  str(){const n=this.u32();if(this.p+n>this.b.length)throw Error('String bounds');const s=this.b.subarray(this.p,this.p+n).toString('utf8');this.p+=n;return s;}
}
const clean=s=>s.replace(/<[^>]*>/g,'').replace(/\\n/g,'\n');
const dictionaries={},provenance={},validation=[];
for(const [lang,rel] of [['cn','ConfigView/config_multi_language'],['en','language/config_multi_language_en'],['ru','language/config_multi_language_ru']]){
  const entry=latest.get(prefix+rel+'.bin');const bin=fs.readFileSync(entry.output.replace(/\.blocks\.json$/,''));
  const idx=fs.readFileSync(latest.get(prefix+rel+'_idx.bin').output.replace(/\.blocks\.json$/,''));
  const r=new Reader(idx);const marker=r.u32(),count=r.u32();const values={};
  for(let i=0;i<count;i++){
    const key=r.str(),offset=r.u32(),length=r.u16(),v=new Reader(bin,offset),embeddedKey=v.str(),metadata=v.str(),raw=v.str();
    if(key!==embeddedKey||v.p!==offset+length)throw Error('Record mismatch: '+key);
    values[key]={raw,text:clean(raw),offset,length,metadata};
  }
  if(r.p!==idx.length)throw Error('Index trailing bytes');
  dictionaries[lang]=values;provenance[lang]={archive:entry.archive,internal_path:entry.path,records:count,marker};validation.push({language:lang,records:count,index_bytes:idx.length,all_offsets_keys_lengths_valid:true});
}
const keys=[...new Set(Object.values(dictionaries).flatMap(x=>Object.keys(x)))].filter(k=>/s16_gameplay|S16Gameplay|^hyperlink\|(name|des)\|160001\d\d$/i.test(k)).sort();
const records=keys.map(key=>({key,...Object.fromEntries(Object.entries(dictionaries).map(([lang,d])=>[lang,d[key]||null]))}));
const tables={};for(const rec of records){const m=/^s16_gameplay_([^|]+)\|([^|]+)\|(.+)$/.exec(rec.key);if(!m)continue;const [,table,field,id]=m;tables[table]??={};tables[table][id]??={id};tables[table][id][field]=Object.fromEntries(['cn','en','ru'].map(l=>[l,rec[l]?.text??null]));tables[table][id][field+'_raw']=Object.fromEntries(['cn','en','ru'].map(l=>[l,rec[l]?.raw??null]));}
fs.mkdirSync(path.join(root,'dump'),{recursive:true});
for(const [table,rows] of Object.entries(tables))fs.writeFileSync(path.join(root,'dump',table+'.json'),JSON.stringify(Object.values(rows),null,2)+'\n');
fs.writeFileSync(path.join(root,'dump/localization-records.json'),JSON.stringify({provenance,validation,records},null,2)+'\n');
const glossary={};for(const r of records){const m=/^hyperlink\|(name|des)\|(160001\d\d)$/.exec(r.key);if(m){glossary[m[2]]??={id:m[2]};glossary[m[2]][m[1]]=Object.fromEntries(['cn','en','ru'].map(l=>[l,r[l]?.text??null]));glossary[m[2]][m[1]+'_raw']=Object.fromEntries(['cn','en','ru'].map(l=>[l,r[l]?.raw??null]));}}
fs.writeFileSync(path.join(root,'dump/glossary.json'),JSON.stringify(Object.values(glossary),null,2)+'\n');
// Zstandard chunks in the small client configuration table: header = count,
// table identifier, then (relative compressed offset, uncompressed length) pairs.
const cfg=latest.get(prefix+'ConfigView/config_s16_gameplay_config_ChunkA0.bin');
const b=fs.readFileSync(cfg.output), chunks=b.readUInt32LE(0), header=8+chunks*8, config=[];
for(let i=0;i<chunks;i++){
  const offset=header+b.readUInt32LE(8+i*8),size=b.readUInt32LE(12+i*8);
  const end=i+1<chunks?header+b.readUInt32LE(16+i*8):b.length;
  const raw=zlib.zstdDecompressSync(b.subarray(offset,end));if(raw.length!==size)throw Error('Config chunk size');
  const r=new Reader(raw),count=r.u32();
  for(let j=0;j<count;j++){const key=r.u32(),id=r.u32(),type=r.str(),value=r.str(),description_key=r.str(),icon=r.str();if(key!==id)throw Error('Config key mismatch');config.push({id,type,value,description_key,description:Object.fromEntries(['cn','en','ru'].map(l=>[l,dictionaries[l][description_key]?.text??null])),icon});}
  if(r.p!==raw.length)throw Error('Config trailing bytes');
}
config.sort((a,b)=>a.id-b.id);fs.writeFileSync(path.join(root,'dump/client-config.json'),JSON.stringify({source:{archive:cfg.archive,path:cfg.path},rows:config},null,2)+'\n');
console.log(JSON.stringify({localization_records:records.length,tables:Object.fromEntries(Object.entries(tables).map(([t,v])=>[t,Object.keys(v).length])),config_rows:config.length,validation},null,2));
