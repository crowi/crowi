import { extractSvgDimensions } from './svg-dimensions';

describe('extractSvgDimensions', () => {
  it('derives rounded width/height from a viewBox with fractional values', () => {
    const svg = '<svg id="crowi-mermaid-9" width="100%" viewBox="-17 -18.4 260.6 492.399999999999999" xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(extractSvgDimensions(svg)).toEqual({ width: 261, height: 492 });
  });

  it('accepts comma-separated viewBox values', () => {
    const svg = '<svg viewBox="0,0,300,150"></svg>';
    expect(extractSvgDimensions(svg)).toEqual({ width: 300, height: 150 });
  });

  it('returns null when there is no viewBox attribute', () => {
    const svg = '<svg width="100%" height="50"></svg>';
    expect(extractSvgDimensions(svg)).toBeNull();
  });

  it('returns null for a non-positive or non-finite width/height', () => {
    expect(extractSvgDimensions('<svg viewBox="0 0 0 150"></svg>')).toBeNull();
    expect(extractSvgDimensions('<svg viewBox="0 0 -300 150"></svg>')).toBeNull();
    expect(extractSvgDimensions('<svg viewBox="0 0 NaN 150"></svg>')).toBeNull();
  });

  it('returns null for an implausibly large width/height (regression: an unbounded value can re-stringify as exponential notation, an invalid HTML width/height attribute)', () => {
    expect(extractSvgDimensions('<svg viewBox="0 0 999999999999999999999 150"></svg>')).toBeNull();
    expect(extractSvgDimensions('<svg viewBox="0 0 300 999999999999999999999"></svg>')).toBeNull();
  });
});
