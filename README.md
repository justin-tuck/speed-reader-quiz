# Speed Reader Quiz

Speed-read a text one word at a time, take a short comprehension quiz after each section, and
review the quiz questions later as spaced-repetition flashcards. Everything runs in your browser
and is stored there.

## Setup

You need [Node.js](https://nodejs.org) 20.19 or newer.

```bash
npm install
npm run dev
```

Open the address Vite prints (normally http://localhost:5173).

To write quiz questions the app needs a Claude API key. Open **Settings**, paste your key and save.
You can create a key at https://platform.claude.com. Reading and study mode work without a key.

## Commands

| Command             | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Start the app for local use, with hot reload             |
| `npm run build`     | Type-check and build the static site into `dist/`        |
| `npm run preview`   | Serve the built site from `dist/` locally                |
| `npm test`          | Run the unit tests                                       |
| `npm run typecheck` | Type-check only                                          |

## How to use it

1. **Add a text.** Paste text, upload a PDF, or give a web page address.
2. **Review the sections.** The text is split into sections of about 300–500 words at headings
   and paragraph breaks. You can rename, edit, merge, split and remove sections, or change the
   size range and split again. Mark a section **Skip in quiz** to read it without being quizzed
   on it; front matter and reference lists are marked for you, and you can undo that. You can
   also skip or include sections later from the text's section list.
3. **Read.** Each section is shown one word at a time with the recognition-point letter in red
   at a fixed position.
4. **Take the quiz.** When a section ends, Claude writes 3–5 multiple-choice questions about it.
   If you miss any, you see the correct answers and can re-read the section (optionally slower)
   and retake the quiz.
   While you read, a thumbnail shows the page of the source you are on. Click it to see the page
   full size, with its images. Close it with the Close button, Esc or a click outside.
5. **Study.** Every quiz question becomes a flashcard. Open **Study** to review the cards that
   are due and rate each one Again, Hard, Good or Easy.

### Keyboard shortcuts

| Where  | Key       | Action                         |
| ------ | --------- | ------------------------------ |
| Reader | Space     | Play or pause                  |
| Reader | ← / →     | Back or forward one sentence   |
| Reader | ↑ / ↓     | Speed up or down by 25 wpm     |
| Reader | Home      | Back to the start              |
| Study  | Space     | Show the answer                |
| Study  | 1 2 3 4   | Again, Hard, Good, Easy        |

## Libraries

| Library                 | Used for                                                   |
| ----------------------- | ---------------------------------------------------------- |
| React, Vite, TypeScript | UI, dev server and build                                   |
| `pdfjs-dist`            | Extracting text from PDFs and drawing pages for previews   |
| `@mozilla/readability`  | Pulling the article text out of a fetched web page         |
| `idb`                   | A small typed wrapper around IndexedDB                     |
| `@anthropic-ai/sdk`     | Calling the Claude API for quiz questions                  |
| `vitest`                | Unit tests (`fake-indexeddb` stands in for the browser DB) |

There is no UI framework and no router. Styling is plain CSS in `src/styles.css`, with light and
dark themes that follow the system setting.

## Where your data lives

- Texts, sections, questions, flashcards and review history are in **IndexedDB** in your browser.
- The PDF file or web page snapshot a text was imported from is also in IndexedDB, for page
  previews. It is not synced: it stays in the browser that imported it.
- Settings, including the API key, are in **localStorage**.
- Nothing is sent anywhere except: the section text and your key to `api.anthropic.com` when a
  quiz is generated, and the page address to the site you import from.

The key is not in the source code or the build. It is readable by anyone who can use your
browser profile, so prefer a key with a spending limit.

Clearing the browser's site data for the app deletes everything. There is no export yet.

## Design notes

### Web page import

Browsers do not let one site read another site's pages unless that site allows it (CORS), and
most do not. The app tries, in order:

1. A direct fetch from the browser.
2. A small fetch helper built into the Vite dev and preview server (`server/fetchProxy.ts`). It
   runs on your machine and fetches the page for the app. This is the only server-side code. It
   requires a custom request header, so other websites open in your browser cannot use it.
3. An external CORS proxy, only if you configure one in Settings. This matters only if you host
   the built files somewhere without the helper.

If all of these fail, the app says so and offers to switch to pasting the text.

### Quiz generation

`src/lib/quiz.ts` calls the Messages API with model `claude-sonnet-5-5` and a JSON schema
(structured output), then validates the reply itself: each question needs exactly four distinct
options, a valid correct index and an explanation. A malformed reply is retried once
automatically; after that, and for any API error, you get a message and a **Try again** button.
The request also opts in to the API's server-side fallback, so if a safety classifier declines a
passage the request is retried on another model.

Only multiple choice is implemented. Grading free-text answers reliably would need another model
call per answer.

### Page previews

`src/components/PagePreview.tsx` shows a thumbnail of the current page and an expanded view. The
two kinds of source need different approaches:

- **PDF.** The file is kept in IndexedDB and pdf.js draws the page onto a canvas, so images and
  layout appear as in the PDF. When a text is saved, `src/lib/pageMap.ts` finds each section's
  text in the text of the pages and stores which page each part of the section is on, so the
  thumbnail follows the word being read. The expanded view can page through the whole PDF.
- **Web page.** A page cannot be drawn to an image in the browser, so the app stores a snapshot
  at import (`src/lib/extract/snapshot.ts`): the page's HTML with scripts removed and its
  stylesheets and images fetched through the backend and embedded. The snapshot is shown in a
  sandboxed frame, scrolled to the paragraph being read, which is outlined in red. Nothing is
  loaded from the original site when a snapshot is shown, which also keeps the site's content
  security policy unchanged.

Pasted text, and texts whose original is not on this device, show the section's text laid out
as a page instead. For a PDF or web page text without its original, the section list offers to
add it (`src/lib/previews.ts`): choose the PDF file, which is checked against the text and then
mapped to pages, or fetch the web page again.

### Skipped sections

A section marked as skipped (`Section.skipped`) can be read and previewed like any other, but
finishing it does not start a quiz, `generateAndSaveQuiz` refuses it, and Study leaves out its
flashcards. Questions it already had are kept and return if the section is included again. The
mark is part of the section, so it is saved with the text and syncs like other progress.

`src/lib/skip.ts` suggests sections that are not worth a quiz:

- a title page: a short page (60 words or fewer) among the first pages of a book;
- a copyright page: a copyright notice with "All rights reserved" or an ISBN, near the start;
- a table of contents: dot leaders, a "Contents" heading over page numbers, or entries that end
  in page numbers at a rate running text never has;
- a reference list: numbered entries like "[12] Jay Kreps: …", or a "References" heading over a
  list of years.

At import, a PDF's front pages become sections of their own, and a reference list that starts
part-way through a section is split off, so the prose before it can still be quizzed.
Suggestions are shown in the section editor, already marked as skipped. Texts imported before
suggestions existed get them in the section list, with a button to skip them all; nothing is
skipped there until you choose. A section you have decided about (`skipped` is `true` or
`false`) is not suggested again.

### Scheduling

`src/lib/scheduler.ts` is a simplified version of Anki's SM-2 variant.

| Card state            | Again                                   | Hard                                   | Good                           | Easy                              |
| --------------------- | --------------------------------------- | -------------------------------------- | ------------------------------ | --------------------------------- |
| New / learning        | Back to the 1 min step                  | Repeat the step (6 min from the first) | Next step (10 min), then 1 day | Graduate now at 4 days            |
| Review                | Lapse: ease −0.20, relearn in 10 min, interval resets to 1 day | Interval ×1.2, ease −0.15 | Interval × ease | Interval × ease × 1.3, ease +0.15 |
| Relearning            | Repeat the 10 min step                  | Repeat the step                        | Back to review                 | Back to review, one day later     |

Ease starts at 2.5 and never drops below 1.3. Review cards come due at the start of the day.
The daily queue shows due learning cards first, then due reviews, then new cards up to the daily
limit (20 by default). Unlike Anki, there is no bonus for answering an overdue card late and no
interval fuzz.

## Project structure

```
server/fetchProxy.ts        Local page fetcher (Vite plugin)
src/
  types.ts                  Shared data types
  App.tsx                   Navigation between screens
  lib/
    extract/                Text extraction: pdf.ts, url.ts, index.ts; snapshot.ts for web previews
    splitter.ts             Section splitting
    skip.ts                 Skip suggestions, and the first split of an imported text
    pageMap.ts              Which PDF page each part of a section is on
    pdfRender.ts            Draws PDF pages for previews
    previews.ts             Adds the original to a text imported without one
    rsvp.ts                 RSVP engine: tokens, recognition point, timing, playback
    quiz.ts                 Claude request, prompt, reply validation
    quizSession.ts          Generates a quiz and saves it as questions and cards
    scheduler.ts            Spaced-repetition scheduling, queue and stats
    storage.ts              IndexedDB access
    settings.ts             Settings in localStorage
    *.test.ts               Unit tests
  components/
    Library, ImportView, SectionEditor, DocView     Adding and browsing texts
    SessionView, Reader, Quiz                       Read → quiz → re-read → retake
    PagePreview                                     Page thumbnail and expanded view
    StudyView                                       Flashcard review
    SettingsView                                    API key and preferences
```

## Known limits

- Scanned PDFs (images of pages) have no text to extract; the app reports this instead of
  running OCR.
- PDFs with multiple columns, tables or footnotes may come out in an odd order. Fix them in the
  section editor or paste the text instead.
- Pages that build their content with JavaScript or need a login cannot be imported by address.
- Originals for page previews are not synced: each browser needs its own copy, added at import
  or later from the section list. Until then the preview shows the section's text.
- Skip suggestions are guesses from the text. They can miss front matter laid out unusually, and
  a section that mixes prose with references is suggested only if it is mostly references.
- A web page preview is a snapshot without scripts: up to 40 images (12 MB in total) and 12
  stylesheets are embedded. Background images, web fonts and anything a script would have added
  are missing, so some pages look plainer than the live page.
- The page shown for a PDF section is found by matching text, so it can be off by a page where
  the same words repeat or the section was heavily edited.
- PDF images in JPEG 2000 or JBIG2 format, and text in fonts the PDF does not embed, may not be
  drawn correctly.
