import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { m } from '@paraglide/messages.js';
import { DiagramEmbed, isDiagramEmbed } from './diagram-embed';

afterEach(() => {
  cleanup();
});

/**
 * feature-plugin-renderer-mermaid spec §9 — `isDiagramEmbed` is the shared
 * predicate `page-content.tsx` / `MarkdownPreview.tsx` use to decide
 * whether a server-rendered `<img>` / `<div>` gets the click-to-enlarge /
 * dark-mode-neutral-face treatment. Both PlantUML (`diagram-embed
 * plantuml-embed`) and Mermaid (`diagram-embed mermaid-embed`) opt in;
 * an error placeholder (no `diagram-embed` marker, spec §9's
 * "エラー表示にはこのアフォーダンスは付かない") must not.
 */
describe('isDiagramEmbed', () => {
  it('is true for the PlantUML success marker', () => {
    expect(isDiagramEmbed('diagram-embed plantuml-embed')).toBe(true);
  });

  it('is true for the Mermaid success marker', () => {
    expect(isDiagramEmbed('diagram-embed mermaid-embed')).toBe(true);
  });

  it('is false for a class list with no diagram-embed marker at all', () => {
    expect(isDiagramEmbed('plantuml-embed')).toBe(false);
    expect(isDiagramEmbed('mermaid-embed')).toBe(false);
  });

  // spec §9 AC — an error-only class list (no `diagram-embed`) must not
  // enter the zoom dialog / white-canvas treatment: a short "could not be
  // rendered" status message has nothing worth enlarging, and the dialog's
  // hard-coded white background would look broken against it in dark mode.
  it('is false for the Mermaid error placeholder marker (mermaid-embed mermaid-error, no diagram-embed)', () => {
    expect(isDiagramEmbed('mermaid-embed mermaid-error')).toBe(false);
  });

  // Defensive: even if a future renderer's error class somehow shipped
  // alongside `diagram-embed`, the `-error` suffix check excludes it
  // independently of the "error placeholders never carry diagram-embed"
  // invariant holding elsewhere.
  it('is false when diagram-embed co-occurs with an *-error class', () => {
    expect(isDiagramEmbed('diagram-embed mermaid-embed mermaid-error')).toBe(false);
  });

  it('is false for a non-string className (unknown from hast-util-to-jsx-runtime)', () => {
    expect(isDiagramEmbed(undefined)).toBe(false);
    expect(isDiagramEmbed(42)).toBe(false);
    expect(isDiagramEmbed(null)).toBe(false);
  });
});

describe('DiagramEmbed', () => {
  it('renders the diagram body and reveals a zoom affordance whose click opens a dialog with the same content', () => {
    render(
      <DiagramEmbed className="diagram-embed mermaid-embed">
        <img alt="Mermaid diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+" />
      </DiagramEmbed>,
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
      <DiagramEmbed className="diagram-embed plantuml-embed">
        <svg />
      </DiagramEmbed>,
    );
    const wrapper = container.querySelector('span');
    expect(wrapper?.className).toContain('diagram-embed');
    expect(wrapper?.className).toContain('plantuml-embed');
  });
});
