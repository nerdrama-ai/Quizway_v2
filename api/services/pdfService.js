/**
 * api/services/pdfService.js
 *
 * Improved PDF parsing for Quizway:
 * - Extracts only academic content and removes common non-academic front/back matter.
 * - Detects main topics and subtopics (heading detection with nesting).
 * - Removes repeating headers/footers using page-wise comparison heuristics.
 *
 * Usage:
 *   const fs = require('fs');
 *   const { parsePdfBufferToSections } = require('./pdfService');
 *   const buf = fs.readFileSync('/tmp/uploaded.pdf');
 *   const result = await parsePdfBufferToSections(buf);
 *
 * Result:
 *   {
 *     fullText: '... cleaned full text ...',
 *     sections: [
 *       { title: '1 Introduction', level: 1, content: '...', startPage: 1, endPage: 2 },
 *       { title: '1.1 Motivation', level: 2, content: '...', startPage: 2, endPage: 2 },
 *       ...
 *     ],
 *     metadata: { info: {...}, numpages: X }
 *   }
 */

const pdf = require('pdf-parse');

const DEFAULT_MIN_SECTION_CHARS = 120; // minimum content length to keep a section
const MAX_HEADER_FOOTER_SAMPLE_PAGES = 8; // pages to sample when detecting repeating header/footer

/**
 * Top-level function to call from the upload route.
 * @param {Buffer} pdfBuffer
 * @param {Object} [opts]
 * @param {number} [opts.minSectionChars]
 * @returns {Promise<Object>}
 */
async function parsePdfBufferToSections(pdfBuffer, opts = {}) {
  const minSectionChars = opts.minSectionChars || DEFAULT_MIN_SECTION_CHARS;

  // Use pdf-parse to get page-wise text by using the 'pagerender' option
  const pages = await extractPagesText(pdfBuffer);

  // Clean pages: remove line breaks that are within paragraphs and preserve headings/numbered lines
  const cleanedPages = pages.map((p) => normalizePageText(p));

  // Detect and remove repeating headers/footers (common lines across pages)
  const { pagesWithoutHeaderFooter, headerFooterInfo } = removeRepeatingHeadersFooters(cleanedPages);

  // Join pages with page boundaries so we can still map content to pages
  const pageObjects = pagesWithoutHeaderFooter.map((text, idx) => ({
    page: idx + 1,
    text: text.trim(),
  }));

  // Remove front/back matter heuristically (preface, copyrights, author bios, dedications, index)
  const trimmedPages = removeFrontAndBackMatter(pageObjects);

  // Build full cleaned text
  const fullText = trimmedPages.map((p) => `\n\n---PAGE-${p.page}---\n\n${p.text}`).join('\n').trim();

  // Extract sections by detecting headings and numbering
  const sections = extractSectionsFromPages(trimmedPages, { minSectionChars });

  // Filter tiny / obviously non-academic parts
  const filteredSections = sections.filter(s => s.content && s.content.length >= 30);

  const metadata = {
    numpages: pages.length,
    headerFooterInfo,
  };

  return {
    fullText,
    sections: filteredSections,
    metadata,
  };
}

/* -------------------------
 * PDF extraction helpers
 * ------------------------- */

/**
 * Extract page-wise text from a pdf buffer using pdf-parse.
 * Returns an array where each element is the extracted text for that page (string).
 * pdf-parse doesn't expose page array in its default `.text` response, but pagerender can capture page breaks.
 *
 * This function uses pdf-parse's "pagerender" to push per-page text into results.
 */
async function extractPagesText(pdfBuffer) {
  const pages = [];
  const options = {
    pagerender: (pageData) => {
      // pageData is a PDFPageProxy-like object from pdfjs-dist; fortunately pdf-parse passes page.getTextContent()
      // For our use, pdf-parse passes pageData.getTextContent. But the safer approach is to use the default renderer
      // that returns text and then split by form feed. However the simplest and robust option: call pdf-parse
      // and then split by '\f' which is used as page delimiter in many renderers.
      // We'll fall back to splitting the aggregate text after extraction if needed.
      return pageData.getTextContent().then((content) => {
        // content.items is an array of text items, we join them with spaces respecting their transform order
        // map to strings:
        const strings = content.items.map((item) => item.str || '');
        return strings.join(' ');
      });
    },
  };

  // Run pdf-parse
  const data = await pdf(pdfBuffer, options);

  // pdf-parse will put all pages concatenated into data.text separated often by '\f' (form feed).
  // But some pagerender implementations may give us a single string. We'll split on form feed to be safe.
  if (typeof data.text === 'string') {
    const rawPages = data.text.split('\f').map(s => s.replace(/\r\n/g, '\n').trim());
    // Remove empty trailing pages
    const cleaned = rawPages.filter((p) => p && p.length > 0);
    if (cleaned.length > 0) return cleaned;
  }

  // As a fallback, if data.numpages and no page splitting, attempt to split by approximate page length
  if (data.numpages && data.numpages > 0 && typeof data.text === 'string') {
    const approx = splitTextByApproxPages(data.text, data.numpages);
    return approx;
  }

  // Final fallback: return the whole text as single-page array
  return [String(data.text || '').trim()];
}

function splitTextByApproxPages(text, numpages) {
  const len = text.length;
  const approxPer = Math.ceil(len / Math.max(1, numpages));
  const pages = [];
  for (let i = 0; i < numpages; i++) {
    const start = i * approxPer;
    const slice = text.slice(start, start + approxPer);
    pages.push(slice.trim());
  }
  return pages;
}

/* -------------------------
 * Cleaning & heuristics
 * ------------------------- */

/**
 * Normalize a page text: collapse excess whitespace, keep line breaks for heading detection.
 */
function normalizePageText(pageText) {
  if (!pageText) return '';
  // Trim spaces on each line, collapse multiple empty lines
  const lines = pageText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0); // remove blank lines to simplify

  // Reconstruct with single newline separation — this keeps short lines (possible headings).
  return lines.join('\n');
}

/**
 * Detect repeating headers/footers by sampling the top and bottom lines of pages.
 * If a line (or substring) repeats across a majority of pages, treat it as header/footer and remove.
 *
 * Returns:
 *  {
 *    pagesWithoutHeaderFooter: [cleaned page texts],
 *    headerFooterInfo: { headers: [...], footers: [...] }
 *  }
 */
function removeRepeatingHeadersFooters(pages) {
  const sampleCount = Math.min(pages.length, MAX_HEADER_FOOTER_SAMPLE_PAGES);
  const headerCandidates = {};
  const footerCandidates = {};

  // collect top/bottom lines from sampled pages
  for (let i = 0; i < sampleCount; i++) {
    const text = pages[i] || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // take top 2 lines as header candidates, bottom 2 as footer candidates
    const top = lines.slice(0, 2);
    const bottom = lines.slice(-2);
    top.forEach(l => headerCandidates[l] = (headerCandidates[l] || 0) + 1);
    bottom.forEach(l => footerCandidates[l] = (footerCandidates[l] || 0) + 1);
  }

  // choose those that appear in >50% of sampled pages
  const headerThreshold = Math.max(1, Math.floor(sampleCount * 0.5));
  const footerThreshold = headerThreshold;

  const headers = Object.entries(headerCandidates)
    .filter(([line, count]) => count >= headerThreshold && isLikelyHeaderFooter(line))
    .map(([line]) => line);
  const footers = Object.entries(footerCandidates)
    .filter(([line, count]) => count >= footerThreshold && isLikelyHeaderFooter(line))
    .map(([line]) => line);

  // Remove any exact matching header/footer lines from every page (top/bottom)
  const pagesWithoutHeaderFooter = pages.map((text) => {
    const lines = text.split('\n').map(l => l.trim());
    // remove matching headers at start
    while (lines.length && headers.includes(lines[0])) {
      lines.shift();
    }
    // remove matching footers at end
    while (lines.length && footers.includes(lines[lines.length - 1])) {
      lines.pop();
    }
    return lines.join('\n').trim();
  });

  return {
    pagesWithoutHeaderFooter,
    headerFooterInfo: { headers, footers },
  };
}

/**
 * Heuristic: header/footer lines are usually short and contain page numbers or publisher names.
 */
function isLikelyHeaderFooter(line) {
  if (!line || line.length < 3) return false;
  // exclude long content lines
  if (line.length > 120) return false;
  // if it contains 'Page', digits at end, or publisher-like words, it's likely header/footer
  const lower = line.toLowerCase();
  if (/\bpage\b/.test(lower) || /\bchapter\b/.test(lower) || /\bcontents\b/.test(lower)) return true;
  if (/\bpublisher\b|\bpress\b|\buniversity\b|\bdepartment\b/.test(lower)) return true;
  if (/\d{1,4}$/.test(line.trim())) return true; // ends with page number
  return false;
}

/* -------------------------
 * Remove front/back matter heuristics
 * ------------------------- */

/**
 * Remove front matter (preface, dedication, copyright, about the author, table of contents if desired)
 * and back matter (index, bibliography endnotes, author bios).
 *
 * We look for common section titles and drop content before and after main academic body.
 */
function removeFrontAndBackMatter(pageObjects) {
  // convert to simpler structure for scanning
  const pages = pageObjects.map(p => ({ page: p.page, text: p.text }));

  // Build a big string with page markers to search for TOC/Chapter 1
  const joined = pages.map(p => `\n\n[PAGE-${p.page}]\n${p.text}`).join('\n');

  // Patterns indicating start of academic content: 'Chapter 1', 'Introduction', '1. Introduction', '1 Introduction'
  const startPatterns = [
    /^\s*chapter\s+1\b/im,
    /^\s*1[\.\-\s]+\b(?:introduction|overview|background)\b/im,
    /^\s*introduction\b/im,
    /^\s*foreword\b/im,
  ];

  // Patterns indicating front matter pages to drop if at start
  const frontMatterIndicators = [
    /\bpreface\b/i,
    /\bforeword\b/i,
    /\backnowledg(e)?ments?\b/i,
    /\bdedication\b/i,
    /\bcopyright\b/i,
    /\babout the author\b/i,
    /\bpublisher\b/i,
    /\bimprint\b/i,
    /\bcontents\b/i,
  ];

  // Patterns to indicate end/back matter
  const backMatterIndicators = [
    /\bindex\b/i,
    /\breferences\b/i,
    /\bbibliography\b/i,
    /\bendnotes\b/i,
    /\bglossary\b/i,
    /\bauthor\b.*\bbio/i,
  ];

  // Detect start page: first occurrence of a startPattern or a numbered chapter heading
  let academicStartPage = null;
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].text;
    if (!t) continue;
    // quick check for table-of-contents; if page is mostly 'Contents', we skip it.
    if (/^\s*contents\s*$/im.test(t.split('\n')[0])) {
      // skip table of contents page(s)
      continue;
    }
    // check start patterns
    if (startPatterns.some((re) => re.test(t))) {
      academicStartPage = pages[i].page;
      break;
    }
    // also check for heading like '1. ' at the top lines
    const topLines = t.split('\n').slice(0, 6).join(' ');
    if (/(^\s*\d+[\.\)]\s+\w+)/.test(topLines)) {
      academicStartPage = pages[i].page;
      break;
    }
  }

  // If we didn't find a start with strong heuristics, fallback: find first page that doesn't match frontMatterIndicators
  if (!academicStartPage) {
    for (let i = 0; i < pages.length; i++) {
      const t = pages[i].text;
      const smallSample = t.split('\n').slice(0, 12).join(' ');
      const isFront = frontMatterIndicators.some((re) => re.test(smallSample));
      if (!isFront) {
        academicStartPage = pages[i].page;
        break;
      }
    }
  }

  // Decide end page: find last page that is not back matter
  let academicEndPage = pages.length;
  for (let i = pages.length - 1; i >= 0; i--) {
    const t = pages[i].text;
    const smallSample = t.split('\n').slice(0, 14).join(' ');
    const isBack = backMatterIndicators.some((re) => re.test(smallSample));
    if (!isBack) {
      academicEndPage = pages[i].page;
      break;
    }
  }

  // Safety clamps
  if (!academicStartPage) academicStartPage = 1;
  if (!academicEndPage || academicEndPage < academicStartPage) academicEndPage = pages.length;

  // Trim pages outside academicStartPage..academicEndPage
  const trimmed = pages
    .filter((p) => p.page >= academicStartPage && p.page <= academicEndPage)
    .map(p => ({ page: p.page, text: p.text }));

  // Final pass: remove any lines that look like 'About the Author' mid-document (unlikely inside body).
  const cleaned = trimmed.map((p) => {
    const lines = p.text.split('\n').filter(Boolean);
    const filtered = lines.filter((l) => !/^\s*(about the author|author biography|biography|acknowledg(e)?ments?)\b/i.test(l));
    return { page: p.page, text: filtered.join('\n') };
  });

  return cleaned;
}

/* -------------------------
 * Section extraction (headings -> nested structure)
 * ------------------------- */

/**
 * Extract sections using heading detection:
 * - numbered headings like "1", "1.1", "2.3.1"
 * - lines in ALL CAPS (short) often indicate headings
 * - lines that are title-case and short
 *
 * Returns an ordered array of sections with nesting level inferred from numbering depth or heuristics.
 */
function extractSectionsFromPages(pageObjects, opts = {}) {
  const minSectionChars = opts.minSectionChars || DEFAULT_MIN_SECTION_CHARS;

  // Build an array of lines with page info
  const linesWithPage = [];
  for (const p of pageObjects) {
    const lines = p.text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const l of lines) {
      linesWithPage.push({
        page: p.page,
        line: l,
      });
    }
  }

  // Identify candidate heading lines and mark them
  const candidates = [];
  for (let i = 0; i < linesWithPage.length; i++) {
    const { line, page } = linesWithPage[i];
    const headingMatch = detectHeading(line);
    if (headingMatch) {
      candidates.push({
        index: i,
        line,
        page,
        ...headingMatch,
      });
    }
  }

  // If we found no explicit headings, attempt to create one large section per chapter by searching "Chapter" markers
  if (candidates.length === 0) {
    // Create a single section for the whole document
    const whole = pageObjects.map(p => p.text).join('\n\n');
    return [{
      title: 'Full Document',
      level: 1,
      content: whole,
      startPage: pageObjects[0] ? pageObjects[0].page : 1,
      endPage: pageObjects[pageObjects.length - 1] ? pageObjects[pageObjects.length - 1].page : pageObjects.length,
    }];
  }

  // Build sections by splitting text at each candidate heading
  const sections = [];
  for (let i = 0; i < candidates.length; i++) {
    const curr = candidates[i];
    const next = candidates[i + 1];
    const startLineIdx = curr.index;
    const endLineIdx = next ? next.index - 1 : linesWithPage.length - 1;

    const sectionLines = [];
    for (let li = startLineIdx + 1; li <= endLineIdx; li++) {
      if (linesWithPage[li]) sectionLines.push(linesWithPage[li].line);
    }
    const content = sectionLines.join('\n').trim();

    const startPage = curr.page;
    const endPage = next ? linesWithPage[next.index].page : linesWithPage[linesWithPage.length - 1].page;

    // If content is too short, we may merge with next section later
    sections.push({
      title: curr.title || curr.line,
      rawHeading: curr.line,
      level: curr.level || 1,
      content,
      startPage,
      endPage,
    });
  }

  // Merge very short sections into the next sibling to avoid noise
  const merged = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if ((sec.content || '').length < minSectionChars && i < sections.length - 1) {
      // merge into next
      sections[i + 1].content = (sec.content + '\n\n' + sections[i + 1].content).trim();
      sections[i + 1].startPage = Math.min(sections[i + 1].startPage, sec.startPage);
    } else {
      merged.push(sec);
    }
  }

  // As final cleanup, trim content and normalize titles
  const normalized = merged.map(s => ({
    title: normalizeTitle(s.title),
    level: Math.max(1, s.level || 1),
    content: (s.content || '').replace(/\n{3,}/g, '\n\n').trim(),
    startPage: s.startPage,
    endPage: s.endPage,
  }));

  return normalized;
}

/**
 * Detect if a single line looks like a heading.
 * Returns null or { title, level }.
 */
function detectHeading(line) {
  if (!line || line.trim().length === 0) return null;
  const trimmed = line.trim();

  // 1) Numbered headings: 1, 1., 1.1, 2.3.1, 1) Title
  const numbered = trimmed.match(/^((?:\d+\.)+\d*|\d+)(?:\)|\.|\:)?\s+(.+)$/);
  if (numbered) {
    const numbering = numbered[1];
    const titleText = numbered[2];
    const level = (numbering.match(/\./g) || []).length + 1;
    return { title: `${numbering} ${titleText}`.trim(), level };
  }

  // 2) "Chapter X" style
  const chap = trimmed.match(/^\s*chapter\s+([ivx\d]+)\b\.?\s*(.*)$/i);
  if (chap) {
    const num = chap[1];
    const rest = chap[2] || '';
    const title = `Chapter ${num}` + (rest ? ' ' + rest : '');
    return { title: title.trim(), level: 1 };
  }

  // 3) All caps short lines (common for headings)
  const isAllCaps = /^[\p{L}\d\W\s]+$/u.test(trimmed) && trimmed.toUpperCase() === trimmed && trimmed.length > 2 && trimmed.length <= 120;
  const shortEnough = trimmed.length <= 120 && trimmed.split(' ').length <= 10;
  if (isAllCaps && shortEnough) {
    return { title: trimmed, level: 1 };
  }

  // 4) Title-case short lines (heuristic)
  const words = trimmed.split(/\s+/);
  const titleCaseWords = words.filter(w => /^[A-Z]/.test(w));
  if (words.length <= 8 && titleCaseWords.length / Math.max(1, words.length) >= 0.6) {
    // likely a heading line
    return { title: trimmed, level: 2 };
  }

  // Not a heading
  return null;
}

function normalizeTitle(t) {
  if (!t) return t;
  // remove trailing dots
  return t.replace(/\s+$/, '').replace(/\.+$/, '');
}

/* -------------------------
 * Exports
 * ------------------------- */

module.exports = {
  parsePdfBufferToSections,
  // export internals if useful for testing
  _internal: {
    extractPagesText,
    normalizePageText,
    removeRepeatingHeadersFooters,
    removeFrontAndBackMatter,
    extractSectionsFromPages,
    detectHeading,
  },
};
