import BoringAvatar from 'boring-avatars';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import corpus from './__fixtures__/beam-avatar-corpus.json';

// The iOS app draws the same generated face with its own reimplementation
// (`CrowiBeamAvatar.swift`) rather than a rasterized SVG, and reads this same
// corpus to pin every derived number. Without THIS half of the pair the corpus
// would only prove the two ports agree with each other — it has to be anchored
// to what `boring-avatars` actually draws, which is what this file asserts.

afterEach(() => {
  cleanup();
});

/** The numeric arguments of one `transform` function, in order. */
function transformArgs(transform: string, fn: string): number[] {
  const match = new RegExp(`${fn}\\(([^)]*)\\)`).exec(transform);
  if (!match) throw new Error(`no ${fn}() in "${transform}"`);
  return match[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

function renderBeam(name: string) {
  const { container } = render(<BoringAvatar size={corpus.size} name={name} variant="beam" colors={corpus.colors} />);
  // The library nests everything the avatar draws inside one masked <g>; the
  // mask's own <rect> lives outside it.
  const group = container.querySelector('g[mask]');
  if (!group) throw new Error('no masked group');
  const [background, wrapper] = Array.from(group.children) as SVGElement[];
  const face = group.querySelector('g');
  const mouth = face?.querySelector('path');
  // Scoped to the face group — the background and the wrapper are <rect>s too.
  const eyes = Array.from(face?.querySelectorAll('rect') ?? []);
  if (!face || !mouth || eyes.length !== 2) throw new Error('unexpected beam markup');

  const wrapperTransform = wrapper.getAttribute('transform') ?? '';
  const faceTransform = face.getAttribute('transform') ?? '';
  // `M15 <y>c…` when open, `M13,<y> a…` when closed.
  const isMouthOpen = mouth.getAttribute('fill') === 'none';
  const mouthY = Number(/^M1[35][ ,](-?[\d.]+)/.exec(mouth.getAttribute('d') ?? '')?.[1]);

  return {
    wrapperColor: wrapper.getAttribute('fill'),
    faceColor: mouth.getAttribute(isMouthOpen ? 'stroke' : 'fill'),
    backgroundColor: background.getAttribute('fill'),
    wrapperTranslateX: transformArgs(wrapperTransform, 'translate')[0],
    wrapperTranslateY: transformArgs(wrapperTransform, 'translate')[1],
    wrapperRotate: transformArgs(wrapperTransform, 'rotate')[0],
    wrapperScale: transformArgs(wrapperTransform, 'scale')[0],
    isMouthOpen,
    isCircle: Number(wrapper.getAttribute('rx')) === corpus.size,
    eyeSpread: 14 - Number(eyes[0].getAttribute('x')),
    mouthSpread: mouthY - 19,
    faceRotate: transformArgs(faceTransform, 'rotate')[0],
    faceTranslateX: transformArgs(faceTransform, 'translate')[0],
    faceTranslateY: transformArgs(faceTransform, 'translate')[1],
  };
}

describe('beam avatar corpus — what boring-avatars actually draws', () => {
  it.each(corpus.cases.map((c) => [c.name || '(empty)', c] as const))('%s', (_label, expected) => {
    const { hash: _hash, name, ...geometry } = expected;
    expect(renderBeam(name)).toEqual(geometry);
  });

  it('covers the eye that the corpus only records as a spread', () => {
    // `eyeSpread` is read off the LEFT eye above; the right one is the same
    // number mirrored, and a corpus that pinned only one would miss a port
    // that placed the pair asymmetrically.
    const { container } = render(<BoringAvatar size={corpus.size} name="sotarok" variant="beam" colors={corpus.colors} />);
    const eyes = Array.from(container.querySelectorAll('g[mask] > g rect'));
    const spread = corpus.cases.find((c) => c.name === 'sotarok')?.eyeSpread;
    expect(Number(eyes[1].getAttribute('x'))).toBe(20 + spread!);
  });
});
