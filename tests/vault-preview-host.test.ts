import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultLinks, type VaultDestination } from '../src/vault-links';

async function fixture(t:import('node:test').TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'traceweave-preview-links-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const indexed=new Map<string,VaultDestination>(),opened:{path:string;subpath:string}[]=[],shown:string[]=[],lookups:{link:string;source:string}[]=[],urls:string[]=[];
 async function add(relative:string,bytes:string|Buffer){await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),bytes);indexed.set(relative,{path:relative,basename:path.posix.basename(relative,path.posix.extname(relative)),extension:path.posix.extname(relative).slice(1)});}
 const host={find(link:string,source:string){lookups.push({link,source});const candidate=path.posix.normalize(path.posix.join(path.posix.dirname(source),link));return indexed.get(candidate)??indexed.get(link)??[...indexed.values()].find(file=>file.basename===link)??null;},resourceUrl(relative:string){urls.push(relative);return 'app://local/'+encodeURIComponent(relative);},async open(relative:string,subpath:string){opened.push({path:relative,subpath});},async reveal(relative:string){shown.push(relative);}};
 await add('Projects/Notes/A.md','# A');await add('Elsewhere/B.md','# B');await add('Projects/Assets/picture.png',Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
 return {root,indexed,host,add,opened,shown,lookups,urls,links:new VaultLinks(root,host)};
}

test('indexed ordinary-note links resolve source-relative attachment and heading-aware native note navigation',async t=>{
 const f=await fixture(t),source='Projects/Notes/A.md';const image=await f.links.resolve(source,'../Assets/picture.png');assert.ok(image);assert.equal(image.path,'Projects/Assets/picture.png');assert.equal(image.mediaKind,'image');assert.equal(image.mimeType,'image/png');assert.equal(f.lookups.at(-1)?.source,source);assert.ok(image.resourceUrl.startsWith('app://local/'));
 const note=await f.links.resolve(source,'B#Heading');assert.equal(note?.path,'Elsewhere/B.md');assert.equal(note?.isNote,true);await f.links.open(source,'B#Heading');assert.deepEqual(f.opened,[{path:'Elsewhere/B.md',subpath:'#Heading'}]);assert.deepEqual(f.shown,[]);
});

test('host rejects traversal, external URL/protocol, technical metadata and symlink destinations before rendering',async t=>{
 const f=await fixture(t),source='Projects/Notes/A.md';await f.add('TWData/projects/p/secret.md','technical');
 for(const value of ['../../../../outside.md','https://tracker.invalid/pixel.png','//tracker.invalid/pixel.png','%68ttps%3A%2F%2Ftracker.invalid/x','file:///private/secret','javascript:alert(1)','../Assets/../../../../outside.md','/TWData/projects/p/secret.md','/.obsidian/config.json'])assert.equal(await f.links.resolve(source,value),null,value);
 assert.deepEqual(f.urls,[]);assert.equal(await f.links.resolve('TWData/projects/p/secret.md','B'),null);
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'traceweave-linked-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'secret.png'),'outside');await fs.symlink(path.join(outside,'secret.png'),path.join(f.root,'Projects/Assets/symlink.png'));f.indexed.set('Projects/Assets/symlink.png',{path:'Projects/Assets/symlink.png',basename:'symlink',extension:'png'});await assert.rejects(f.links.resolve(source,'../Assets/symlink.png'));assert.deepEqual(f.urls,[]);
});

test('PDF uses explicit native viewer while opaque and executable files are only revealed',async t=>{
 const f=await fixture(t),source='Projects/Notes/A.md';await f.add('Projects/Assets/document.pdf','%PDF-1.4\n');await f.add('Projects/Assets/run.sh','#!/bin/sh\nexit 0\n');await f.add('Projects/Assets/vector.svg','<svg onload="alert(1)"/>');await f.add('Projects/Assets/fake.png','<script>not a raster</script>');
 assert.equal((await f.links.resolve(source,'../Assets/fake.png'))?.mediaKind,'file');assert.equal((await f.links.resolve(source,'../Assets/vector.svg'))?.mediaKind,'file');await f.links.open(source,'../Assets/document.pdf');await f.links.open(source,'../Assets/run.sh');await f.links.open(source,'../Assets/vector.svg');assert.deepEqual(f.opened,[{path:'Projects/Assets/document.pdf',subpath:''}]);assert.deepEqual(f.shown,['Projects/Assets/run.sh','Projects/Assets/vector.svg']);
});
