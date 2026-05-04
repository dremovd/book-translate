import './_setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMostlyCJK,
  pinyinToPalladius,
  chineseToPalladius,
  palladiusTransliterate,
} from '../js/palladius.js';

// ---------- isMostlyCJK ----------

test('isMostlyCJK: true for pure-CJK strings, false for Latin / Cyrillic / empty', () => {
  assert.equal(isMostlyCJK('阮眠'),       true);
  assert.equal(isMostlyCJK('方茹清'),     true);
  assert.equal(isMostlyCJK('北京'),       true);
  assert.equal(isMostlyCJK('Hogwarts'),   false);
  assert.equal(isMostlyCJK('Жуань Мянь'), false);
  assert.equal(isMostlyCJK(''),           false);
  assert.equal(isMostlyCJK(null),         false);
});

// ---------- pinyinToPalladius (pure: hand-fed pinyin) ----------

// Names from the chapters_32-45.md sample, transliterations from the
// reference implementation at palladius.ru. These pin down the
// Palladius rules end-to-end (tokenization + syllable lookup + ng/n
// suffix fix + capitalisation).
test('pinyinToPalladius: standard names match the canonical Palladius output', () => {
  const cases = [
    ['ruan mian',       'Жуань Мянь'],
    ['fang ru qing',    'Фан Жу Цин'],
    ['chen yi',         'Чэнь И'],
    ['ji sui',          'Цзи Суй'],
    ['xu yan miao',     'Сюй Янь Мяо'],
    ['qing he gong zhu','Цин Хэ Гун Чжу'],
    ['da zhou',         'Да Чжоу'],
    ['da xia',          'Да Ся'],
    ['he nan',          'Хэ Нань'],
    ['jin yi wei',      'Цзинь И Вэй'],
    ['hu bu',           'Ху Бу'],
    ['wan shou gong zhu','Вань Шоу Гун Чжу'],
    ['qin zheng',       'Цинь Чжэн'],
    ['a zheng',         'А Чжэн'],
    ['xu lang',         'Сюй Лан'],
    ['xu si wu',        'Сюй Сы У'],
    ['bing bu si wu',   'Бин Бу Сы У'],
    ['dong shi',        'Дун Ши'],
    ['ji gong',         'Цзи Гун'],
    ['jin wen xue pai', 'Цзинь Вэнь Сюэ Пай'],
  ];
  for (const [pinyin, expected] of cases) {
    const got = pinyinToPalladius(pinyin, { capitalizeWords: true, separateSyllables: true });
    assert.equal(got, expected, `pinyin="${pinyin}" → got "${got}", expected "${expected}"`);
  }
});

test('pinyinToPalladius: empty / whitespace input returns empty string', () => {
  assert.equal(pinyinToPalladius(''),    '');
  assert.equal(pinyinToPalladius('   '), '');
  assert.equal(pinyinToPalladius(null),  '');
});

test('pinyinToPalladius: -ng / -n softening rules fire (chen → чэнь, jiang → цзян)', () => {
  assert.equal(pinyinToPalladius('chen', { capitalizeWords: true }),  'Чэнь');
  assert.equal(pinyinToPalladius('jiang', { capitalizeWords: true }), 'Цзян');
  assert.equal(pinyinToPalladius('ming',  { capitalizeWords: true }), 'Мин');
});

test('pinyinToPalladius: capitalizeWords title-cases each space-separated word', () => {
  const lower = pinyinToPalladius('ruan mian', { capitalizeWords: false, separateSyllables: true });
  const upper = pinyinToPalladius('ruan mian', { capitalizeWords: true,  separateSyllables: true });
  assert.equal(lower, 'жуань мянь');
  assert.equal(upper, 'Жуань Мянь');
});

test('pinyinToPalladius: ъ-separator after a Cyrillic syllable ending in -н before a vowel', () => {
  // The cyrillic-loop only fires within a single space-delimited input
  // word. -ng softening yields Cyrillic ending in -н (jiang → цзян);
  // when the next tokenized syllable starts with a Russian vowel,
  // Palladius requires a hard sign (ъ) between them. The ъ is inserted
  // BEFORE the soft separator (whether forced via separateSyllables or
  // implicit via the single-letter rule).
  assert.equal(
    pinyinToPalladius('jiangyi', { separateSyllables: false }),
    'цзянъи',
  );
  assert.equal(
    pinyinToPalladius('jiangyi', { separateSyllables: true }),
    'цзянъ и',
  );
});

test('pinyinToPalladius: two single-letter syllables get a soft separator even without separateSyllables', () => {
  // Inside one input word, two adjacent single-letter syllables (e.g.
  // "aa" tokenizing into ['a','a']) would otherwise glue into one
  // Cyrillic blob. The bothSingleLetterSyllable rule inserts a space
  // anyway so they read as two distinct syllables.
  // (Using "aa" specifically because multi-letter starts like "ao" hit
  // the SYLLABLE table directly and don't tokenize into two pieces.)
  assert.equal(pinyinToPalladius('aa', { separateSyllables: false }), 'а а');
});

test('pinyinToPalladius: isGeographic switches hui/feng/meng/fen/men to ой/ын/ынь', () => {
  assert.equal(pinyinToPalladius('hui',  { isGeographic: true,  capitalizeWords: true }), 'Хой');
  assert.equal(pinyinToPalladius('hui',  { isGeographic: false, capitalizeWords: true }), 'Хуэй');
  assert.equal(pinyinToPalladius('feng', { isGeographic: true,  capitalizeWords: true }), 'Фын');
  assert.equal(pinyinToPalladius('feng', { isGeographic: false, capitalizeWords: true }), 'Фэн');
});

// ---------- chineseToPalladius (pinyin-pro injected via opts.pinyinFn) ----------

test('chineseToPalladius: pipes Chinese through injected pinyin function and into Palladius rules', () => {
  // Stand-in for pinyin-pro: returns a fixed pinyin for the inputs we
  // exercise in tests. The keys are the exact Han-string the test
  // produces; the value is what pinyin-pro would emit (verified
  // against pinyin-pro 3.28.1).
  const FIXTURE = {
    '阮眠':    'ruan mian',
    '方茹清':  'fang ru qing',
    '北京':    'bei jing',
    '陈意':    'chen yi',
  };
  const stubPinyin = (text) => FIXTURE[text] ?? text;
  assert.equal(chineseToPalladius('阮眠',   { pinyinFn: stubPinyin }), 'Жуань Мянь');
  assert.equal(chineseToPalladius('方茹清', { pinyinFn: stubPinyin }), 'Фан Жу Цин');
  assert.equal(chineseToPalladius('北京',   { pinyinFn: stubPinyin }), 'Бэй Цзин');
  assert.equal(chineseToPalladius('陈意',   { pinyinFn: stubPinyin }), 'Чэнь И');
});

test('chineseToPalladius: empty input → empty string, no pinyinFn call', () => {
  let called = 0;
  const stubPinyin = () => { called++; return ''; };
  assert.equal(chineseToPalladius('',   { pinyinFn: stubPinyin }), '');
  assert.equal(chineseToPalladius(null, { pinyinFn: stubPinyin }), '');
  assert.equal(called, 0);
});

test('chineseToPalladius: throws when pinyin-pro is missing AND no pinyinFn was passed', () => {
  // No globalThis.pinyinPro in Node tests, no pinyinFn injected.
  assert.throws(() => chineseToPalladius('阮眠'), /pinyin-pro is not loaded/);
});

// ---------- palladiusTransliterate (the public batch API) ----------

test('palladiusTransliterate: maps each CJK input to its transliteration, drops non-CJK', () => {
  const FIXTURE = {
    '阮眠':    'ruan mian',
    '方茹清':  'fang ru qing',
  };
  const stubPinyin = (text) => FIXTURE[text] ?? text;
  return palladiusTransliterate(
    ['阮眠', '方茹清', 'Hogwarts', '', null],
    { pinyinFn: stubPinyin },
  ).then(map => {
    assert.equal(map.size, 2);
    assert.equal(map.get('阮眠'),    'Жуань Мянь');
    assert.equal(map.get('方茹清'),  'Фан Жу Цин');
    assert.equal(map.has('Hogwarts'), false);
  });
});

test('palladiusTransliterate: dedupes identical inputs', async () => {
  let calls = 0;
  const stubPinyin = (text) => { calls++; return 'ruan mian'; };
  const map = await palladiusTransliterate(
    ['阮眠', '阮眠', '阮眠'],
    { pinyinFn: stubPinyin },
  );
  assert.equal(map.size, 1);
  assert.equal(calls, 1, 'must call pinyin-pro once per unique input');
});

test('palladiusTransliterate: empty / non-CJK list → empty Map, no pinyinFn call', async () => {
  let called = 0;
  const stubPinyin = () => { called++; return ''; };
  const map = await palladiusTransliterate(['Hogwarts', 'Москва'], { pinyinFn: stubPinyin });
  assert.equal(map.size, 0);
  assert.equal(called, 0);
});
