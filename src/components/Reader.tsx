import { useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import {
  MAX_WPM,
  MIN_WPM,
  RsvpEngine,
  WPM_STEP,
  clampWpm,
  remainingMs,
  splitAtOrp,
  tokenize,
  type Token,
} from '../lib/rsvp';

interface Props {
  text: string;
  wpm: number;
  onWpmChange: (wpm: number) => void;
  onFinish: () => void;
  /** Word to start at, when resuming a section. */
  initialIndex?: number;
  /** Called now and then with the current word, so the position can be saved. 0 means finished. */
  onPosition?: (index: number) => void;
  /** Called with every word shown, so the page preview can follow along. */
  onWord?: (index: number) => void;
  /** Pauses the reader whenever this value changes. */
  pauseSignal?: number;
}

function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The sentence around the current word, shown while paused. */
function sentenceAround(tokens: Token[], index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && !tokens[start].sentenceStart) start--;
  let end = index + 1;
  while (end < tokens.length && !tokens[end].sentenceStart) end++;
  return { start, end };
}

export function Reader({
  text,
  wpm,
  onWpmChange,
  onFinish,
  initialIndex = 0,
  onPosition,
  onWord,
  pauseSignal,
}: Props) {
  const tokens = useMemo(() => tokenize(text), [text]);

  const finishRef = useRef(onFinish);
  const wpmRef = useRef(wpm);
  const positionRef = useRef(onPosition);
  const wordRef = useRef(onWord);
  useEffect(() => {
    finishRef.current = onFinish;
    wpmRef.current = wpm;
    positionRef.current = onPosition;
    wordRef.current = onWord;
  });

  // The engine is rebuilt only for new text; speed changes are synced below.
  const engine = useMemo(() => {
    const created = new RsvpEngine(tokens, wpm, () => finishRef.current());
    if (initialIndex > 0) created.seek(initialIndex);
    return created;
  }, [tokens]);

  // Report the position shortly after a pause or a skip, every few seconds
  // while playing, and when the reader closes.
  useEffect(() => {
    let last = engine.getSnapshot().index;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const snapshot = engine.getSnapshot();
      const index = snapshot.finished ? 0 : snapshot.index;
      if (index === last) return;
      last = index;
      positionRef.current?.(index);
    };
    const unsubscribe = engine.subscribe(() => {
      if (engine.getSnapshot().playing) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, 400);
    });
    const interval = setInterval(() => engine.getSnapshot().playing && report(), 5000);
    return () => {
      unsubscribe();
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      report();
    };
  }, [engine]);
  useEffect(() => {
    wordRef.current?.(engine.getSnapshot().index);
    return engine.subscribe(() => wordRef.current?.(engine.getSnapshot().index));
  }, [engine]);
  useEffect(() => engine.pause(), [engine, pauseSignal]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => engine.setWpm(wpm), [engine, wpm]);

  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  useEffect(() => {
    const changeWpm = (delta: number) => onWpmChange(clampWpm(wpmRef.current + delta));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const isSlider = target instanceof HTMLInputElement && target.type === 'range';
      const isTyping =
        (target instanceof HTMLInputElement && !isSlider) ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable;
      if (isTyping) return;
      const isArrow = e.key.startsWith('Arrow');
      if (isSlider && isArrow) return; // let the focused slider use its own arrow keys

      switch (e.key) {
        case ' ':
          engine.toggle();
          break;
        case 'ArrowLeft':
          engine.skipBack();
          break;
        case 'ArrowRight':
          engine.skipForward();
          break;
        case 'ArrowUp':
          changeWpm(WPM_STEP);
          break;
        case 'ArrowDown':
          changeWpm(-WPM_STEP);
          break;
        case 'Home':
          engine.seek(0);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    // Space on a focused button would also "click" it on key up; the shortcut wins.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [engine, onWpmChange]);

  if (tokens.length === 0) return <p className="muted">This section has no text.</p>;

  const token = tokens[snap.index];
  const { before, pivot, after } = splitAtOrp(token.text);
  const sentence = sentenceAround(tokens, snap.index);
  const untouched = snap.index === 0 && !snap.playing && !snap.finished;

  const state = snap.playing ? 'playing' : snap.finished ? 'finished' : 'paused';
  // Longer half of the word, in characters; the CSS shrinks the word if it would not fit.
  const fit = { '--fit': Math.max(before.length, after.length) } as CSSProperties;

  return (
    <div className="reader">
      <div className="rsvp-card">
        <div className="rsvp-head">
          <span className="rsvp-label">Reader</span>
          <span className={`rsvp-state ${state}`}>
            {state === 'playing' ? 'Playing' : state === 'finished' ? 'Finished' : 'Paused'}
          </span>
        </div>
        <div className="rsvp" onClick={() => engine.toggle()} title={snap.playing ? 'Click to pause' : 'Click to play'}>
          <div className="rsvp-band">
            <span className="rsvp-word" style={fit} aria-label={token.text}>
              <span className="rsvp-pivot" aria-hidden="true">
                {pivot}
                <span className="rsvp-before">{before}</span>
                <span className="rsvp-after">{after}</span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <input
        className="progress"
        type="range"
        min={0}
        max={tokens.length - 1}
        value={snap.index}
        onChange={(e) => engine.seek(Number(e.target.value))}
        aria-label="Position in section"
      />
      <div className="reader-status muted">
        <span>
          Word {snap.index + 1} of {tokens.length}
        </span>
        <span>{formatTime(remainingMs(tokens, snap.index, snap.wpm))} left</span>
      </div>

      <div className="reader-controls">
        <button onClick={() => engine.skipBack()} aria-label="Back one sentence" title="Back one sentence (←)">
          ⏮ Back
        </button>
        <button className="primary play" onClick={() => engine.toggle()} title="Play or pause (space)">
          {snap.playing ? '⏸ Pause' : snap.finished ? '↻ Restart' : '▶ Play'}
        </button>
        <button onClick={() => engine.skipForward()} aria-label="Forward one sentence" title="Forward one sentence (→)">
          Forward ⏭
        </button>
      </div>

      <div className="wpm">
        <button onClick={() => onWpmChange(clampWpm(wpm - WPM_STEP))} aria-label="Slower" title="Slower (↓)">
          −
        </button>
        <input
          type="range"
          min={MIN_WPM}
          max={MAX_WPM}
          step={WPM_STEP}
          value={wpm}
          onChange={(e) => onWpmChange(clampWpm(Number(e.target.value)))}
          aria-label="Words per minute"
        />
        <button onClick={() => onWpmChange(clampWpm(wpm + WPM_STEP))} aria-label="Faster" title="Faster (↑)">
          +
        </button>
        <span className="wpm-value">{wpm} wpm</span>
      </div>

      <div className="context" aria-live="off">
        {snap.playing ? (
          <span className="muted">Space pauses · ← → skip a sentence · ↑ ↓ change speed</span>
        ) : untouched ? (
          <span className="muted">Press space or Play to start. ← → skip a sentence, ↑ ↓ change speed.</span>
        ) : (
          tokens.slice(sentence.start, sentence.end).map((t, i) => (
            <span key={sentence.start + i} className={sentence.start + i === snap.index ? 'context-current' : ''}>
              {t.text}{' '}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
