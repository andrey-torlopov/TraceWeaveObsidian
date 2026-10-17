import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { VaultMarkdown, isVaultDestination, MAX_INLINE_IMAGE_BYTES, notePreviewBody } from '../src/ui/vaultMarkdown';
import remarkWikiLinks from '../src/ui/remarkWikiLinks';
import type { VaultLink } from '../src/types';

interface Tree { type: string; url?: string; value?: string; alt?: string; children?: Tree[] }
const parsed=(source:string)=>{const processor=unified().use(remarkParse).use(remarkWikiLinks);return processor.runSync(processor.parse(source),{value:source}) as Tree;};
function nodes(tree:Tree,type:string):Tree[]{return [...(tree.type===type?[tree]:[]),...(tree.children??[]).flatMap(child=>nodes(child,type))];}
const descriptor=(path:string,kind:VaultLink['mediaKind']='image',mime='image/png'):VaultLink=>({path,title:path.split('/').at(-1)!,resourceUrl:`app://local/${encodeURIComponent(path)}`,mimeType:mime,mediaKind:kind,byteSize:128,isNote:kind==='text'});

async function mounted(t:import('node:test').TestContext){
  const window=new Window({url:'http://tw-markdown.test'}),document=window.document;
  const globals:Record<string,unknown>={window,document,navigator:window.navigator,HTMLElement:window.HTMLElement,Element:window.Element,Event:window.Event,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {createRoot}=await import('react-dom/client'),container=document.createElement('div');document.body.append(container);const root=createRoot(container as unknown as HTMLDivElement);
  t.after(async()=>{await act(async()=>root.unmount());await window.happyDOM.abort();for(const [key,entry]of previous)if(entry)Object.defineProperty(globalThis,key,entry);else Reflect.deleteProperty(globalThis,key);});
  const calls:{source:string;link:string}[]=[],opened:{source:string;link:string}[]=[],targets=new Map<string,VaultLink>();
  const service={async resolveVaultLink(source:string,link:string){calls.push({source,link});return targets.get(link)??null;},async openVaultLink(source:string,link:string){opened.push({source,link});}};
  const render=async(text:string,sourcePath='Research/Notes/First.md')=>{await act(async()=>{root.render(React.createElement(VaultMarkdown,{text,sourcePath,service}));});};
  return {window,document,container,root,calls,opened,targets,service,render};
}

test('wikilinks and embedded aliases become link/image nodes, preserving code fences, inline code and raw HTML',()=>{
 const tree=parsed('[[Папка/Заметка#Раздел|Подпись]] ![[../Assets/image.png|Карта]]\n\n`[[literal]]`\n\n```md\n![[code.png]]\n```\n\n<div>[[raw HTML]]</div>\n\n<span>[[inline raw HTML]]</span>\n\n\\[[escaped]]');
 assert.deepEqual(nodes(tree,'link').map(n=>[n.url,n.children?.[0]?.value]),[['Папка/Заметка#Раздел','Подпись']]);assert.deepEqual(nodes(tree,'image').map(n=>[n.url,n.alt]),[['../Assets/image.png','Карта']]);assert.equal(nodes(tree,'inlineCode')[0]!.value,'[[literal]]');assert.equal(nodes(tree,'code')[0]!.value,'![[code.png]]');assert.ok(nodes(tree,'html')[0]!.value?.includes('[[raw HTML]]'));
});

test('ordinary-note preview hides only closed leading Properties with BOM/CRLF and preserves unclosed or later blocks',async t=>{
 const ui=await mounted(t),body='# Visible title\r\n\r\nBody with `---` and [[Second|Link]].\r\n',source='\uFEFF---\r\ntags: [synthetic]\r\ncustom: preserved\r\n---\r\n'+body;
 ui.targets.set('Second',descriptor('Other/Second.md','text','text/markdown'));
 assert.equal(notePreviewBody(source),body);assert.ok(source.includes('custom: preserved'));
 await ui.render(source);assert.equal(ui.container.querySelector('h1')?.textContent,'Visible title');assert.ok(!ui.container.textContent?.includes('synthetic'));assert.ok(!ui.container.textContent?.includes('custom: preserved'));assert.ok(ui.calls.some(call=>call.source==='Research/Notes/First.md'&&call.link==='Second'));
 assert.equal(notePreviewBody('---\nkey: value\n---'),'');assert.equal(notePreviewBody('--- \nkey: value\n...\nBody'),'Body');
 for(const unchanged of ['---\ntags: [unclosed]\nBody','---','  ---\nkey: value\n---\nBody','Intro\n\n---\nkey: value\n---\nBody','\uFEFF# Body\r\n'])assert.equal(notePreviewBody(unchanged),unchanged);
 await ui.render('---\ntags: [unclosed]\nBody');assert.ok(ui.container.textContent?.includes('unclosed'));assert.ok(ui.container.textContent?.includes('Body'));
});

test('relative Markdown and wikilink embeds resolve against the original ordinary note sourcePath and local note click opens native',async t=>{
 const ui=await mounted(t);ui.targets.set('../Assets/image.png',descriptor('Research/Assets/image.png'));ui.targets.set('Second#Section',descriptor('Other/Second.md','text','text/markdown'));
 await ui.render('![Карта](../Assets/image.png)\n\n![[../Assets/image.png|Тот же файл]]\n\n[[Second#Section|Обычная заметка]]');
 assert.equal(ui.container.querySelectorAll('img').length,2);assert.ok(ui.calls.every(call=>call.source==='Research/Notes/First.md'));assert.ok(ui.calls.some(call=>call.link==='../Assets/image.png'));assert.equal(ui.container.querySelector('img')?.getAttribute('alt'),'Карта');
 const link=[...ui.container.querySelectorAll('button')].find(button=>button.textContent==='Обычная заметка');assert.ok(link);await act(async()=>link.click());assert.deepEqual(ui.opened,[{source:'Research/Notes/First.md',link:'Second#Section'}]);
});

test('external images, raw HTML, unsafe schemes and network file URLs create no resource requests',async t=>{
 const ui=await mounted(t);ui.targets.set('unsafe.png',{...descriptor('unsafe.png'),resourceUrl:'file://remote-host/private.png'});
 await ui.render('![Pixel](https://tracker.invalid/pixel.png)\n\n![[https://tracker.invalid/wiki.png]]\n\n![Script](javascript:alert%281%29)\n\n<img src="https://tracker.invalid/raw.png" onerror="alert(1)">\n\n![[unsafe.png]]\n\n[Explicit](https://example.org/source)');
 assert.equal(ui.container.querySelectorAll('img,iframe,script,video,audio,link[rel="preload"]').length,0);assert.deepEqual(ui.calls.map(c=>c.link),['unsafe.png']);assert.equal([...ui.container.querySelectorAll('a')].find(a=>a.textContent==='Explicit')?.getAttribute('href'),'https://example.org/source');assert.equal(ui.container.querySelector('a')?.getAttribute('rel'),'noopener noreferrer');assert.ok(ui.container.textContent?.includes('внешняя загрузка отключена'));assert.ok(ui.container.textContent?.includes('Недопустимый адрес'));
});

test('large raster, SVG, PDF and arbitrary binary remain accessible through explicit native open or reveal',async t=>{
 const ui=await mounted(t);ui.targets.set('large.png',{...descriptor('large.png'),byteSize:MAX_INLINE_IMAGE_BYTES});ui.targets.set('vector.svg',descriptor('vector.svg','file','application/octet-stream'));ui.targets.set('report.pdf',descriptor('report.pdf','file','application/pdf'));ui.targets.set('opaque.bin',descriptor('opaque.bin','file','application/octet-stream'));
 await ui.render('![[large.png]]\n\n![[vector.svg]]\n\n![[report.pdf]]\n\n![[opaque.bin]]');assert.equal(ui.container.querySelectorAll('img,object,iframe').length,0);const buttons=[...ui.container.querySelectorAll('button')];assert.equal(buttons.length,4);assert.ok(buttons.some(b=>b.textContent?.startsWith('Открыть PDF')));await act(async()=>buttons.at(-1)!.click());assert.deepEqual(ui.opened,[{source:'Research/Notes/First.md',link:'opaque.bin'}]);
});

test('audio/video never autoplay, defer loading and stop when attachment or view changes',async t=>{
 const ui=await mounted(t);ui.targets.set('interview.mp3',descriptor('interview.mp3','audio','audio/mpeg'));ui.targets.set('film.mp4',descriptor('film.mp4','video','video/mp4'));
 await ui.render('![[interview.mp3]]');const audio=ui.container.querySelector('audio');assert.ok(audio);assert.equal(audio.getAttribute('autoplay'),null);assert.equal(audio.getAttribute('preload'),'none');let paused=0,loaded=0;audio.pause=()=>{paused++;};audio.load=()=>{loaded++;};
 await ui.render('![[interview.mp3]]');assert.equal(paused,0);assert.equal(ui.container.querySelector('audio'),audio);
 await ui.render('![[film.mp4]]');assert.equal(paused,1);assert.equal(loaded,1);assert.equal(audio.getAttribute('src'),null);const video=ui.container.querySelector('video');assert.ok(video);assert.equal(video.getAttribute('autoplay'),null);assert.equal(video.getAttribute('preload'),'none');video.pause=()=>{paused++;};video.load=()=>{loaded++;};await ui.render('Closed media');assert.equal(paused,2);assert.equal(loaded,2);assert.equal(video.getAttribute('src'),null);
});

test('relative parent links remain host-checked while remote protocols and malformed paths are never forwarded',()=>{
 assert.equal(isVaultDestination('../Assets/image.png'),true);assert.equal(isVaultDestination('/Shared/a.pdf'),true);assert.equal(isVaultDestination('#Heading'),true);for(const value of ['https://remote/x','//remote/x','file:///private/x','javascript:alert(1)','%68ttps%3A%2F%2Fremote/x','a\\b','%zz',''])assert.equal(isVaultDestination(value),false,value);
});
