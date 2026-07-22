import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { m } from '@paraglide/messages.js';
import { RendererPresentation, isDiagramPresentationReady, pickRendererPresentationAttrs } from './renderer-presentation';

afterEach(() => {
  cleanup();
});

/**
 * feature-renderer-plugin-boundary spec §3.1/§3.3 — `isDiagramPresentationReady`
 * is the shared predicate `page-content.tsx` / `MarkdownPreview.tsx` use to
 * decide whether a server-rendered `<img>` / `<div>` gets the
 * click-to-enlarge / dark-mode-neutral-face treatment.
 *
 * New contract cases (`data-crowi-renderer-presentation` /
 * `data-crowi-renderer-state`) come first; the legacy `.diagram-embed` /
 * `*-error` dual-accept cases below carry over the original
 * `isDiagramEmbed` suite almost verbatim (feature-plugin-renderer-mermaid
 * spec §9) — persisted `renderedAst` from before Phase 2 has no
 * data-attribute contract at all.
 */
describe('isDiagramPresentationReady', () => {
  describe('new data-attribute contract', () => {
    it('is true for presentation="diagram" + state="ready" (kebab-case rest props)', () => {
      expect(isDiagramPresentationReady(undefined, { 'data-crowi-renderer-presentation': 'diagram', 'data-crowi-renderer-state': 'ready' })).toBe(true);
    });

    it('is true for presentation="diagram" + state="ready" (camelCase rest props — some hast-util-to-jsx-runtime versions)', () => {
      expect(isDiagramPresentationReady(undefined, { dataCrowiRendererPresentation: 'diagram', dataCrowiRendererState: 'ready' })).toBe(true);
    });

    it('is false for presentation="diagram" + state="error" — a fixed error placeholder has nothing worth enlarging', () => {
      expect(isDiagramPresentationReady(undefined, { 'data-crowi-renderer-presentation': 'diagram', 'data-crowi-renderer-state': 'error' })).toBe(false);
    });

    it('is false for presentation="diagram" with no state at all', () => {
      expect(isDiagramPresentationReady(undefined, { 'data-crowi-renderer-presentation': 'diagram' })).toBe(false);
    });

    it('is false for an unrecognised presentation kind (not "diagram"), with no className at all', () => {
      // No real producer emits this combination today (a renderer either
      // speaks the new contract or the legacy class, never a mismatched
      // mix). Only "diagram" is a real presentation kind, so any other
      // value is simply not ready.
      expect(isDiagramPresentationReady(undefined, { 'data-crowi-renderer-presentation': 'chart', 'data-crowi-renderer-state': 'ready' })).toBe(false);
    });

    it('does NOT fall through to the legacy className check when the presentation attribute is present but unrecognised', () => {
      // Even though `className` carries the legacy `diagram-embed` success
      // marker, the presence of the new attribute (with an unrecognised
      // kind) is authoritative — the legacy branch exists only to cover
      // content that predates the attribute entirely, not to rescue an
      // unrecognised kind.
      expect(isDiagramPresentationReady('diagram-embed', { 'data-crowi-renderer-presentation': 'chart', 'data-crowi-renderer-state': 'ready' })).toBe(false);
    });

    it('does NOT fall through to the legacy className check when presentation="diagram" but state is unrecognised', () => {
      expect(isDiagramPresentationReady('diagram-embed', { 'data-crowi-renderer-presentation': 'diagram', 'data-crowi-renderer-state': 'pending' })).toBe(
        false,
      );
    });
  });

  describe('legacy .diagram-embed dual-accept (no data-attribute contract present)', () => {
    it('is true for the PlantUML success marker', () => {
      expect(isDiagramPresentationReady('diagram-embed plantuml-embed', {})).toBe(true);
    });

    it('is true for the Mermaid success marker', () => {
      expect(isDiagramPresentationReady('diagram-embed mermaid-embed', {})).toBe(true);
    });

    it('is false for a class list with no diagram-embed marker at all', () => {
      expect(isDiagramPresentationReady('plantuml-embed', {})).toBe(false);
      expect(isDiagramPresentationReady('mermaid-embed', {})).toBe(false);
    });

    it('is false for the Mermaid error placeholder marker (mermaid-embed mermaid-error, no diagram-embed)', () => {
      expect(isDiagramPresentationReady('mermaid-embed mermaid-error', {})).toBe(false);
    });

    it('is false when diagram-embed co-occurs with an *-error class', () => {
      expect(isDiagramPresentationReady('diagram-embed mermaid-embed mermaid-error', {})).toBe(false);
    });

    it('is false for a non-string className (unknown from hast-util-to-jsx-runtime)', () => {
      expect(isDiagramPresentationReady(undefined, {})).toBe(false);
      expect(isDiagramPresentationReady(42, {})).toBe(false);
      expect(isDiagramPresentationReady(null, {})).toBe(false);
    });
  });
});

describe('pickRendererPresentationAttrs', () => {
  it('extracts both attributes when present (kebab-case)', () => {
    expect(pickRendererPresentationAttrs({ 'data-crowi-renderer-presentation': 'diagram', 'data-crowi-renderer-state': 'ready' })).toEqual({
      'data-crowi-renderer-presentation': 'diagram',
      'data-crowi-renderer-state': 'ready',
    });
  });

  it('extracts both attributes when present (camelCase)', () => {
    expect(pickRendererPresentationAttrs({ dataCrowiRendererPresentation: 'diagram', dataCrowiRendererState: 'error' })).toEqual({
      'data-crowi-renderer-presentation': 'diagram',
      'data-crowi-renderer-state': 'error',
    });
  });

  it('returns an empty object when neither is present (legacy markup)', () => {
    expect(pickRendererPresentationAttrs({ className: 'diagram-embed plantuml-embed' })).toEqual({});
  });
});

describe('RendererPresentation', () => {
  it('renders the diagram body and reveals a zoom affordance whose click opens a dialog with the same content', () => {
    render(
      <RendererPresentation className="diagram-embed mermaid-embed">
        <img alt="Mermaid diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+" />
      </RendererPresentation>,
    );
    // The inline diagram is present outside any dialog.
    expect(screen.getByRole('img', { name: 'Mermaid diagram (flowchart)' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    const zoomButton = screen.getByRole('button', { name: m['page.diagram_zoom']() });
    fireEvent.click(zoomButton);

    // The dialog now renders the same diagram body verbatim.
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img[alt="Mermaid diagram (flowchart)"]')).not.toBeNull();
  });

  it('carries the incoming className onto the wrapper span so shared `.diagram-embed` CSS applies regardless of renderer', () => {
    const { container } = render(
      <RendererPresentation className="diagram-embed plantuml-embed">
        <svg />
      </RendererPresentation>,
    );
    const wrapper = container.querySelector('span');
    expect(wrapper?.className).toContain('diagram-embed');
    expect(wrapper?.className).toContain('plantuml-embed');
  });

  it('carries the new data-crowi-renderer-presentation/state attributes onto the wrapper span so the CSS selector contract matches it', () => {
    const { container } = render(
      <RendererPresentation presentationAttrs={{ 'data-crowi-renderer-presentation': 'diagram', 'data-crowi-renderer-state': 'ready' }}>
        <img alt="ready diagram" src="data:image/svg+xml;base64,PHN2Zy8+" />
      </RendererPresentation>,
    );
    const wrapper = container.querySelector('span');
    expect(wrapper?.getAttribute('data-crowi-renderer-presentation')).toBe('diagram');
    expect(wrapper?.getAttribute('data-crowi-renderer-state')).toBe('ready');
  });
});
