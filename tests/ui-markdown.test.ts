import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../src/ui/markdown';

const render = (text: string) => renderToStaticMarkup(React.createElement(SafeMarkdown, { text }));

test('Markdown preview suppresses raw HTML scripts, frames and image handlers', () => {
  const html = render('# Заголовок\n\n<script>alert(1)</script>\n\n<iframe src="https://tracker.example"></iframe>\n\n<img src=x onerror=alert(1)>\n\nОбычный текст');
  assert.match(html, /Заголовок/);
  assert.match(html, /Обычный текст/);
  assert.doesNotMatch(html, /<script|<iframe|<img|onerror|tracker\.example/);
});

test('Markdown images never produce image requests or preload URLs', () => {
  const html = render('![Снимок](https://tracker.example/pixel.png)\n\n![Локальный](Resources/photo.png)');
  assert.match(html, /Снимок/);
  assert.match(html, /Локальный/);
  assert.doesNotMatch(html, /<img|<link|src=|https:\/\/tracker\.example|Resources\/photo\.png/);
});

test('explicit HTTP links stay available with isolated browser navigation', () => {
  const html = render('[Источник](https://example.org/source)\n\n[Код](javascript:alert%281%29)\n\n[Файл](file:///private/data)');
  assert.match(html, /href="https:\/\/example\.org\/source"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(html, /href="javascript|href="file:/);
  assert.match(html, /Код/);
  assert.match(html, /Файл/);
});

test('GFM table and list are readable while arbitrary HTML remains disabled', () => {
  const html = render('| Поле | Значение |\n| --- | --- |\n| Тип | Персона |\n\n- Первый\n- Второй');
  assert.match(html, /<table>/);
  assert.match(html, /<td>Персона<\/td>/);
  assert.match(html, /<li>Первый<\/li>/);
});
