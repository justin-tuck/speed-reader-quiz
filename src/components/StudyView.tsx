import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DAY,
  RATINGS,
  buildQueue,
  computeStats,
  formatInterval,
  previewIntervals,
  schedule,
} from '../lib/scheduler';
import {
  getAllCards,
  getAllQuestions,
  getAllSections,
  getReviewsSince,
  listDocs,
  newId,
  saveReview,
} from '../lib/storage';
import type { Card, Doc, Question, Rating, ReviewLog, Section, Settings } from '../types';

interface Props {
  settings: Settings;
  /** Changes when another device's changes arrive, to reload the cards. */
  dataVersion: number;
  onGoToLibrary: () => void;
}

interface Data {
  cards: Card[];
  questions: Map<string, Question>;
  docs: Doc[];
  sections: Section[];
  /** Reviews from the last 30 days. */
  reviews: ReviewLog[];
}

const RETENTION_DAYS = 30;
const RATING_LABEL: Record<Rating, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

export function StudyView({ settings, dataVersion, onGoToLibrary }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [docFilter, setDocFilter] = useState('');
  const [sectionFilter, setSectionFilter] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  // The queue is computed for this moment; it moves on after each answer.
  const [now, setNow] = useState(() => Date.now());
  const swallowSpaceUp = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const since = Date.now() - RETENTION_DAYS * DAY;
    void Promise.all([getAllCards(), getAllQuestions(), listDocs(), getAllSections(), getReviewsSince(since)])
      .then(([cards, questions, docs, sections, reviews]) => {
        if (cancelled) return;
        setData({ cards, questions: new Map(questions.map((q) => [q.id, q])), docs, sections, reviews });
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const inFilter = useCallback(
    (item: { docId: string; sectionId: string }) =>
      (!docFilter || item.docId === docFilter) && (!sectionFilter || item.sectionId === sectionFilter),
    [docFilter, sectionFilter],
  );

  const view = useMemo(() => {
    if (!data) return null;
    // Cards of skipped sections are kept, so they come back if the section is included again.
    const skipped = new Set(data.sections.filter((s) => s.skipped).map((s) => s.id));
    const cards = data.cards.filter((c) => inFilter(c) && data.questions.has(c.id) && !skipped.has(c.sectionId));
    // The new-card allowance is per day across all documents, not per filter.
    const newToday = computeStats(data.reviews, now).newToday;
    const newLeft = settings.newCardsPerDay - newToday;
    const queue = buildQueue(cards, now, newLeft);
    const stats = computeStats(data.reviews.filter(inFilter), now);
    const newWaiting = cards.filter((c) => c.state === 'new').length - queue.counts.new;
    return { cards, queue, stats, newWaiting };
  }, [data, inFilter, now, settings.newCardsPerDay]);

  const current = view?.queue.next ?? null;
  const waitingUntil = view?.queue.waitingUntil ?? null;

  // When the only cards left are in a learning step, wake up when one is due.
  useEffect(() => {
    if (current || waitingUntil === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1000, waitingUntil - Date.now() + 250));
    return () => clearTimeout(timer);
  }, [current, waitingUntil]);

  const rate = useCallback(
    (rating: Rating) => {
      if (!current) return;
      const at = Date.now();
      const next = schedule(current, rating, at);
      const log: ReviewLog = {
        id: newId(),
        cardId: current.id,
        docId: current.docId,
        sectionId: current.sectionId,
        rating,
        prevState: current.state,
        at,
      };
      setData((d) =>
        d ? { ...d, cards: d.cards.map((c) => (c.id === next.id ? next : c)), reviews: [...d.reviews, log] } : d,
      );
      setRevealed(false);
      setShowChoices(false);
      setNow(at);
      saveReview(next, log).then(
        () => setSaveError(false),
        () => setSaveError(true),
      );
    },
    [current],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !current) return;
      const target = e.target as HTMLElement;
      if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        if (target instanceof HTMLButtonElement && e.key === 'Enter') return; // the button handles it
        e.preventDefault();
        swallowSpaceUp.current = e.key === ' ';
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        rate(RATINGS[Number(e.key) - 1]);
      }
    };
    // The space that revealed the answer must not also "click" a focused button on key up.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && swallowSpaceUp.current) {
        swallowSpaceUp.current = false;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [current, revealed, rate]);

  if (loadError) return <p className="notice error">Your flashcards could not be loaded.</p>;
  if (!data || !view) return <p className="muted">Loading…</p>;

  const { queue, stats } = view;
  const question = current ? data.questions.get(current.id) : undefined;
  const docTitle = (id: string) => data.docs.find((d) => d.id === id)?.title ?? 'Deleted text';
  const sectionsWithCards = data.sections
    .filter((s) => s.docId === docFilter && !s.skipped && data.cards.some((c) => c.sectionId === s.id))
    .sort((a, b) => a.index - b.index);
  const docsWithCards = data.docs.filter((d) => data.cards.some((c) => c.docId === d.id));
  const intervals = current ? previewIntervals(current, now) : null;

  return (
    <section>
      <h1>Study</h1>

      {data.cards.length === 0 ? (
        <div className="card empty">
          <p>No flashcards yet. Read a section and take its quiz: every quiz question becomes a card here.</p>
          <button className="primary" onClick={onGoToLibrary}>
            Go to library
          </button>
        </div>
      ) : (
        <>
          <div className="row wrap end">
            <label className="filter">
              Text
              <select
                value={docFilter}
                onChange={(e) => {
                  setDocFilter(e.target.value);
                  setSectionFilter('');
                  setRevealed(false);
                  setShowChoices(false);
                }}
              >
                <option value="">All texts</option>
                {docsWithCards.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter">
              Section
              <select
                value={sectionFilter}
                disabled={!docFilter}
                onChange={(e) => {
                  setSectionFilter(e.target.value);
                  setRevealed(false);
                  setShowChoices(false);
                }}
              >
                <option value="">All sections</option>
                {sectionsWithCards.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.index + 1}. {s.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="counts" aria-label="Cards in today's queue">
            <span className="count new">
              <b>{queue.counts.new}</b> new
            </span>
            <span className="count learning">
              <b>{queue.counts.learning}</b> learning
            </span>
            <span className="count due">
              <b>{queue.counts.due}</b> due
            </span>
          </div>

          {saveError && (
            <p className="notice error" role="alert">
              Your last answer could not be saved. Check that the browser still allows this site to store data.
            </p>
          )}

          {current && question && intervals ? (
            <div className="card flashcard">
              <p className="muted source">
                {docTitle(current.docId)} › {data.sections.find((s) => s.id === current.sectionId)?.title ?? 'Section'}
              </p>
              <p className="flash-question">{question.question}</p>

              {showChoices && !revealed && (
                <ul className="choices">
                  {question.options.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              )}

              {!revealed ? (
                <div className="row wrap">
                  <button className="primary" onClick={() => setRevealed(true)}>
                    Show answer
                  </button>
                  {!showChoices && <button onClick={() => setShowChoices(true)}>Show choices</button>}
                  <span className="muted hint">Space shows the answer</span>
                </div>
              ) : (
                <>
                  <div className="answer">
                    <p className="flash-answer">{question.options[question.correctIndex]}</p>
                    <p className="muted">{question.explanation}</p>
                  </div>
                  <div className="ratings">
                    {RATINGS.map((rating, i) => (
                      <button key={rating} className={`rating ${rating}`} onClick={() => rate(rating)}>
                        <span className="rating-interval">{intervals[rating]}</span>
                        <span className="rating-label">{RATING_LABEL[rating]}</span>
                        <span className="rating-key" aria-hidden="true">
                          {i + 1}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="card empty">
              <p>
                <strong>Nothing to study right now.</strong>
              </p>
              {waitingUntil !== null && (
                <p>The next card comes back in {formatInterval(waitingUntil - now)}. This page will show it then.</p>
              )}
              {view.newWaiting > 0 && (
                <p>
                  {view.newWaiting} new {view.newWaiting === 1 ? 'card is' : 'cards are'} waiting for tomorrow (daily
                  limit of {settings.newCardsPerDay} reached; you can change it in Settings).
                </p>
              )}
            </div>
          )}

          <dl className="stats">
            <div>
              <dt>Reviewed today</dt>
              <dd>{stats.reviewedToday}</dd>
            </div>
            <div>
              <dt>Retention ({RETENTION_DAYS} days)</dt>
              <dd title="Share of review-card answers that were not Again">
                {stats.retention === null ? '—' : `${Math.round(stats.retention * 100)}%`}
              </dd>
            </div>
            <div>
              <dt>Cards</dt>
              <dd>{view.cards.length}</dd>
            </div>
          </dl>
          {stats.retention === null && (
            <p className="muted">
              Retention appears once you have answered cards that graduated to day-long intervals.
            </p>
          )}
        </>
      )}
    </section>
  );
}
