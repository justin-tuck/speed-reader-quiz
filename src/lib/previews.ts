/**
 * Adds page previews to a text imported before they existed, or in another
 * browser: stores the original PDF or a fresh snapshot of the web page, and
 * works out which page each section is on.
 */
import type { Doc } from '../types';
import { ExtractError, extractFromPdfFile, extractFromUrl, type Extracted } from './extract';
import { mapSectionsToPages, matchShare } from './pageMap';
import { getSections, putSections, saveSource } from './storage';

/** At least this share of the sections must be found in a PDF for it to count as the text's original. */
const MIN_MATCH = 0.5;

async function attach(doc: Doc, extracted: Extracted): Promise<void> {
  if (!extracted.original) throw new ExtractError('No page previews could be made from that source.');
  if (extracted.pages) {
    // Read again here, so a change made since the list was loaded is not overwritten.
    const sections = await getSections(doc.id);
    const texts = sections.map((s) => s.text);
    if (matchShare(extracted.pages, texts) < MIN_MATCH) {
      throw new ExtractError(`This PDF does not match "${doc.title}". Choose the file the text was imported from.`);
    }
    const starts = mapSectionsToPages(extracted.pages, texts);
    await putSections(sections.map((s, i) => ({ ...s, pageStarts: starts[i] })));
  }
  await saveSource({ ...extracted.original, id: doc.id });
}

export async function attachPdfFile(doc: Doc, file: File): Promise<void> {
  await attach(doc, await extractFromPdfFile(file));
}

/** Fetches the page again. It may have changed since it was imported. */
export async function refetchPage(doc: Doc): Promise<void> {
  if (!doc.sourceRef) throw new ExtractError('The address this text came from is not known.');
  await attach(doc, await extractFromUrl(doc.sourceRef));
}
