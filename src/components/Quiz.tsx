import { useCallback, useEffect, useState } from 'react';
import { QuizError, shuffledOrder } from '../lib/quiz';
import { generateAndSaveQuiz } from '../lib/quizSession';
import { getQuestions } from '../lib/storage';
import type { Doc, Question, Section, Settings } from '../types';

interface Props {
  doc: Doc;
  section: Section;
  settings: Settings;
  hasNext: boolean;
  onScored: (score: { correct: number; total: number }) => void;
  onReread: (slower: boolean) => void;
  onNext: () => void;
  onExit: () => void;
}

type Status = 'loading' | 'generating' | 'failed' | 'answering' | 'results';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function Quiz({ doc, section, settings, hasNext, onScored, onReread, onNext, onExit }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [questions, setQuestions] = useState<Question[]>([]);
  /** For each question, the order its options are displayed in. */
  const [orders, setOrders] = useState<number[][]>([]);
  /** For each question, the chosen option (index into question.options). */
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [error, setError] = useState<QuizError | null>(null);
  const [slower, setSlower] = useState(true);

  const begin = useCallback((list: Question[]) => {
    setQuestions(list);
    setOrders(list.map((q) => shuffledOrder(q.options.length)));
    setAnswers(list.map(() => null));
    setStatus('answering');
  }, []);

  const generate = useCallback(async () => {
    setStatus('generating');
    setError(null);
    try {
      begin(await generateAndSaveQuiz(doc, section, settings.questionsPerQuiz));
    } catch (err) {
      setError(
        err instanceof QuizError ? err : new QuizError('api', 'Something went wrong while creating the quiz.'),
      );
      setStatus('failed');
    }
  }, [begin, doc, section, settings.questionsPerQuiz]);

  // Use the saved quiz for this section if there is one; otherwise write one.
  useEffect(() => {
    let cancelled = false;
    void getQuestions(section.id)
      .catch(() => [] as Question[])
      .then((saved) => {
        if (cancelled) return;
        if (saved.length > 0) begin(saved);
        else void generate();
      });
    return () => {
      cancelled = true;
    };
    // Deliberately runs once per mounted quiz; the parent remounts it for a retake.
  }, [section.id]);

  function regenerate() {
    const ok = window.confirm(
      'Replace this section\'s questions with new ones? The flashcards for the current questions, and their study progress, will be deleted.',
    );
    if (ok) void generate();
  }

  if (status === 'loading') return <p className="muted">Loading quiz…</p>;

  if (status === 'generating') {
    return (
      <div className="card" role="status">
        <h2>Writing your quiz…</h2>
        <p className="muted">Claude is reading the section. This usually takes a few seconds.</p>
        <div className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (status === 'failed' && error) {
    return (
      <div className="card">
        <h2>The quiz could not be created</h2>
        <p className="notice error" role="alert">
          {error.message}
        </p>
        {error.kind === 'no-key' && (
          <p className="muted">
            Running locally: add <code>ANTHROPIC_API_KEY=…</code> to a file named <code>.env.local</code> in the
            project folder, then try again. Deployed: store the key in the Secrets Manager secret named in the README.
          </p>
        )}
        <div className="row wrap">
          <button className="primary" onClick={() => void generate()}>
            Try again
          </button>
          {hasNext && <button onClick={onNext}>Skip to next section</button>}
          <button onClick={onExit}>Back to sections</button>
        </div>
      </div>
    );
  }

  const allAnswered = answers.every((a) => a !== null);

  if (status === 'answering') {
    return (
      <form
        className="quiz"
        onSubmit={(e) => {
          e.preventDefault();
          if (!allAnswered) return;
          const correct = questions.filter((q, i) => answers[i] === q.correctIndex).length;
          onScored({ correct, total: questions.length });
          setStatus('results');
          window.scrollTo({ top: 0 });
        }}
      >
        <h2>Quiz</h2>
        {questions.map((q, qi) => (
          <fieldset key={q.id} className="question">
            <legend>
              {qi + 1}. {q.question}
            </legend>
            {orders[qi].map((optionIndex, position) => (
              <label key={optionIndex} className={answers[qi] === optionIndex ? 'option selected' : 'option'}>
                <input
                  type="radio"
                  name={q.id}
                  checked={answers[qi] === optionIndex}
                  onChange={() => setAnswers((a) => a.map((v, i) => (i === qi ? optionIndex : v)))}
                />
                <span className="option-letter">{LETTERS[position]}</span>
                <span>{q.options[optionIndex]}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <div className="row wrap">
          <button className="primary" type="submit" disabled={!allAnswered}>
            Check answers
          </button>
          {!allAnswered && (
            <span className="muted">
              {answers.filter((a) => a !== null).length} of {questions.length} answered
            </span>
          )}
        </div>
      </form>
    );
  }

  // Results
  const wrong = questions.map((q, i) => ({ q, i })).filter(({ q, i }) => answers[i] !== q.correctIndex);
  const correct = questions.length - wrong.length;

  return (
    <div className="quiz">
      <h2>
        You got {correct} of {questions.length} right
      </h2>

      {wrong.length === 0 ? (
        <p className="notice good">All correct. These questions are now in your study deck.</p>
      ) : (
        <>
          <p>
            {wrong.length === 1 ? 'This is the question you missed:' : 'These are the questions you missed:'}
          </p>
          <ol className="plain-list">
            {wrong.map(({ q, i }) => (
              <li key={q.id} className="card missed">
                <strong>
                  {i + 1}. {q.question}
                </strong>
                <p>
                  <span className="mark bad">✗ Your answer:</span> {q.options[answers[i] ?? 0]}
                </p>
                <p>
                  <span className="mark ok">✓ Correct answer:</span> {q.options[q.correctIndex]}
                </p>
                <p className="muted">{q.explanation}</p>
              </li>
            ))}
          </ol>

          <div className="card">
            <h2>Read the section again?</h2>
            <label className="check">
              <input type="checkbox" checked={slower} onChange={(e) => setSlower(e.target.checked)} />
              Slow down to {Math.round(settings.rereadFactor * 100)}% speed
            </label>
            <button className="primary" onClick={() => onReread(slower)}>
              Re-read this section
            </button>
          </div>
        </>
      )}

      <div className="row wrap">
        {hasNext && (
          <button className={wrong.length === 0 ? 'primary' : ''} onClick={onNext}>
            Next section
          </button>
        )}
        <button onClick={onExit}>Back to sections</button>
        <button onClick={regenerate}>New questions</button>
      </div>
    </div>
  );
}
