# Speed Reader Quiz

Speed-read a text one word at a time, take a short comprehension quiz after each section, and
review the quiz questions later as spaced-repetition flashcards. Your library is kept in your
browser and synced through a small backend, which also writes the quizzes with Claude. Run it on
your own machine, or deploy it to your own AWS account to use it from several devices.

## Setup

You need [Node.js](https://nodejs.org) 20.19 or newer.

```bash
npm install
npm run dev
```

Open the address Vite prints (normally http://localhost:5173).

To write quiz questions the backend needs a Claude API key, which you can create at
https://platform.claude.com. Copy `.env.example` to `.env.local` and put the key after
`ANTHROPIC_API_KEY=`. The dev server reads the file on every request, so there is no need to
restart it. Reading and study mode work without a key.

Running locally there is no login: everything belongs to one local user, and synced data is
written to `.local-data/sync.json`. Both `.env.local` and `.local-data/` are ignored by git. The
dev server only listens on your own machine; don't start it with `--host` on a network you don't
trust, because anyone who can reach it could use your key.

## Deploying to AWS

`infra/` is an AWS CDK app that deploys the app to your own AWS account:

- the built site in a private S3 bucket, served by CloudFront
- the backend as one Lambda function behind an API Gateway HTTP API, at `/api/*` on the same address
- sign-in with a Cognito user pool, with no public sign-up: you create the accounts
- synced data in a DynamoDB table, where each user can only read and write their own records
- the Claude API key in Secrets Manager

You need AWS credentials for the account and region you want to deploy to.

1. Store your Claude API key in Secrets Manager as a plain-text secret named
   `speed-reader-quiz/anthropic-api-key`. The stack refers to the secret only by name, so the key
   never passes through the CDK code or CloudFormation. With the AWS CLI, reading the key from a
   file keeps it out of your shell history (delete the file afterwards):

   ```bash
   aws secretsmanager create-secret --name speed-reader-quiz/anthropic-api-key \
     --secret-string file://claude-key.txt
   ```

2. Build the site, then deploy it:

   ```bash
   npm run build
   cd infra
   npm install
   npx cdk bootstrap   # once per account and region
   npm run deploy
   ```

3. Create your account. The deploy prints `SiteUrl` and `UserPoolId`.

   ```bash
   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
   ```

   Cognito emails you a temporary password. Open `SiteUrl`, sign in and choose a new password.

To update the deployed app, run `npm run build` and then `npm run deploy` in `infra/` again.

The API accepts at most 10 requests a second (bursts of 20), which also limits Claude spending;
give the key a spending limit as well. The database and user pool are kept if the stack is
deleted, and the stack has termination protection turned on.

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

- Texts, sections, questions, flashcards, review history and reading progress are in
  **IndexedDB** in your browser, so the app keeps working offline. Changes are also synced
  through the backend: to `.local-data/sync.json` when running locally, or to DynamoDB when
  deployed.
- The PDF file or web page snapshot a text was imported from is also in IndexedDB, for page
  previews. It is not synced: it stays in the browser that imported it.
- Settings (reading speed, section sizes, quiz and study options) are in **localStorage**. They
  are not synced, so each device can have its own.
- The Claude API key is only on the backend: in `.env.local` locally, or in Secrets Manager when
  deployed. It is never sent to the browser.
- When deployed, your sign-in tokens are kept in localStorage so you stay signed in between
  visits.
- The backend sends a section's text and the text's title to the Claude API when it writes a
  quiz. It also fetches the pages you import by address, with their stylesheets and images for
  the preview.

Clearing the browser's site data for the app deletes this browser's copy. Synced data is still
on the backend and comes back at the next sync. There is no export yet.

## Design notes

### Web page import

Browsers do not let one site read another site's pages unless that site allows it (CORS), and
most do not. So the app asks its own backend to fetch the page (`/api/fetch`, in
`server/core/fetchPage.ts`). Deployed, the backend only answers signed-in users. Locally, it
requires a custom request header, so other websites open in your browser cannot use it.

The fetcher only reaches public web addresses. It refuses localhost and private, link-local
and similar address ranges. It checks the address a host name resolves to at the moment it
connects, and it follows redirects one at a time so that each one is checked too. A page may be
at most 4 MB, counted after decompression, and must arrive within 15 seconds. The page is
returned to the app as data with a sandboxing content security policy, and is never shown as a
page of the app.

If the fetch fails, the app says so and suggests pasting the text instead.

### Quiz generation

The backend (`server/core/quiz.ts`) calls the Messages API with model `claude-sonnet-5-5` and a JSON schema
(structured output), then validates the reply itself: each question needs exactly four distinct
options, a valid correct index and an explanation. A malformed reply is retried once
automatically; after that, and for any API error, you get a message and a **Try again** button.
The request also opts in to the API's server-side fallback, so if a safety classifier declines a
passage the request is retried on another model.

Only multiple choice is implemented. Grading free-text answers reliably would need another model
call per answer.

### Sync

Each device keeps a queue of the records it changed, sends them to `/api/sync/push`, and then
asks `/api/sync/pull` for everything written since its last sync. This runs shortly after each
change, every minute while the app is open, and when the app comes back online or into view.
When two devices change the same record, the later change wins. Deletions are kept as markers so
they reach every device. The server limits how far ahead of its own clock a record's time may
be, so a device with a wrong clock cannot win every conflict.

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
server/
  core/                     The backend, the same locally and on AWS
    router.ts               The /api routes
    quiz.ts                 Claude request, prompt, reply validation
    fetchPage.ts            Fetches pages to import, refusing private addresses
    sync.ts                 Sync rules and record validation
  stores/                   Where synced records are kept: a local file or DynamoDB
  devPlugin.ts              Runs the backend inside the Vite dev and preview servers
  lambda.ts                 Runs the backend on AWS Lambda
  securityHeaders.ts        The site's content security policy
shared/api.ts               Request and response types shared by the app and the backend
infra/                      AWS CDK app that deploys the site and backend
src/
  types.ts                  Shared data types
  App.tsx                   Navigation between screens
  lib/
    api.ts                  Calls to the backend, with the sign-in token
    auth.ts                 Sign-in with Cognito, when deployed
    sync.ts                 Background sync with the backend
    extract/                Text extraction: pdf.ts, url.ts, index.ts; snapshot.ts for web previews
    splitter.ts             Section splitting
    skip.ts                 Skip suggestions, and the first split of an imported text
    pageMap.ts              Which PDF page each part of a section is on
    pdfRender.ts            Draws PDF pages for previews
    previews.ts             Adds the original to a text imported without one
    rsvp.ts                 RSVP engine: tokens, recognition point, timing, playback
    quiz.ts                 Asks the backend for a quiz
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
    SettingsView                                    Account, sync and preferences
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
