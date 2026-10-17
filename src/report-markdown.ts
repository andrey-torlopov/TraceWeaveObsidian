import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';

interface Range { start: number; end: number }
interface Replacement extends Range { value: string }
export interface ReportLink { target: string | null; embed: boolean; suffix?: string }
export interface PreparedMarkdown { text: string; headings: Map<string, string>; blocks: Map<string, string> }
const tokenEvents = (text: string) => {
  // CommonMark has no footnotes. Mask only their definition colon so the content is parsed as ordinary Markdown.
  const input = text.replace(/^( {0,3}\[\^[^\]\r\n]+\]):/gmu, '$1 ');
  const tokenizer = parse().document();
  const chunks: Parameters<typeof tokenizer.write>[0] = preprocess()(input, 'utf8', true);
  return postprocess(tokenizer.write(chunks));
};
const protectedTypes = new Set(['codeFenced', 'codeIndented', 'codeText', 'htmlFlow', 'htmlText']);
const key = (value: string) => decodeString(value).replace(/[*_`]/gu, '').trim().toLowerCase();
export function markdownLabel(value: string): string { return value.replace(/[\r\n\t]+/gu, ' ').replace(/[\\`*_[\]#!|]/gu, '\\$&').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'); }
export function markdownDestination(value: string): string { return (/^https?:/iu.test(value) ? new URL(value).href : encodeURI(value).replace(/#%5E/gu, '#^')).replace(/[()<>]/gu, character => '%' + character.charCodeAt(0).toString(16).toUpperCase()); }
function replace(text: string, changes: Replacement[]): string {
  let output = text;
  const outer: Replacement[] = [];
  for (const change of changes.sort((a, b) => a.start - b.start || b.end - a.end)) if (!outer.some(previous => change.start < previous.end && change.end > previous.start)) outer.push(change);
  for (const change of outer.reverse()) output = output.slice(0, change.start) + change.value + output.slice(change.end);
  return output;
}
function frontmatter(text: string): Range | null {
  const start = /^(?:\uFEFF)?---\r?\n/u.exec(text); if (!start) return null;
  const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gmu; end.lastIndex = start[0].length;
  const found = end.exec(text); return { start: 0, end: found ? found.index + found[0].length : text.length };
}
const fenced = (value: string, language: string) => { const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/gu)].map(match => match[0].length + 1))); return `${fence}${language}\n${value.replace(/\n?$/u, '\n')}${fence}`; };

/** Scope headings and block references so merged source notes keep working without ambiguous anchors. */
export function prepareReportMarkdown(text: string, ordinal: number): PreparedMarkdown {
  const yaml = frontmatter(text), changes: Replacement[] = [], headings = new Map<string, string>(), blocks = new Map<string, string>();
  const events = tokenEvents(text), protectedRanges: Range[] = [];
  for (const [kind, token] of events) {
    if (kind !== 'enter' || token.start.offset === undefined || token.end.offset === undefined) continue;
    const start = token.start.offset, end = token.end.offset;
    if (protectedTypes.has(token.type)) protectedRanges.push({ start, end });
  }
  const inside = (start: number, end: number) => (yaml && start < yaml.end) || protectedRanges.some(range => start < range.end && end > range.start);
  let headingNumber = 0;
  for (const [kind, token] of events) {
    if (kind !== 'enter' || !['atxHeading', 'setextHeading'].includes(token.type) || token.start.offset === undefined || token.end.offset === undefined) continue;
    const start = token.start.offset, end = token.end.offset; if (inside(start, end)) continue;
    const heading = events.find(([event, child]) => event === 'enter' && ['atxHeadingText', 'setextHeadingText'].includes(child.type) && (child.start.offset ?? -1) >= start && (child.end.offset ?? Infinity) <= end)?.[1];
    if (!heading || heading.start.offset === undefined || heading.end.offset === undefined) continue;
    const original = text.slice(heading.start.offset, heading.end.offset), numbering = `${ordinal}.${++headingNumber}. `, next = numbering + original;
    if (!headings.has(key(original))) headings.set(key(original), key(next));
    if (token.type === 'setextHeading') {
      changes.push({ start, end, value: '#### ' + next.replace(/\r?\n/gu, ' ') });
    } else {
      const sequence = /^#{1,6}/u.exec(text.slice(start, heading.start.offset));
      if (sequence) changes.push({ start, end: start + sequence[0].length, value: '#'.repeat(Math.min(6, sequence[0].length + 3)) });
      changes.push({ start: heading.start.offset, end: heading.start.offset, value: numbering });
    }
  }
  for (const match of text.matchAll(/\^([A-Za-z0-9-]+)(?=[ \t]*(?:\r?\n|$))/gu)) {
    const start = match.index, end = start + match[0].length; if (inside(start, end)) continue;
    const block = `tw-note-${ordinal}-${match[1]}`; blocks.set(match[1], block); changes.push({ start, end, value: '^' + block });
  }
  for (const match of text.matchAll(/\[\^([^\]\r\n]+)\]/gu)) {
    const start = match.index, end = start + match[0].length; if (inside(start, end)) continue;
    changes.push({ start, end, value: `[^tw-note-${ordinal}-${match[1]}]` });
  }
  // YAML remains readable data, never becomes active frontmatter or link destinations in the merged report.
  if (yaml) changes.push({ ...yaml, value: fenced(text.slice(0, yaml.end).trimEnd(), 'yaml') + '\n\n' });
  return { text: replace(text, changes), headings, blocks };
}

/** Rewrite parsed destinations rather than code/prose. HTML is literal; embeds never fetch remote resources. */
export async function relocateReportMarkdown(text: string, resolve: (target: string, embed: boolean) => Promise<ReportLink>): Promise<string> {
  const events = tokenEvents(text), changes: Replacement[] = [], protectedRanges: Range[] = [];
  const definitions = new Map<string, string>();
  let definition: { label?: string; target?: string } | null = null;
  for (const [kind, token] of events) {
    const start = token.start.offset, end = token.end.offset; if (start === undefined || end === undefined) continue;
    if (kind === 'enter' && token.type === 'definition') definition = {};
    if (kind === 'enter' && token.type === 'definitionLabelString' && definition) definition.label = key(text.slice(start, end));
    if (kind === 'enter' && token.type === 'definitionDestinationString' && definition) definition.target = decodeString(text.slice(start, end));
    if (kind === 'exit' && token.type === 'definition' && definition) { if (definition.label && definition.target && !definitions.has(definition.label)) definitions.set(definition.label, definition.target); definition = null; }
    if (kind === 'enter' && (protectedTypes.has(token.type) || ['definition', 'link', 'image', 'autolink'].includes(token.type))) protectedRanges.push({ start, end });
    if (kind === 'enter' && ['htmlFlow', 'htmlText'].includes(token.type)) changes.push({ start, end, value: text.slice(start, end).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;') });
  }
  const render = async (raw: string, label: string, embed: boolean) => {
    const result = await resolve(raw, embed);
    let readable = label || raw;
    if (/!?(?:\[|<)/u.test(readable)) {
      const nested = await relocateReportMarkdown(readable, async (target, nestedEmbed) => { await resolve(target, nestedEmbed); return { target: null, embed: false }; });
      readable = nested.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
    }
    const name = markdownLabel(decodeString(readable));
    return (result.target ? `${result.embed ? '!' : ''}[${name}](${markdownDestination(result.target)})` : name) + (result.suffix ? ` (${markdownLabel(result.suffix)})` : '');
  };
  // Nested parsed link/image tokens can overlap: the outer link is handled with its label intact.
  let covered = -1;
  for (let index = 0; index < events.length; index++) {
    const [kind, token] = events[index]; if (kind !== 'enter' || !['link', 'image', 'autolink', 'definition'].includes(token.type)) continue;
    const start = token.start.offset, end = token.end.offset; if (start === undefined || end === undefined || start < covered) continue;
    if (token.type === 'definition') { changes.push({ start, end, value: '' }); covered = end; continue; }
    if (token.type === 'autolink') { const raw = text.slice(start + 1, end - 1); changes.push({ start, end, value: await render(raw, raw, false) }); covered = end; continue; }
    let label = '', target: string | undefined, reference: string | undefined;
    for (let child = index + 1; child < events.length; child++) {
      const [event, item] = events[child]; if (event === 'exit' && item === token) break;
      if (event !== 'enter' || item.start.offset === undefined || item.end.offset === undefined) continue;
      if (item.type === 'labelText' && !label) label = text.slice(item.start.offset, item.end.offset);
      if (item.type === 'resourceDestinationString') target = decodeString(text.slice(item.start.offset, item.end.offset));
      if (item.type === 'referenceString') reference = key(text.slice(item.start.offset, item.end.offset));
    }
    target ??= definitions.get(reference || key(label));
    if (target !== undefined) { changes.push({ start, end, value: await render(target, label, token.type === 'image') }); covered = end; }
  }
  for (const match of text.matchAll(/(!?)\[\[([^\]\r\n]+)\]\]/gu)) {
    const start = match.index, end = start + match[0].length;
    let escapes = 0; for (let index = start - 1; index >= 0 && text[index] === '\\'; index--) escapes++;
    if (escapes % 2 || protectedRanges.some(range => start < range.end && end > range.start)) continue;
    const separator = match[2].indexOf('|'), raw = (separator < 0 ? match[2] : match[2].slice(0, separator)).trim();
    const label = separator < 0 ? raw : match[2].slice(separator + 1).trim();
    changes.push({ start, end, value: await render(raw, label, !!match[1]) });
  }
  let output = replace(text, changes);
  // An unclosed source fence must not swallow the following node or material sections.
  const finalEvents = tokenEvents(output);
  const stack: string[] = [];
  for (let index = 0; index < finalEvents.length; index++) {
    const [kind, token] = finalEvents[index];
    if (kind === 'exit') { stack.pop(); continue; }
    const contained = stack.some(type => ['blockQuote', 'listOrdered', 'listUnordered'].includes(type)); stack.push(token.type);
    if (token.type !== 'codeFenced' || contained) continue;
    let fences = 0, marker = '```';
    for (let child = index + 1; child < finalEvents.length; child++) { const [event, item] = finalEvents[child]; if (event === 'exit' && item === token) break; if (event === 'enter' && item.type === 'codeFencedFenceSequence' && item.start.offset !== undefined && item.end.offset !== undefined) { fences++; marker = output.slice(item.start.offset, item.end.offset); } }
    if (fences === 1) output += '\n' + marker + '\n';
  }
  const commentRanges = tokenEvents(output).filter(([kind, token]) => kind === 'enter' && ['codeFenced', 'codeIndented', 'codeText'].includes(token.type)).map(([, token]) => ({ start: token.start.offset ?? 0, end: token.end.offset ?? 0 }));
  const comments = [...output.matchAll(/%%/gu)].filter(match => !commentRanges.some(range => match.index >= range.start && match.index < range.end));
  if (comments.length % 2) output += '\n\n%%\n';
  return output;
}
