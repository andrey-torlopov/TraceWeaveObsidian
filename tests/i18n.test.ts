import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, localeCode, localizedTypeName, resolveLocale, setLocale, subscribeLocale, t } from '../src/i18n';
import { graphAriaLabels } from '../src/ui/graphModel';

test('the host language resolves predictably, including Russian regional variants and English fallback', () => {
  for (const value of ['ru', 'ru-RU', 'ru_BY', ' RU-ru ']) assert.equal(resolveLocale(value), 'ru');
  for (const value of ['en', 'en-GB', 'de', '', 'russian', 'rue']) assert.equal(resolveLocale(value), 'en');
});

test('labels and formatting read the current locale rather than caching module import values', () => {
  try {
    setLocale('en');
    assert.equal(getLocale(), 'en'); assert.equal(localeCode(), 'en-US');
    assert.equal(t('Гипотеза', 'Hypothesis'), 'Hypothesis');
    assert.equal(graphAriaLabels()['controls.zoomIn.ariaLabel'], 'Zoom in');
    assert.equal(graphAriaLabels()['node.a11yDescription.ariaLiveMessage']({ direction: 'left', x: 12, y: 34 }), 'Card moved left. New position: x 12, y 34.');
    setLocale('ru');
    assert.equal(getLocale(), 'ru'); assert.equal(localeCode(), 'ru-RU');
    assert.equal(t('Гипотеза', 'Hypothesis'), 'Гипотеза');
    assert.equal(graphAriaLabels()['controls.zoomIn.ariaLabel'], 'Приблизить');
    assert.match(graphAriaLabels()['node.a11yDescription.ariaLiveMessage']({ direction: 'left', x: 12, y: 34 }), /влево/);
    assert.doesNotMatch(graphAriaLabels()['node.a11yDescription.default'], /Delete|delete|удал/);
  } finally { setLocale('ru'); }
});

test('only unchanged built-in type names receive a display translation and no data is mutated', () => {
  const types = [
    { code: 'note', name: 'Заметка', isSystem: true },
    { code: 'evidence', name: 'Материал', isSystem: true },
    { code: 'note', name: 'My source type', isSystem: true },
    { code: 'note', name: 'Заметка', isSystem: false },
    { code: 'custom', name: 'Материал', isSystem: true },
    { code: 'note', name: 'Note', isSystem: true },
  ];
  const before = JSON.stringify(types);
  try {
    setLocale('en');
    assert.deepEqual(types.map(localizedTypeName), ['Note', 'Source', 'My source type', 'Заметка', 'Материал', 'Note']);
    setLocale('ru');
    assert.deepEqual(types.map(localizedTypeName), types.map(type => type.name));
    assert.equal(JSON.stringify(types), before);
  } finally { setLocale('ru'); }
});

test('locale subscribers receive changed values and can unsubscribe without duplicate notifications', () => {
  setLocale('ru');
  const observed: string[] = [];
  const unsubscribe = subscribeLocale(() => observed.push(getLocale()));
  try {
    setLocale('ru'); setLocale('en'); setLocale('en'); setLocale('ru');
    assert.deepEqual(observed, ['en', 'ru']);
    unsubscribe(); setLocale('en');
    assert.deepEqual(observed, ['en', 'ru']);
  } finally { unsubscribe(); setLocale('ru'); }
});
