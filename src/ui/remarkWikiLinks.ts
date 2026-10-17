/** Minimal mdast representation: this plugin changes only ordinary text nodes. */
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const ignored = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference']);

/** Preserve fenced/inline code, HTML, link destinations and aliases as literal text. */
export default function remarkWikiLinks() {
  return (tree: MarkdownNode, file?: { value?: unknown }): void => {
    const original=typeof file?.value==='string'?file.value:'';
    const visit = (parent: MarkdownNode): void => {
      if (ignored.has(parent.type) || !parent.children) return;
      const children: MarkdownNode[] = [],htmlTags:string[]=[];
      for (const node of parent.children) {
        if(node.type==='html'){
          for(const match of (node.value??'').matchAll(/<(\/?)([a-z][\w:-]*)(?:\s[^<>]*?)?\/?>/giu)){
            const tag=match[2].toLowerCase();if(match[1]){const at=htmlTags.lastIndexOf(tag);if(at>=0)htmlTags.splice(at);}else if(!voidTags.has(tag)&&!match[0].endsWith('/>'))htmlTags.push(tag);
          }
          children.push(node);continue;
        }
        if(htmlTags.length){children.push(node);continue;}
        const start=node.position?.start.offset,end=node.position?.end.offset;
        if(start!==undefined&&end!==undefined&&original.slice(start,end).includes('\\[[')){children.push(node);continue;}
        if (node.type !== 'text' || !node.value) { visit(node); children.push(node); continue; }
        const source = node.value, pattern = /(!?)\[\[([^\]\r\n]+)\]\]/gu;
        let cursor = 0;
        for (const match of source.matchAll(pattern)) {
          const index = match.index, content = match[2], separator = content.indexOf('|');
          const target = (separator < 0 ? content : content.slice(0, separator)).trim();
          const alias = separator < 0 ? target : content.slice(separator + 1).trim() || target;
          if (!target || (index > 0 && source[index - 1] === '\\')) continue;
          if (index > cursor) children.push({ type: 'text', value: source.slice(cursor, index) });
          children.push(match[1] === '!' ? { type: 'image', url: target, title: null, alt: alias }
            : { type: 'link', url: target, title: null, children: [{ type: 'text', value: alias }] });
          cursor = index + match[0].length;
        }
        if (cursor < source.length) children.push({ type: 'text', value: source.slice(cursor) });
      }
      parent.children = children;
    };
    visit(tree);
  };
}
