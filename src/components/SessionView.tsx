import { useCallback, useEffect, useState } from 'react';
import { WPM_STEP, clampWpm } from '../lib/rsvp';
import { getDoc, getProgress, getSections, putSection, saveProgress } from '../lib/storage';
import type { Doc, Section, Settings } from '../types';
import { PagePreview, useDocSource } from './PagePreview';
import { Quiz } from './Quiz';
import { Reader } from './Reader';

interface Props {
  docId: string;
  sectionIndex: number;
  settings: Settings;
  onWpmChange: (wpm: number) => void;
  onGoToSection: (sectionIndex: number) => void;
  onExit: () => void;
}

/**
 * One section's flow: read → quiz → (if something was missed) re-read →
 * offer to retake the quiz. A skipped section goes read → 'no-quiz' instead.
 */
type Phase = 'read' | 'quiz' | 'no-quiz' | 'reread' | 'reread-done';

export function SessionView({
  docId,
  sectionIndex,
  settings,
  onWpmChange,
  onGoToSection,
  onExit,
}: Props) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('read');
  const [quizAttempt, setQuizAttempt] = useState(0);
  const [rereadWpm, setRereadWpm] = useState(settings.wpm);
  /** Word to resume at, loaded with the section. */
  const [resumeAt, setResumeAt] = useState(0);
  const [readerKey, setReaderKey] = useState(0);
  const source = useDocSource(docId);
  /** The word the reader is showing, for the page preview. */
  const [word, setWord] = useState(0);
  const [pauseSignal, setPauseSignal] = useState(0);
  const pauseReader = useCallback(() => setPauseSignal((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getDoc(docId), getSections(docId)])
      .then(async ([d, s]) => {
        if (!d || s.length === 0) {
          if (!cancelled) setFailed(true);
          return;
        }
        const current = s[Math.min(sectionIndex, s.length - 1)];
        const progress = await getProgress(current.id).catch(() => undefined);
        if (cancelled) return;
        // Resume only if the saved position still fits the section's text.
        if (progress && progress.index > 0 && progress.total === current.wordCount) {
          setResumeAt(progress.index);
          setWord(progress.index);
        }
        setDoc(d);
        setSections(s);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [docId, sectionIndex]);

  if (failed) {
    return (
      <section>
        <p className="notice error">This text could not be loaded.</p>
        <button onClick={onExit}>Back</button>
      </section>
    );
  }
  if (!doc || !sections) return <p className="muted">Loading…</p>;

  const section = sections[Math.min(sectionIndex, sections.length - 1)];
  const hasNext = section.index < sections.length - 1;

  function saveSection(patch: Partial<Section>) {
    const updated = { ...section, ...patch };
    setSections((list) => list?.map((s) => (s.id === updated.id ? updated : s)) ?? null);
    void putSection(updated);
  }

  function finishReading() {
    if (!section.readAt) saveSection({ readAt: Date.now() });
    setPhase(section.skipped ? 'no-quiz' : 'quiz');
  }

  function setSkipped(skipped: boolean) {
    saveSection({ skipped });
    if (skipped && phase === 'quiz') setPhase('no-quiz');
  }

  function startReread(slower: boolean) {
    // Round to the slider's step so the speed control shows a tidy number.
    const slow = Math.round((settings.wpm * settings.rereadFactor) / WPM_STEP) * WPM_STEP;
    setRereadWpm(clampWpm(slower ? slow : settings.wpm));
    setPhase('reread');
  }

  return (
    <section>
      <button className="link" onClick={onExit}>
        ← {doc.title}
      </button>
      <div className="session-head">
        <div className="grow">
          <h1 className="session-title">
            <span className="muted">
              Section {section.index + 1} of {sections.length}
              {phase === 'reread' && ' · re-reading'}
            </span>
            {section.title}
          </h1>
          <p className="skip-status">
            {section.skipped ? (
              <>
                <span className="badge skip">Skipped · no quiz</span>
                <button className="link" onClick={() => setSkipped(false)}>
                  Include in quiz
                </button>
              </>
            ) : (
              <button className="link" onClick={() => setSkipped(true)} title="Read it, but get no quiz for it">
                Skip this section in the quiz
              </button>
            )}
          </p>
        </div>
        <PagePreview
          doc={doc}
          section={section}
          sectionCount={sections.length}
          source={source}
          word={word}
          onOpen={pauseReader}
        />
      </div>

      {phase === 'read' && (
        <>
          {resumeAt > 0 && (
            <p className="notice info resume">
              Picking up where you left off.{' '}
              <button
                className="link"
                onClick={() => {
                  setResumeAt(0);
                  setReaderKey((k) => k + 1);
                }}
              >
                Start from the beginning
              </button>
            </p>
          )}
          <Reader
            key={`${section.id}:${readerKey}`}
            text={section.text}
            wpm={clampWpm(settings.wpm)}
            onWpmChange={onWpmChange}
            onFinish={finishReading}
            initialIndex={resumeAt}
            onPosition={(index) =>
              void saveProgress({ id: section.id, docId: section.docId, index, total: section.wordCount })
            }
            onWord={setWord}
            pauseSignal={pauseSignal}
          />
          {!section.skipped && (
            <p className="skip">
              <button className="link" onClick={() => setPhase('quiz')}>
                Skip to the quiz
              </button>
            </p>
          )}
        </>
      )}

      {phase === 'reread' && (
        <Reader
          key={`${section.id}:reread`}
          text={section.text}
          wpm={rereadWpm}
          onWpmChange={setRereadWpm}
          onFinish={() => setPhase('reread-done')}
          onWord={setWord}
          pauseSignal={pauseSignal}
        />
      )}

      {phase === 'no-quiz' && (
        <div className="card">
          <h2>Section finished</h2>
          {section.skipped ? (
            <p>This section is skipped, so there is no quiz for it.</p>
          ) : (
            <p>This section is included in the quiz again.</p>
          )}
          <div className="row wrap">
            {hasNext && (
              <button className="primary" onClick={() => onGoToSection(section.index + 1)}>
                Next section
              </button>
            )}
            {!section.skipped && <button onClick={() => setPhase('quiz')}>Take the quiz</button>}
            <button onClick={onExit}>Back to sections</button>
          </div>
        </div>
      )}

      {phase === 'reread-done' && (
        <div className="card">
          <h2>Re-read finished</h2>
          <p>Take the quiz again to see whether it stuck?</p>
          <div className="row wrap">
            <button
              className="primary"
              onClick={() => {
                setQuizAttempt((n) => n + 1);
                setPhase('quiz');
              }}
            >
              Retake the quiz
            </button>
            {hasNext && <button onClick={() => onGoToSection(section.index + 1)}>Next section</button>}
            <button onClick={onExit}>Back to sections</button>
          </div>
        </div>
      )}

      {phase === 'quiz' && (
        <Quiz
          key={`${section.id}:${quizAttempt}`}
          doc={doc}
          section={section}
          settings={settings}
          hasNext={hasNext}
          onScored={(score) => saveSection({ lastScore: { ...score, at: Date.now() } })}
          onReread={startReread}
          onNext={() => onGoToSection(section.index + 1)}
          onExit={onExit}
        />
      )}
    </section>
  );
}
