import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CollabSameBlockWarning } from './CollabSameBlockWarning';

afterEach(() => {
  cleanup();
});

interface Scenario {
  doc: Y.Doc;
  yText: Y.Text;
  awareness: Awareness;
  setCursor: (clientId: number, offset: number) => void;
  setUser: (clientId: number, user: { name: string }) => void;
}

/**
 * Build a Y.Doc/Awareness pair where we can drive multiple "peers"
 * by spawning additional `Awareness` instances over a transient state
 * update. y-protocols normally limits one Awareness per Y.Doc, but
 * `setLocalState` + `clientID` give us enough levers to script peers
 * via `applyAwarenessUpdate`.
 */
function setupScenario(initialText: string): Scenario {
  const doc = new Y.Doc();
  const yText = doc.getText('content');
  yText.insert(0, initialText);
  const awareness = new Awareness(doc);

  // Backdoor: directly mutate the internal states map so we don't
  // need to spin up a second Awareness instance for fake peers. The
  // hook (useAwarenessStates) only reads `getStates()` and listens
  // for `change` events, both of which y-protocols emits when we
  // manually patch states (we also `emit` the change event ourselves
  // to mirror what `applyAwarenessUpdate` would do).
  const setCursor = (clientId: number, offset: number) => {
    const rel = Y.createRelativePositionFromTypeIndex(yText, offset);
    const head = Y.relativePositionToJSON(rel);
    const states = awareness.getStates() as Map<number, Record<string, unknown>>;
    const prev = states.get(clientId) ?? {};
    states.set(clientId, { ...prev, cursor: { anchor: head, head } });
    // y-protocols Observable.emit signature
    (awareness as unknown as { emit: (name: string, args: unknown[]) => void }).emit('change', [{ added: [], updated: [clientId], removed: [] }, 'test']);
  };

  const setUser = (clientId: number, user: { name: string }) => {
    const states = awareness.getStates() as Map<number, Record<string, unknown>>;
    const prev = states.get(clientId) ?? {};
    states.set(clientId, { ...prev, user });
    (awareness as unknown as { emit: (name: string, args: unknown[]) => void }).emit('change', [{ added: [], updated: [clientId], removed: [] }, 'test']);
  };

  return { doc, yText, awareness, setCursor, setUser };
}

describe('CollabSameBlockWarning', () => {
  it('renders nothing when awareness is null', () => {
    const doc = new Y.Doc();
    const yText = doc.getText('content');
    const { container } = render(<CollabSameBlockWarning awareness={null} yText={yText} localClientId={1} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when only the local peer has a cursor', () => {
    const { yText, awareness, setCursor } = setupScenario('paragraph one\n\nparagraph two');
    act(() => {
      setCursor(awareness.clientID, 5);
    });
    const { container } = render(<CollabSameBlockWarning awareness={awareness} yText={yText} localClientId={awareness.clientID} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when peers are in different paragraphs', () => {
    const { yText, awareness, setCursor, setUser } = setupScenario('first block here\n\nsecond block here');
    const localId = awareness.clientID;
    const peerId = 9999;
    act(() => {
      setCursor(localId, 5); // first block
      setCursor(peerId, 25); // second block (past `\n\n` at offset ~16)
      setUser(peerId, { name: 'Bob' });
    });
    const { container } = render(<CollabSameBlockWarning awareness={awareness} yText={yText} localClientId={localId} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the indicator when one peer is in the same paragraph', () => {
    const { yText, awareness, setCursor, setUser } = setupScenario('hello world here\n\nsecond paragraph');
    const localId = awareness.clientID;
    const peerId = 4242;
    act(() => {
      setCursor(localId, 5);
      setCursor(peerId, 10);
      setUser(peerId, { name: 'Bob' });
    });
    const { container, getByRole } = render(<CollabSameBlockWarning awareness={awareness} yText={yText} localClientId={localId} />);
    expect(container.firstChild).not.toBeNull();
    const status = getByRole('status');
    expect(status.textContent).toContain('Bob');
  });

  it('falls back to a generic label when the peer has no name', () => {
    const { yText, awareness, setCursor } = setupScenario('hello there\n\nsecond');
    const localId = awareness.clientID;
    const peerId = 7;
    act(() => {
      setCursor(localId, 2);
      setCursor(peerId, 5);
      // No setUser — peer published only a cursor, no identity.
    });
    const { getByRole } = render(<CollabSameBlockWarning awareness={awareness} yText={yText} localClientId={localId} />);
    const status = getByRole('status');
    // Generic fallback is the value of `collab.someone`; we don't pin
    // the exact translation here, just that it's the configured
    // English string and not an empty render.
    expect(status.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('collapses 4+ peers into "and N others"', () => {
    const { yText, awareness, setCursor, setUser } = setupScenario('block one here\n\nblock two');
    const localId = awareness.clientID;
    act(() => {
      setCursor(localId, 4);
      for (let i = 1; i <= 4; i++) {
        setCursor(100 + i, 4);
        setUser(100 + i, { name: `Peer${i}` });
      }
    });
    const { getByRole } = render(<CollabSameBlockWarning awareness={awareness} yText={yText} localClientId={localId} />);
    const status = getByRole('status');
    // We don't assert the exact count word (i18n), just that the
    // truncation engaged (= one of the 4 names is dropped, replaced
    // by an "+ N others" suffix).
    const text = status.textContent ?? '';
    expect(text).toContain('Peer1');
    expect(text).toContain('Peer3');
    // 4th peer was truncated → not in the rendered text directly
    expect(text).not.toContain('Peer4');
  });
});
