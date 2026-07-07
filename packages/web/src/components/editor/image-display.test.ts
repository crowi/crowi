import { describe, it, expect } from 'vitest';
import {
  getFigureLayoutClassName,
  getImageDisplayStyle,
  hasFigureMarker,
  mergeImageClassName,
  mergeImageStyle,
  stripImageDisplayTransportProps,
} from './image-display';

describe('getImageDisplayStyle — width/height re-validation (img layer)', () => {
  it('accepts a valid percentage width', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-width': '60%' })).toEqual({ width: '60%' });
  });

  it('accepts a valid pixel height', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-height': '240px' })).toEqual({ height: '240px' });
  });

  it('accepts both width and height together', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-width': '50%', 'data-crowi-image-height': '4096px' })).toEqual({ width: '50%', height: '4096px' });
  });

  it('accepts the camelCase transport key form too (hast-util-to-jsx-runtime version defensiveness)', () => {
    expect(getImageDisplayStyle({ dataCrowiImageWidth: '20%' })).toEqual({ width: '20%' });
  });

  it.each([
    ['non-numeric', 'abc'],
    ['over 100%', '200%'],
    ['at 0%', '0%'],
    ['unit-less', '60'],
    ['unrecognised unit', '60vw'],
  ])('drops an invalid width value (%s)', (_label, value) => {
    expect(getImageDisplayStyle({ 'data-crowi-image-width': value })).toEqual({});
  });

  it.each([
    ['over 4096px', '5000px'],
    ['at 0px', '0px'],
  ])('drops an invalid height value (%s)', (_label, value) => {
    expect(getImageDisplayStyle({ 'data-crowi-image-height': value })).toEqual({});
  });

  it('keeps the closed-interval boundaries valid (1%, 100%, 1px, 4096px)', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-width': '1%' })).toEqual({ width: '1%' });
    expect(getImageDisplayStyle({ 'data-crowi-image-width': '100%' })).toEqual({ width: '100%' });
    expect(getImageDisplayStyle({ 'data-crowi-image-height': '1px' })).toEqual({ height: '1px' });
    expect(getImageDisplayStyle({ 'data-crowi-image-height': '4096px' })).toEqual({ height: '4096px' });
  });

  it('never reads align/float (img layer never derives block-level layout)', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-align': 'center', 'data-crowi-image-float': 'right' })).toEqual({});
  });

  it('returns an empty style object when no transport keys are present', () => {
    expect(getImageDisplayStyle({})).toEqual({});
  });
});

describe('getFigureLayoutClassName — align/float re-validation (figure layer)', () => {
  it('returns the align class for a valid align value', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'center' })).toBe('crowi-image-align-center');
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'left' })).toBe('crowi-image-align-left');
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'right' })).toBe('crowi-image-align-right');
  });

  it('returns the float class for a valid float value', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-float': 'left' })).toBe('crowi-image-float-left');
    expect(getFigureLayoutClassName({ 'data-crowi-image-float': 'right' })).toBe('crowi-image-float-right');
  });

  it('prefers float over align when both are valid (AC-A4)', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'center', 'data-crowi-image-float': 'right' })).toBe('crowi-image-float-right');
  });

  it('drops an unknown enum value', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'middle' })).toBe('');
    expect(getFigureLayoutClassName({ 'data-crowi-image-float': 'up' })).toBe('');
  });

  it('never reads width/height (figure layer never derives img sizing)', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-width': '60%', 'data-crowi-image-height': '240px' })).toBe('');
  });

  it('returns an empty string when no transport keys are present', () => {
    expect(getFigureLayoutClassName({})).toBe('');
  });
});

describe('security re-validation — forged raw-HTML data-crowi-image-* (AC-B2)', () => {
  it('generates no style for a forged width value smuggling a CSS injection payload', () => {
    expect(getImageDisplayStyle({ 'data-crowi-image-width': '1px;position:fixed;top:0;left:0' })).toEqual({});
  });

  it('generates no layout class for a forged align value smuggling a CSS injection payload', () => {
    expect(getFigureLayoutClassName({ 'data-crowi-image-align': 'center;--x:url(evil)' })).toBe('');
  });

  it('produces IDENTICAL results for a well-formed value regardless of origin (transform-emitted vs raw-HTML-forged)', () => {
    // Both paths hit the exact same re-validation code — there is no
    // "trusted origin" flag anywhere in this module's inputs.
    const transformEmitted = { 'data-crowi-image-width': '60%' };
    const rawHtmlForged = { 'data-crowi-image-width': '60%' };
    expect(getImageDisplayStyle(transformEmitted)).toEqual(getImageDisplayStyle(rawHtmlForged));
  });
});

describe('stripImageDisplayTransportProps — 4-key strip scope (AC-B3)', () => {
  it('strips all 4 transport keys (hyphenated form)', () => {
    const stripped = stripImageDisplayTransportProps({
      'data-crowi-image-width': '60%',
      'data-crowi-image-height': '240px',
      'data-crowi-image-align': 'center',
      'data-crowi-image-float': 'right',
      id: 'keep-me',
    });
    expect(stripped).toEqual({ id: 'keep-me' });
  });

  it('strips all 4 transport keys (camelCase form)', () => {
    const stripped = stripImageDisplayTransportProps({
      dataCrowiImageWidth: '60%',
      dataCrowiImageHeight: '240px',
      dataCrowiImageAlign: 'center',
      dataCrowiImageFloat: 'right',
      title: 'keep-me',
    });
    expect(stripped).toEqual({ title: 'keep-me' });
  });

  it('leaves unrelated raw <img> props (style/class/width/height/unknown data-*) completely untouched', () => {
    const input = {
      style: { color: 'red' },
      className: 'some-user-class',
      width: 800,
      height: 600,
      'data-foo': 'bar',
      loading: 'lazy',
    };
    expect(stripImageDisplayTransportProps(input)).toEqual(input);
  });
});

describe('mergeImageClassName — raw className passthrough (AC-B3)', () => {
  it('appends a string className to the base classes', () => {
    expect(mergeImageClassName('max-w-full h-auto', 'user-class')).toBe('max-w-full h-auto user-class');
  });

  it('appends an array-form className (joined)', () => {
    expect(mergeImageClassName('max-w-full h-auto', ['user-class', 'another'])).toBe('max-w-full h-auto user-class another');
  });

  it('returns just the base classes when there is no incoming className', () => {
    expect(mergeImageClassName('max-w-full h-auto', undefined)).toBe('max-w-full h-auto');
    expect(mergeImageClassName('max-w-full h-auto', '')).toBe('max-w-full h-auto');
  });
});

describe('mergeImageStyle — raw style passthrough (AC-B3)', () => {
  it('keeps an unrelated raw style property alongside the re-validated display style', () => {
    expect(mergeImageStyle({ border: '1px solid red' }, { width: '60%' })).toEqual({ border: '1px solid red', width: '60%' });
  });

  it('lets the re-validated display style win on a literal key collision', () => {
    expect(mergeImageStyle({ width: '10px' }, { width: '60%' })).toEqual({ width: '60%' });
  });

  it('returns just the display style when there is no raw style', () => {
    expect(mergeImageStyle(undefined, { width: '60%' })).toEqual({ width: '60%' });
  });
});

describe('hasFigureMarker — forged-marker-safe gating (AC-B4)', () => {
  it('is true for a plain "crowi-figure" className', () => {
    expect(hasFigureMarker('crowi-figure')).toBe(true);
  });

  it('is true when the marker is combined with other classes (space-separated string)', () => {
    expect(hasFigureMarker('crowi-figure some-other-class')).toBe(true);
    expect(hasFigureMarker('some-other-class crowi-figure')).toBe(true);
  });

  it('is true for an array-form className carrying the marker', () => {
    expect(hasFigureMarker(['crowi-figure', 'extra'])).toBe(true);
  });

  it('is false for a raw <figure> with no marker', () => {
    expect(hasFigureMarker('user-class')).toBe(false);
    expect(hasFigureMarker(undefined)).toBe(false);
    expect(hasFigureMarker(null)).toBe(false);
  });

  it('is false for a class that merely contains the marker as a substring (no word boundary)', () => {
    expect(hasFigureMarker('crowi-figure-x')).toBe(false);
  });
});
