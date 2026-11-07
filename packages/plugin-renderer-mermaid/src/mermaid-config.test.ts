import { MERMAID_INIT_CONFIG } from './mermaid-config';

describe('MERMAID_INIT_CONFIG', () => {
  it('pins the dagre layout and the classic look so Mermaid 12 keeps existing diagrams unchanged', () => {
    expect(MERMAID_INIT_CONFIG.layout).toBe('dagre');
    expect(MERMAID_INIT_CONFIG.look).toBe('classic');
  });

  it('keeps the host-forced security and rendering settings', () => {
    expect(MERMAID_INIT_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_INIT_CONFIG.htmlLabels).toBe(false);
    expect(MERMAID_INIT_CONFIG.flowchart.htmlLabels).toBe(false);
    expect(MERMAID_INIT_CONFIG.theme).toBe('base');
  });
});
