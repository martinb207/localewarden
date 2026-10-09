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

  it('flags untranslated prose but not short strings', () => {
    expect(checks('de', 'This is a longer sentence', 'This is a longer sentence')).toContain('untranslated');
    expect(checks('de', 'OK', 'OK')).not.toContain('untranslated');
  });

  it('flags changed links and missing years', () => {
    expect(checks('de', 'See <a href="/a">this</a>', 'Siehe <a href="/b">das</a>')).toContain('markup');
    expect(checks('de', 'A study (Smith, 2015)', 'Eine Studie (Smith)')).toContain('years');
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

