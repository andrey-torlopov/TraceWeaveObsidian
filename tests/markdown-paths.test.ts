import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteMovedNoteLinks } from '../src/storage/markdown-paths';

const oldPath = 'TraceWeave Notes/project/a.md', newPath = 'TWData/notes/project/a.md';
const moves = new Map([['TraceWeave Notes', 'TWData/notes'], ['TraceWeave Resources', 'TWData/resources']]);
test('managed note migration rebases actual Markdown and wiki destinations while preserving formatting', () => {
  const source = '[image](../../Attachment/a.png "same title")\r\n![spaced](<../../Attachment/a b.png>)\r\n[[TraceWeave Resources/id/original.wav|звук]]\r\n![[../../Attachment/a.png|200]]\r\n[other](b.md#part)\r\n\r\n[ref]: ../../Attachment/a.pdf\r\n';
  const expected = '[image](../../../Attachment/a.png "same title")\r\n![spaced](<../../../Attachment/a b.png>)\r\n[[TWData/resources/id/original.wav|звук]]\r\n![[../../../Attachment/a.png|200]]\r\n[other](b.md#part)\r\n\r\n[ref]: ../../../Attachment/a.pdf\r\n';
  assert.equal(rewriteMovedNoteLinks(source, oldPath, newPath, moves), expected);
});
test('migration protects YAML, nested code, escaped wiki, HTML and remote URLs', () => {
  const protectedText = '---\nexample: "[[TraceWeave Notes/a.md]]"\n---\n\n```md\n[x](../../Attachment/a.png)\n[[TraceWeave Notes/a.md]]\n```\n\n    [x](../../Attachment/a.png)\n\n`![[TraceWeave Notes/a.md]]` \\[[TraceWeave Notes/a.md]]\n\n<div>[[TraceWeave Notes/a.md]]</div>\n\n[x](https://example.com/a.png) [mail](mailto:test@example.com) [anchor](#part)\n';
  assert.equal(rewriteMovedNoteLinks(protectedText, oldPath, newPath, moves), protectedText);
});
test('token positions handle nested image links, parentheses, entity-encoded names and root paths', () => {
  const source = '[![alt](../../Attachment/a.png)](../../Attachment/b.pdf "caption")\n[x](../../Attachment/a\\(b\\).png)\n[x](<../../Attachment/a&amp;b.png>)\n[x](/TraceWeave%20Resources/id/a.png)\n[[a]]\n';
  const output = rewriteMovedNoteLinks(source, oldPath, newPath, moves);
  assert.equal(output, '[![alt](../../../Attachment/a.png)](../../../Attachment/b.pdf "caption")\n[x](../../../Attachment/a%28b%29.png)\n[x](<../../../Attachment/a%26b.png>)\n[x](/TWData/resources/id/a.png)\n[[a]]\n');
  assert.equal(rewriteMovedNoteLinks('[x](../outside.md)', 'Folder/a.md', 'Folder/a.md', moves), '[x](../outside.md)');
});

test('migration preserves encoded filename delimiters and literal entity-looking names', () => {
  const source = '![x](../../Attachment/a%231.png)\n![x](../../Attachment/a%3F1.png#section)\n![x](<../../Attachment/a&amp;copy;.png>)\n[[TraceWeave Resources/a%231.png|name]]\n';
  assert.equal(rewriteMovedNoteLinks(source, oldPath, newPath, moves), '![x](../../../Attachment/a%231.png)\n![x](../../../Attachment/a%3F1.png#section)\n![x](<../../../Attachment/a%26copy;.png>)\n[[TWData/resources/a%231.png|name]]\n');
});
test('ordinary notes without relocated destinations retain exact Markdown spelling', () => {
  const source = '[Sibling](./Other.md)\n![Image](<./photo.png>)\n[Encoded](./a%23b.md#Heading)\n';
  assert.equal(rewriteMovedNoteLinks(source, 'Folder/note.md', 'Folder/note.md', new Map([['TraceWeave Notes', 'TWData/notes']])), source);
});
