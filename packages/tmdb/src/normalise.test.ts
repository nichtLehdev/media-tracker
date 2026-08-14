import { describe, expect, it } from 'vitest';
import { normaliseTitle, titlesMatch, yearsMatch } from './normalise.js';

describe('normaliseTitle', () => {
  it('lowercases', () => {
    expect(normaliseTitle('The Matrix')).toBe('matrix');
    expect(normaliseTitle('ROGUE ONE')).toBe('rogue one');
  });

  it('folds diacritics to plain ASCII', () => {
    expect(normaliseTitle('Amélie')).toBe('amelie');
    expect(normaliseTitle('Léon')).toBe('leon');
  });

  it('drops a single leading article in English, German, French, Spanish, and Italian', () => {
    expect(normaliseTitle('The Matrix')).toBe('matrix');
    expect(normaliseTitle('A Beautiful Mind')).toBe('beautiful mind');
    expect(normaliseTitle('An American Werewolf in London')).toBe(
      'american werewolf in london',
    );
    expect(normaliseTitle('Das Boot')).toBe('boot');
    expect(normaliseTitle('Die Welle')).toBe('welle');
    expect(normaliseTitle('Le Fabuleux Destin')).toBe('fabuleux destin');
    expect(normaliseTitle('La Vita è Bella')).toBe('vita e bella');
    expect(normaliseTitle('El Laberinto del Fauno')).toBe(
      'laberinto del fauno',
    );
    expect(normaliseTitle('Los Olvidados')).toBe('olvidados');
    expect(normaliseTitle('Il Postino')).toBe('postino');
    expect(normaliseTitle('Gli Idoli')).toBe('idoli');
  });

  it('strips punctuation to spaces, including colons and hyphens', () => {
    expect(normaliseTitle('Spider-Man: Into the Spider-Verse')).toBe(
      'spider man into the spider verse',
    );
  });

  it('folds an ampersand to "and"', () => {
    expect(normaliseTitle('Fast & Furious')).toBe('fast and furious');
  });

  it('treats straight and curly apostrophes the same', () => {
    expect(normaliseTitle("Ocean's Eleven")).toBe(
      normaliseTitle('Ocean’s Eleven'),
    );
  });

  it('collapses repeated whitespace produced by stripped punctuation', () => {
    expect(normaliseTitle('  THE   MATRIX  ')).toBe('matrix');
  });

  it('does not strip an article that is not followed by another word', () => {
    // LEADING_ARTICLES requires trailing whitespace, so a bare "The" (the
    // whole title) is left as-is rather than reduced to an empty string.
    expect(normaliseTitle('The')).toBe('the');
  });

  it('normalises a title of pure punctuation to an empty string', () => {
    expect(normaliseTitle('---')).toBe('');
    expect(normaliseTitle('')).toBe('');
  });

  it('only strips one leading article, not a chain of them', () => {
    // "The The" (the band) should not fully collapse.
    expect(normaliseTitle('The The')).toBe('the');
  });
});

describe('titlesMatch', () => {
  it('matches titles that normalise identically', () => {
    expect(titlesMatch('The Matrix', 'the matrix')).toBe(true);
    expect(titlesMatch('Amélie', 'Amelie')).toBe(true);
    expect(titlesMatch('Spider-Man: Into the Spider-Verse', 'Spider Man Into the Spider Verse')).toBe(true);
  });

  it('does not match titles that normalise differently', () => {
    expect(titlesMatch('The Matrix', 'The Matrix Reloaded')).toBe(false);
  });

  it('never matches two empty/punctuation-only titles against each other', () => {
    // Guards against a search result whose title happens to be blank
    // "matching" every blank query.
    expect(titlesMatch('', '')).toBe(false);
    expect(titlesMatch('---', '...')).toBe(false);
  });
});

describe('yearsMatch', () => {
  it('accepts an exact match', () => {
    expect(yearsMatch(2020, 2020)).toBe(true);
  });

  it('accepts a difference of exactly 1 in either direction', () => {
    expect(yearsMatch(2020, 2021)).toBe(true);
    expect(yearsMatch(2020, 2019)).toBe(true);
  });

  it('rejects a difference of 2 or more', () => {
    expect(yearsMatch(2020, 2022)).toBe(false);
    expect(yearsMatch(2022, 2020)).toBe(false);
  });

  it('accepts when either side is null or undefined (S9: no year filter to apply)', () => {
    expect(yearsMatch(null, 2020)).toBe(true);
    expect(yearsMatch(2020, undefined)).toBe(true);
    expect(yearsMatch(null, undefined)).toBe(true);
  });
});
