import { describe, expect, it } from 'vitest';
import { Checker, foreignScript, containsInflected, unsafeAdditions } from '../src/checks.js';
import { resolveConfig } from '../src/config.js';
import { icuArguments, placeholderRegExp, placeholdersMatch } from '../src/placeholders.js';

const config = resolveConfig(
  {
    targetLanguages: ['de', 'fr', 'es', 'ru', 'pl'],
    files: 'locales/{lang}.json',
    formality: { de: 'informal', fr: 'formal' },
    doNotTranslate: ['Acme Cloud'],
    glossary: { pl: { 'Privacy Policy': 'Polityka prywatności' } },
    maxLength: { 'store.name': 10 },
  },
  '/tmp'
);
const checker = new Checker(config);
const checks = (lang: string, source: string, text: string, key = 'k') =>
  checker.checkString(lang, key, source, text).map(issue => issue.check);

describe('placeholders', () => {
  const re = placeholderRegExp();
  it('accepts kept placeholders in any order', () => {
    expect(placeholdersMatch('k', '{a} and {{b}} and %s', '%s, {{b}} und {a}', re)).toBe(true);
  });
  it('rejects translated or dropped ones', () => {
    expect(placeholdersMatch('k', 'Hi {name}', 'Hallo {Name}', re)).toBe(false);
    expect(placeholdersMatch('k', '%1$s of %2$s', '%1$s', re)).toBe(false);
  });
  it('allows {{count}} in i18next plural forms', () => {
    expect(placeholdersMatch('item_one', 'One item', '{{count}} Element', re)).toBe(true);
  });
  it('reads ICU arguments and ignores branch keys and branch text', () => {
    expect(icuArguments('{count, plural, one {# file in {folder}} other {# files}}')).toEqual(['count', 'folder']);
    expect(placeholdersMatch('k', '{n, plural, one {# day} other {# days}}', '{n, plural, one {# dzień} few {# dni} many {# dni} other {# dnia}}', re)).toBe(true);
  });
});

describe('Checker', () => {
  it('flags the wrong form of address', () => {
    expect(checks('de', 'Save your work', 'Speichern Sie Ihre Arbeit')).toContain('formality');
    expect(checks('de', 'Save your work', 'Speichere deine Arbeit')).not.toContain('formality');
    expect(checks('fr', 'Save your work', 'Enregistre ton travail')).toContain('formality');
  });

  it('flags masculine-only address when genderNeutral is on', () => {
    expect(checks('es', 'Are you tired?', '¿Estás cansado?')).toContain('formality');
  });

  it('flags copied Title Case in sentence-case languages', () => {
    expect(checks('fr', 'Set Up Your Account', 'Configurez Votre Compte')).toContain('titlecase');
    expect(checks('fr', 'Set Up Your Account', 'Configurez votre compte')).not.toContain('titlecase');
  });

  it('does not flag capitalised list items or bracketed words', () => {
    expect(checks('fr', 'Follow SMART: Specific, Measurable, Achievable', 'Suivez SMART : Spécifique, Mesurable, Atteignable')).not.toContain('titlecase');
    expect(checks('fr', 'Customize (Optional)', 'Personnaliser (Facultatif)')).not.toContain('titlecase');
  });

  it('accepts the capitalised Polish "you" of respect', () => {
    expect(checks('pl', 'In Your Plan', 'W Twoim planie')).not.toContain('titlecase');
    expect(checks('pl', 'Create Your Goal', 'Utwórz Swój Cel')).toContain('titlecase');
  });

  it('does not count protected names as untranslated text', () => {
    expect(checks('de', 'Acme Cloud App {version}', 'Acme Cloud App {version}')).not.toContain('untranslated');
  });

  it('flags untranslated prose but not short strings', () => {
    expect(checks('de', 'This is a longer sentence', 'This is a longer sentence')).toContain('untranslated');
    expect(checks('de', 'OK', 'OK')).not.toContain('untranslated');
  });

  it('flags changed links and missing years', () => {
    expect(checks('de', 'See <a href="/a">this</a>', 'Siehe <a href="/b">das</a>')).toContain('markup');
    expect(checks('de', 'A study (Smith, 2015)', 'Eine Studie (Smith)')).toContain('years');
  });

  it('flags translations over the length limit', () => {
    expect(checks('de', 'Short name', 'Ein viel zu langer Name', 'store.name')).toContain('length');
    expect(checks('de', 'Short name', 'Kurzname', 'store.name')).not.toContain('length');
  });

  it('flags the wrong Chinese script', () => {
    expect(foreignScript('zh-TW', '这是我们的设计')).toMatch(/Simplified/);
    expect(foreignScript('zh-TW', '這是我們的設計')).toBeNull();
    expect(foreignScript('zh', '這是我們的設計')).toMatch(/Traditional/);
    expect(foreignScript('zh', '这是我们的设计')).toBeNull();
    expect(foreignScript('ja', '学習')).toBeNull();
  });

  it('flags foreign scripts and lookalike letters', () => {
    expect(foreignScript('de', 'Das ist 刺激')).toMatch(/Han/);
    expect(foreignScript('ru', 'Вarda')).toMatch(/mixed-alphabet/);
    expect(foreignScript('ru', 'Привет, iPhone')).toBeNull();
    expect(foreignScript('de', 'θ waves')).toBeNull();
    expect(foreignScript('xx', '刺激')).toBeNull();
  });

  it('checks glossary terms with case endings and kept names', () => {
    expect(containsInflected('pl', 'Zobacz Polityką prywatności', 'Polityka prywatności')).toBe(true);
    expect(checks('pl', 'Read the Privacy Policy', 'Przeczytaj zasady')).toContain('glossary');
    expect(checks('de', 'Open Acme Cloud', 'Öffne Acme-Wolke')).toContain('glossary');
    expect(checks('de', 'Open Acme Cloud', 'Öffne Acme Cloud')).not.toContain('glossary');
  });

  it('flags source text left inside a translation', () => {
    expect(checks('de', 'We keep your data on your own device at all times.', 'Wir speichern your data on your own device at all times.')).toContain('partial');
  });

  it('allows names as bold lead-ins and terms from termNotes in non-Latin scripts', () => {
    expect(checks('de', '<strong>Apple App Store:</strong> billing is handled by Apple.', '<strong>Apple App Store:</strong> Die Abrechnung erfolgt über Apple.')).not.toContain('partial');
    const withTerms = new Checker(resolveConfig({ targetLanguages: ['th'], files: 'x/{lang}.json', termNotes: { 'popcorn brain': 'a coined term' } }, '/tmp'));
    const source = 'This is called popcorn brain by some researchers';
    const text = 'นักวิจัยบางคนเรียกสิ่งนี้ว่า popcorn brain';
    expect(withTerms.checkString('th', 'k', source, text).map(i => i.check)).not.toContain('partial');
    expect(checker.checkString('ru', 'k', source, 'Некоторые исследователи называют это popcorn brain').map(i => i.check)).toContain('partial');
  });

  it('flags translations that lost most of the content', () => {
    const long = 'Pick one recurring moment that tends to create tension. '.repeat(6);
    expect(checks('de', long, 'Wähle einen Moment.')).toContain('partial');
    expect(checks('de', long, 'Wähle einen wiederkehrenden Moment, der oft Spannungen erzeugt. '.repeat(6))).not.toContain('partial');
    expect(checks('ja', long, '家庭で緊張を生みやすい、繰り返し起こる場面を一つ選びましょう。'.repeat(6))).not.toContain('partial');
    expect(checker.defect('de', 'k', long, 'Wähle einen Moment.').soft).toMatch(/much shorter/);
  });

  it('does not take ICU syntax for English words', () => {
    const source = '{count, plural, =0 {No plants need water today} one {{count} plant needs water} other {{count} plants need water}}';
    const text = '{count, plural, =0 {今日は水やりが必要な植物はありません} one {{count}株の植物に水やりが必要です} other {{count}株の植物に水やりが必要です}}';
    expect(checks('ja', source, text)).not.toContain('partial');
    // Outside ICU, English words before a placeholder still count.
    expect(checks('ja', 'Please confirm your email address {email} before continuing', 'Please confirm your email address {email}を確認してください')).toContain('partial');
  });

  it('flags dropped hedges', () => {
    expect(checks('de', 'People tend to forget this.', 'Menschen vergessen das.')).toContain('partial');
    expect(checks('de', 'People tend to forget this.', 'Menschen vergessen das oft.')).not.toContain('partial');
  });

  it('reports hard defects for output that must not be written', () => {
    expect(checker.defect('de', 'k', 'Hi {name}', 'Hallo {Name}').hard).toMatch(/placeholder/);
    expect(checker.defect('de', 'k', 'Use <strong>this</strong> now', 'Nutze <strong>das jetzt').hard).toMatch(/unclosed/);
    expect(checker.defect('de', 'k', 'Hello there', '').hard).toMatch(/empty/);
    expect(checker.defect('de', 'k', 'Hi {name}', 'Hallo {name}').hard).toBeNull();
  });
});

describe('unsafeAdditions', () => {
  it('blocks markup the source does not have', () => {
    expect(unsafeAdditions('Hello there', 'Hallo <script>alert(1)</script>')).toMatch(/<script>/);
    expect(unsafeAdditions('Hello there', 'Hallo <img src=x onerror=alert(1)>')).toMatch(/<img>/);
    expect(unsafeAdditions('See <a href="/p">this</a>', 'Siehe <a href="/p" onclick="x()">das</a>')).toMatch(/event handler/);
    expect(unsafeAdditions('See <a href="/p">this</a>', 'Siehe <a href="https://evil.example">das</a>')).toMatch(/attribute/);
    expect(unsafeAdditions('Read [this](/docs)', 'Lies [das](javascript:alert(1))')).toMatch(/javascript/);
    expect(unsafeAdditions('Hello', 'Hallo &lt;script&gt;x&lt;/script&gt;')).toMatch(/<script>/);
  });

  it('allows harmless emphasis, prose "data:" and Hungarian percent suffixes', () => {
    expect(unsafeAdditions('A study in Nature', 'Eine Studie in <i>Nature</i>')).toBeNull();
    expect(unsafeAdditions('Date: 2020', 'Data: 2020')).toBeNull();
    expect(unsafeAdditions('See <a href="/x">it</a>', 'Veja <a href="data:text/html,x">isso</a>')).toMatch(/attribute|URL/);
    expect(placeholdersMatch('k', 'up to 100%', 'akár 100%-ig', placeholderRegExp())).toBe(true);
    expect(unsafeAdditions('Hello', 'Hallo <i onclick="x()">da</i>')).toMatch(/event handler/);
  });

  it('ignores text in angle brackets that is not HTML, and thousands separators', () => {
    expect(unsafeAdditions('Set a timer for <minutes>', 'Weka kipima muda kwa <dakika>')).toBeNull();
    expect(unsafeAdditions('Time to fall asleep (goal: <20 minutes)', 'Wakati wa kulala (lengo: <dakika 20)')).toBeNull();
    expect(unsafeAdditions('Hello', 'Hallo <svg onload="x()"></svg>')).toMatch(/svg/);
    expect(checks('de', 'About 1,900 people took part (2015).', 'Etwa 1.900 Personen nahmen teil (2015).')).not.toContain('years');
    expect(checks('nb', 'About 1,900 people took part.', 'Rundt 1 900 personer deltok.')).not.toContain('years');
    expect(checks('de', 'A study (2015).', 'Eine Studie (2016).')).toContain('years');
  });

  it('allows kept markup and translated text attributes', () => {
    expect(unsafeAdditions('See <a href="/p" title="Privacy">this</a>', 'Siehe <a href="/p" title="Datenschutz">das</a>')).toBeNull();
    expect(unsafeAdditions('Line one', 'Zeile<br>eins')).toBeNull();
    expect(unsafeAdditions('Use <0>this</0> {name}', 'Nutze <0>das</0> {name}')).toBeNull();
    expect(unsafeAdditions('Under 5 < 10 minutes', 'Unter 5 < 10 Minuten')).toBeNull();
  });

  it('is an error in the check and a hard defect at translate time', () => {
    expect(checks('de', 'Hello there', 'Hallo <b onmouseover="x()">da</b>')).toContain('unsafe');
    expect(checker.defect('de', 'k', 'Hello there', 'Hallo <script>x</script>').hard).toMatch(/script/);
  });
});

