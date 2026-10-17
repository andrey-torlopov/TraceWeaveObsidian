import * as path from 'node:path';
import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';

interface Replacement { start: number; end: number; value: string }
/** Rewrite destinations only. Markdown spelling, prose, YAML, code and immutable report payloads stay intact. */
export function rewriteMovedNoteLinks(text: string, oldPath: string, newPath: string, moves: ReadonlyMap<string, string>): string {
  if (Buffer.byteLength(text, 'utf8') > 5_242_880) throw new Error('Заметка превышает допустимый размер для переноса ссылок.');
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  const protectedRanges: { start: number; end: number }[] = [], replacements: Replacement[] = [];
  const yamlStart = /^(?:\uFEFF)?---\r?\n/u.exec(text);
  if (yamlStart) {
    const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gmu; end.lastIndex = yamlStart[0].length;
    const match = end.exec(text); protectedRanges.push({ start: 0, end: match ? match.index + match[0].length : text.length });
  }
  const protectedTypes = new Set(['codeFenced', 'codeIndented', 'codeText', 'htmlFlow', 'htmlText', 'resourceDestination', 'resourceTitle', 'definitionDestination', 'definitionTitle', 'label']);
  const inRange = (start: number, end: number) => protectedRanges.some(range => start < range.end && end > range.start);
  const mapped = (value: string): string => {
    const exact = moves.get(value); if (exact) return exact;
    let best = '';
    for (const prefix of moves.keys()) if (value.startsWith(prefix + '/') && prefix.length > best.length) best = prefix;
    return best ? moves.get(best)! + value.slice(best.length) : value;
  };
  const destination = (raw: string, wiki: boolean, literal: boolean): string => {
    const uri = wiki ? raw : decodeString(raw), suffixAt = uri.search(/[?#]/u), suffix = suffixAt < 0 ? '' : uri.slice(suffixAt);
    let pathname: string;
    try { pathname = decodeURIComponent(suffixAt < 0 ? uri : uri.slice(0, suffixAt)); } catch { return raw; }
    if (!pathname || /^[a-z][a-z\d+.-]*:|^\/\/|[\x00-\x1f\x7f\\]/iu.test(pathname)) return raw;
    const escapeLiteral = (value: string) => value.replace(/[%#?&>]/gu, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    const rooted = pathname.startsWith('/'), relative = /^\.\.?\//u.test(pathname);
    const rootTarget = pathname.replace(/^\//u, '');
    // A plain wikilink keeps Obsidian's name resolution. Only an exact/prefix migration target changes it.
    if (wiki && !rooted && !relative) {
      const next = mapped(rootTarget);
      return next === rootTarget ? raw : escapeLiteral(next) + suffix;
    }
    const rootMapped = mapped(rootTarget);
    const absolute = rooted || rootMapped !== rootTarget ? rootTarget : path.posix.normalize(path.posix.join(path.posix.dirname(oldPath), pathname));
    if (absolute.startsWith('../') || absolute === '..') return raw;
    const relocated = mapped(absolute);
    if (oldPath === newPath && relocated === absolute && rootMapped === rootTarget) return raw;
    let next = rooted ? '/' + relocated : rootMapped !== rootTarget ? relocated : path.posix.relative(path.posix.dirname(newPath), relocated);
    if (wiki && relative && !next.startsWith('.')) next = './' + next;
    if (next === pathname) return raw;
    if (!wiki && !literal) next = encodeURI(next).replace(/[()<>#?&]/gu, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    else next = escapeLiteral(next);
    return next + suffix;
  };
  for (const [kind, token] of events) {
    if (kind !== 'enter' || token.start.offset === undefined || token.end.offset === undefined) continue;
    const start = token.start.offset, end = token.end.offset;
    if (protectedTypes.has(token.type)) protectedRanges.push({ start, end });
    if (token.type !== 'resourceDestinationString' && token.type !== 'definitionDestinationString') continue;
    if (yamlStart && start < protectedRanges[0]!.end) continue;
    const raw = text.slice(start, end), next = destination(raw, false, text[start - 1] === '<');
    if (next !== raw) replacements.push({ start, end, value: next });
  }
  for (const match of text.matchAll(/!?\[\[([^\]\r\n]+)\]\]/gu)) {
    const start = match.index, end = start + match[0].length;
    let slashes = 0; for (let index = start - 1; index >= 0 && text[index] === '\\'; index--) slashes++;
    if (slashes % 2 || inRange(start, end)) continue;
    const body = match[1]!, aliasAt = body.indexOf('|'), raw = aliasAt < 0 ? body : body.slice(0, aliasAt);
    const leading = raw.match(/^\s*/u)![0], trailing = raw.match(/\s*$/u)![0], trimmed = raw.trim();
    const next = destination(trimmed, true, true);
    if (next !== trimmed) {
      const contentStart = start + (match[0].startsWith('!') ? 3 : 2);
      replacements.push({ start: contentStart, end: contentStart + raw.length, value: leading + next + trailing });
    }
  }
  let output = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  return output;
}
