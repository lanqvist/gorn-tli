import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(process.argv[2]||'out/tartarus-client');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
const catalog=read('catalog.json'),files=read('extracted.json');
const sha=b=>crypto.createHash('sha1').update(b).digest('hex');
const records=[];
for(const x of files){
  const e=catalog.find(p=>p.archive===x.archive).files.find(e=>e.path===x.path);
  const fd=fs.openSync(x.archive,'r'),header=Buffer.alloc(54);
  try{if(fs.readSync(fd,header,0,54,e.offset)!==54)throw Error('Short header');}finally{fs.closeSync(fd);}
  const expected=header.subarray(29,49).toString('hex');
  const result=fs.readFileSync(x.output.replace(/\.blocks\.json$/,''));
  let hash;
  if(x.needs_decompression){const spec=JSON.parse(fs.readFileSync(x.output));hash=sha(Buffer.concat(spec.blocks.map(b=>Buffer.from(b.base64,'base64'))));}
  else hash=sha(result);
  if(hash!==expected||result.length!==e.size)throw Error('Payload validation failed: '+x.path);
  records.push({archive:x.archive,path:x.path,sha1:hash,hash_scope:x.needs_decompression?'compressed_blocks':'uncompressed_payload',decompressed_bytes:result.length,size_matches:true});
}
const report={archives:catalog.length,all_index_hashes_match:catalog.every(p=>p.index_hash_matches),files:records.length,uncompressed_files:records.filter(x=>x.hash_scope==='uncompressed_payload').length,compressed_files:records.filter(x=>x.hash_scope==='compressed_blocks').length,records};
if(!report.all_index_hashes_match)throw Error('Index validation failed');
fs.writeFileSync(path.join(root,'payload-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({archives:report.archives,files:report.files,all_checks_passed:true}));
