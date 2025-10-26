/**
 * api/services/pdfService.js
 *
 * Extended PDF parsing that:
 *  - extracts only academic content (trim front/back matter)
 *  - returns structured sections (title, level, content, startPage, endPage)
 *  - extracts embedded images per page (base64 PNG/JPEG) and returns them with page numbers
 *  - detects formulas:
 *      - inline LaTeX delimiters (\(...\), \[...\], $$...$$)
 *      - MathML tags
 *      - math-like unicode characters (∑, ∫, ≈, α, β, etc.) heuristically flagged
 *      - optional Mathpix OCR of images if MATHPIX_APP_ID & MATHPIX_APP_KEY env vars are set
 *
 * Usage:
 *   const { parsePdfBufferToSections } = require('./pdfService');
 *   const result = await parsePdfBufferToSections(buffer, { runMathOcr: true });
 *
 * Returns:
 *  {
 *    fullText,
 *    sections: [
 *      { title, level, content, startPage, endPage, formulas: [{source, text}], images: [{ filename, data, page, ocrText }] }
 *    ],
 *    images: [ ...all images... ],
 *    metadata: {...}
 *  }
 *
 * Notes:
 *  - Math OCR uses Mathpix by default if env vars are set. You can plug other providers by editing callMathOcrOnImage().
 *  - Image extraction in Node can be fragile depending on environment; test on Vercel and locally. I included fallback strategies.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); // using legacy build for node support
const fetch = global.fetch || require('node-fetch'); // if node < 18, node-fetch is used
const FileType = require('file-type');

const DEFAULT_MIN_SECTION_CHARS = 120;
const MAX_HEADER_FOOTER_SAMPLE_PAGES = 8;
const MATHPIX_APP_ID = process.env.MATHPIX_APP_ID;
const MATHPIX_APP_KEY = process.env.MATHPIX_APP_KEY;

/* -------------------------
 * Public function
 * ------------------------- */

async function parsePdfBufferToSections(pdfBuffer, opts = {}) {
  const minSectionChars = opts.minSectionChars || DEFAULT_MIN_SECTION_CHARS;
  const runMathOcr = !!opts.runMathOcr; // whether to run math OCR on images
  const maxMathOcrImages = opts.maxMathOcrImages || 5; // limit Mathpix calls

  // 1) Extract page-wise text using pdf-parse (fast fallback) but also get per-page content with pdfjs where available
  const pagesText = await extractPagesText(pdfBuffer);

  // 2) Normalize pages
  const cleanedPages = pagesText.map((p) => normalizePageText(p));

  // 3) Remove repeating headers/footers
  const { pagesWithoutHeaderFooter, headerFooterInfo } = removeRepeatingHeadersFooters(cleanedPages);

  // 4) Extract images per page using pdfjs (returns base64 data URIs with type detection)
  const images = await extractImagesFromPdfWithPdfjs(pdfBuffer);

  // 5) Associate images to pages (images hold page number already)
  // Note: image objects: { page, data (base64), mime, filename, bbox? }

  // 6) Trim front/back matter
  const pageObjects = pagesWithoutHeaderFooter.map((t, idx) => ({ page: idx + 1, text: t }));
  const trimmedPages = removeFrontAndBackMatter(pageObjects);

  // 7) Extract inline formulas from text and mark pages containing math-like content
  const pagesWithFormulas = trimmedPages.map((p) => {
    const inlineFormulas = extractInlineFormulasFromText(p.text);
    const mathLikeSnippets = detectMathLikeTextSnippets(p.text);
    return { ...p, inlineFormulas, mathLikeSnippets };
  });

  // 8) Run optional Math OCR on images that are likely to contain equations (limit by maxMathOcrImages)
  const imagesToOcr = images.filter(img => looksLikeMathImage(img) || /* user asked to OCR all */ runMathOcr)
                            .slice(0, maxMathOcrImages);

  // If Mathpix keys are set and runMathOcr true (or heuristics), call math OCR
  if ((MATHPIX_APP_ID && MATHPIX_APP_KEY) && imagesToOcr.length > 0) {
    await Promise.all(imagesToOcr.map(async (img) => {
      try {
        const ocrText = await callMathOcrOnImage(img.data); // text or latex from Mathpix
        img.ocrText = ocrText || null;
      } catch (err) {
        img.ocrError = String(err.message || err);
      }
    }));
  }

  // 9) Map images back to trimmed pages (some pages were removed; ensure page matches)
  // We will only attach images that fall within kept page range
  const keptPageNumbers = new Set(trimmedPages.map(p => p.page));
  const imagesKept = images.filter(img => keptPageNumbers.has(img.page));

  // 10) Build sections by heading detection, and include formulas/images per section
  const sections = extractSectionsFromPagesWithAssets(trimmedPages, {
    minSectionChars,
    allImages: imagesKept,
  });

  // For each section, attach inline formulas & images that fall in its page range
  const sectionsWithAssets = sections.map(s => {
    const formulasFromPages = pagesWithFormulas
      .filter(p => p.page >= s.startPage && p.page <= s.endPage)
      .flatMap(p => (p.inlineFormulas || []).map(f => ({ ...f, page: p.page })))
      .concat(
        pagesWithFormulas
        .filter(p => p.page >= s.startPage && p.page <= s.endPage)
        .flatMap(p => (p.mathLikeSnippets || []).map(m => ({ source: 'math-like-text', text: m, page: p.page })))
      );

    const imagesForSection = imagesKept.filter(img => img.page >= s.startPage && img.page <= s.endPage);

    return {
      ...s,
      formulas: formulasFromPages,
      images: imagesForSection,
    };
  });

  const fullText = trimmedPages.map(p => `\n\n---PAGE-${p.page}---\n\n${p.text}`).join('\n').trim();

  const metadata = {
    numpages: pagesText.length,
    headerFooterInfo,
    imagesExtracted: images.length,
  };

  return {
    fullText,
    sections: sectionsWithAssets,
    images: imagesKept,
    metadata,
  };
}

/* -------------------------
 * Text extraction (pdf-parse fallback)
 * ------------------------- */

async function extractPagesText(pdfBuffer) {
  // Use pdf-parse to get text and split by form feeds if possible
  const data = await pdfParse(pdfBuffer);
  if (typeof data.text === 'string') {
    const rawPages = data.text.split('\f').map(s => s.replace(/\r\n/g, '\n').trim());
    const cleaned = rawPages.filter((p) => p && p.length > 0);
    if (cleaned.length > 0) return cleaned;
    // If split found empty, try to approximate by numpages
    if (data.numpages && data.numpages > 0) {
      return splitTextByApproxPages(String(data.text || ''), data.numpages);
    }
    return [String(data.text || '').trim()];
  }
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
 * Normalize & header/footer removal
 * ------------------------- */

function normalizePageText(pageText) {
  if (!pageText) return '';
  const lines = pageText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.join('\n');
}

function removeRepeatingHeadersFooters(pages) {
  const sampleCount = Math.min(pages.length, MAX_HEADER_FOOTER_SAMPLE_PAGES);
  const headerCandidates = {};
  const footerCandidates = {};

  for (let i = 0; i < sampleCount; i++) {
    const text = pages[i] || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const top = lines.slice(0, 2);
    const bottom = lines.slice(-2);
    top.forEach(l => headerCandidates[l] = (headerCandidates[l] || 0) + 1);
    bottom.forEach(l => footerCandidates[l] = (footerCandidates[l] || 0) + 1);
  }

  const headerThreshold = Math.max(1, Math.floor(sampleCount * 0.5));
  const headers = Object.entries(headerCandidates)
    .filter(([line, count]) => count >= headerThreshold && isLikelyHeaderFooter(line))
    .map(([line]) => line);
  const footers = Object.entries(footerCandidates)
    .filter(([line, count]) => count >= headerThreshold && isLikelyHeaderFooter(line))
    .map(([line]) => line);

  const pagesWithoutHeaderFooter = pages.map((text) => {
    const lines = text.split('\n').map(l => l.trim());
    while (lines.length && headers.includes(lines[0])) lines.shift();
    while (lines.length && footers.includes(lines[lines.length - 1])) lines.pop();
    return lines.join('\n').trim();
  });

  return {
    pagesWithoutHeaderFooter,
    headerFooterInfo: { headers, footers },
  };
}

function isLikelyHeaderFooter(line) {
  if (!line || line.length < 3) return false;
  if (line.length > 120) return false;
  const lower = line.toLowerCase();
  if (/\bpage\b/.test(lower) || /\bchapter\b/.test(lower) || /\bcontents\b/.test(lower)) return true;
  if (/\bpublisher\b|\bpress\b|\buniversity\b|\bdepartment\b/.test(lower)) return true;
  if (/\d{1,4}$/.test(line.trim())) return true;
  return false;
}

/* -------------------------
 * Image extraction via pdfjs-dist
 * ------------------------- */

async function extractImagesFromPdfWithPdfjs(pdfBuffer) {
  // Returns array: { page, data: <base64 string prefixed with data:mime;base64,>, mime, filename, width?, height?, bbox? }
  const images = [];
  try {
    // Load document
    const loadingTask = pdfjsLib.getDocument({
      data: pdfBuffer,
      // disableFontFace: true,
      // verbosity: 0,
    });
    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    for (let p = 1; p <= numPages; p++) {
      try {
        const page = await doc.getPage(p);

        // getOperatorList + paint server to capture images is non-trivial in Node.
        // A pragmatic approach: render page to a PNG via canvas and crop potential images — but that's heavy.
        // Instead we attempt to inspect resources (XObjects) if available (may work for many PDFs).
        // pdfjs exposes page.objs and page.commonObjs but not a direct XObject list; we will use getOperatorList and inspect ops.
        const opList = await page.getOperatorList();
        const fnArray = opList.fnArray || opList.fnArray || [];
        const argsArray = opList.argsArray || [];

        // Inspect ops for images (paintImageXObject, paintJpegXObject)
        for (let i = 0; i < fnArray.length; i++) {
          const fn = fnArray[i];
          const args = argsArray[i] || [];
          // op codes: 84 = paintImageXObject, 85=paintInlineImageXObject, 101=paintJpegXObject (these numbers come from pdf.js internals)
          // We'll check for presence of image data objects in args
          if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject || fn === pdfjsLib.OPS.paintJpegXObject) {
            try {
              // Render the image via page.objs; pdfjs stores image streams under page.objs
              // The args may include a name referencing page.objs - try to extract
              const name = args && args[0] && args[0].name ? args[0].name : null;
              let imageObj = null;
              if (name && page.objs && page.objs.get) {
                imageObj = page.objs.get(name);
              }
              if (!imageObj && args && args[0]) {
                imageObj = args[0];
              }
              if (imageObj && imageObj.data) {
                // imageObj may have 'data' (typed array), width, height
                const typed = Buffer.from(imageObj.data);
                // Try to detect file type
                const ft = await FileType.fromBuffer(typed).catch(() => null);
                const mime = (ft && ft.mime) || 'image/png';
                const base64 = typed.toString('base64');
                const dataUri = `data:${mime};base64,${base64}`;
                const filename = `page-${p}-img-${i}.${(ft && ft.ext) || 'png'}`;
                images.push({
                  page: p,
                  data: dataUri,
                  mime,
                  filename,
                  width: imageObj.width || null,
                  height: imageObj.height || null,
                });
              }
            } catch (err) {
              // ignore image extraction errors for this op
            }
          }
        }

        // Another approach: try page.getTextContent() and check for <img> inline? (rare)
      } catch (pageErr) {
        // ignore per-page errors
      }
    }
    // Close document
    if (doc && doc.destroy) doc.destroy();
  } catch (err) {
    // If pdfjs extraction fails, return empty images array
    // console.warn('pdfjs image extraction failed:', err);
  }

  // images may be empty. Return what we have.
  return images;
}

/* -------------------------
 * Math detection & OCR helpers
 * ------------------------- */

function extractInlineFormulasFromText(text) {
  if (!text) return [];
  const results = [];

  // 1) LaTeX inline: \( ... \), \[ ... \], $$ ... $$
  const latexPatterns = [
    { re: /\\\(([\s\S]+?)\\\)/g, delim: '\\(...\\)' },
    { re: /\\\[(.*?)\\\]/g, delim: '\\[...\\]' },
    { re: /\$\$([\s\S]+?)\$\$/g, delim: '$$...$$' },
    { re: /\$([^\$]+?)\$/g, delim: '$...$' }, // crude inline $...$
  ];
  for (const pat of latexPatterns) {
    let m;
    while ((m = pat.re.exec(text)) !== null) {
      const snippet = m[1] && m[1].trim();
      if (snippet && snippet.length > 0) {
        results.push({ source: 'latex', delim: pat.delim, text: snippet });
      }
    }
  }

  // 2) MathML fragments
  const mathmlRe = /(<math[\s\S]*?>[\s\S]*?<\/math>)/gmi;
  let mm;
  while ((mm = mathmlRe.exec(text)) !== null) {
    results.push({ source: 'mathml', text: mm[1] });
  }

  return results;
}

function detectMathLikeTextSnippets(text) {
  if (!text) return [];
  const mathChars = /[αβγδεζηθικλμνξοπρστυφχψω∑∏∫∞≈≠≤≥→←≅√≡±÷×≈]/u;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const matches = [];
  for (const l of lines) {
    if (mathChars.test(l) && l.length < 400) {
      matches.push(l);
    }
  }
  return matches;
}

function looksLikeMathImage(img) {
  // Heuristic: many equation images have small width/height and high aspect ratio, or filenames with 'equation' or 'math'
  const fname = (img.filename || '').toLowerCase();
  if (fname.includes('equation') || fname.includes('formula') || fname.includes('math')) return true;
  if (img.width && img.height) {
    const area = (img.width || 0) * (img.height || 0);
    if (area > 0 && area < 200000) return true; // small-ish images often equations (heuristic)
  }
  // If image mime is svg maybe vector equation
  if (img.mime && img.mime.includes('svg')) return true;
  return false;
}

/**
 * Call Mathpix OCR on a base64 data-uri or image bytes.
 * Requires MATHPIX_APP_ID & MATHPIX_APP_KEY in env.
 * Returns Mathpix 'text' or 'latex' result if available.
 */
async function callMathOcrOnImage(dataUriOrBase64) {
  if (!MATHPIX_APP_ID || !MATHPIX_APP_KEY) {
    throw new Error('Mathpix keys are not configured in MATHPIX_APP_ID/MATHPIX_APP_KEY');
  }
  // Mathpix expects either "src":"data:image/png;base64,...." or a public URL.
  const payload = {
    src: dataUriOrBase64,
    formats: ['text', 'latex_styled'],
    // mathpix options: math_inline_delimiters etc.
  };

  const res = await fetch('https://api.mathpix.com/v3/text', {
    method: 'POST',
    headers: {
      'app_id': MATHPIX_APP_ID,
      'app_key': MATHPIX_APP_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Mathpix API failed: ${res.status} ${txt}`);
  }
  const json = await res.json();
  // Prefer latex if present, otherwise text.
  if (json.latex_styled && json.latex_styled.trim().length) return json.latex_styled;
  if (json.text && json.text.trim().length) return json.text;
  return null;
}

/* -------------------------
 * Front/back matter & section extraction (reuse earlier heuristics)
 * ------------------------- */

function removeFrontAndBackMatter(pageObjects) {
  const pages = pageObjects.map(p => ({ page: p.page, text: p.text }));

  const startPatterns = [
    /^\s*chapter\s+1\b/im,
    /^\s*1[\.\-\s]+\b(?:introduction|overview|background)\b/im,
    /^\s*introduction\b/im,
    /^\s*foreword\b/im,
  ];

  const frontMatterIndicators = [
    /\bpreface\b/i,
    /\bforeword\b/i,
    /\backnowledg(e)?ments?\b/i,
    /\bdedication\b/i,
    /\bcopyright\b/i,
    /\babout the author\b/i,
    /\bpublisher\b/i,
    /\bimprint\b/i,
    /^\s*contents\s*$/im,
  ];

  const backMatterIndicators = [
    /\bindex\b/i,
    /\breferences\b/i,
    /\bbibliography\b/i,
    /\bendnotes\b/i,
    /\bglossary\b/i,
    /\bauthor\b.*\bbio/i,
    /\bappendix\b/i,
  ];

  let academicStartPage = null;
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].text || '';
    if (/^\s*contents\s*$/im.test(t.split('\n')[0])) {
      continue;
    }
    if (startPatterns.some((re) => re.test(t))) {
      academicStartPage = pages[i].page;
      break;
    }
    const topLines = t.split('\n').slice(0, 6).join(' ');
    if (/(^\s*\d+[\.\)]\s+\w+)/.test(topLines)) {
      academicStartPage = pages[i].page;
      break;
    }
  }

  if (!academicStartPage) {
    for (let i = 0; i < pages.length; i++) {
      const t = pages[i].text || '';
      const smallSample = t.split('\n').slice(0, 12).join(' ');
      const isFront = frontMatterIndicators.some((re) => re.test(smallSample));
      if (!isFront) {
        academicStartPage = pages[i].page;
        break;
      }
    }
  }

  let academicEndPage = pages.length;
  for (let i = pages.length - 1; i >= 0; i--) {
    const t = pages[i].text || '';
    const smallSample = t.split('\n').slice(0, 14).join(' ');
    const isBack = backMatterIndicators.some((re) => re.test(smallSample));
    if (!isBack) {
      academicEndPage = pages[i].page;
      break;
    }
  }

  if (!academicStartPage) academicStartPage = 1;
  if (!academicEndPage || academicEndPage < academicStartPage) academicEndPage = pages.length;

  const trimmed = pages
    .filter((p) => p.page >= academicStartPage && p.page <= academicEndPage)
    .map(p => ({ page: p.page, text: p.text }));

  const cleaned = trimmed.map((p) => {
    const lines = p.text.split('\n').filter(Boolean);
    const filtered = lines.filter((l) => !/^\s*(about the author|author biography|biography|acknowledg(e)?ments?)\b/i.test(l));
    return { page: p.page, text: filtered.join('\n') };
  });

  return cleaned;
}

/* -------------------------
 * Section extraction with assets
 * ------------------------- */

function extractSectionsFromPagesWithAssets(pageObjects, opts = {}) {
  const minSectionChars = opts.minSectionChars || DEFAULT_MIN_SECTION_CHARS;
  const allImages = opts.allImages || [];

  const linesWithPage = [];
  for (const p of pageObjects) {
    const lines = p.text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const l of lines) {
      linesWithPage.push({ page: p.page, line: l });
    }
  }

  // Find headings
  const candidates = [];
  for (let i = 0; i < linesWithPage.length; i++) {
    const { line, page } = linesWithPage[i];
    const headingMatch = detectHeading(line);
    if (headingMatch) {
      candidates.push({ index: i, line, page, ...headingMatch });
    }
  }

  if (candidates.length === 0) {
    const whole = pageObjects.map(p => p.text).join('\n\n');
    return [{
      title: 'Full Document',
      level: 1,
      content: whole,
      startPage: pageObjects[0] ? pageObjects[0].page : 1,
      endPage: pageObjects[pageObjects.length - 1] ? pageObjects[pageObjects.length - 1].page : pageObjects.length,
    }];
  }

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

    sections.push({
      title: curr.title || curr.line,
      rawHeading: curr.line,
      level: curr.level || 1,
      content,
      startPage,
      endPage,
      images: allImages.filter(img => img.page >= startPage && img.page <= endPage),
    });
  }

  // Merge tiny sections
  const merged = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if ((sec.content || '').length < minSectionChars && i < sections.length - 1) {
      sections[i + 1].content = (sec.content + '\n\n' + sections[i + 1].content).trim();
      sections[i + 1].startPage = Math.min(sections[i + 1].startPage, sec.startPage);
      sections[i + 1].images = (sec.images || []).concat(sections[i + 1].images || []);
    } else {
      merged.push(sec);
    }
  }

  const normalized = merged.map(s => ({
    title: normalizeTitle(s.title),
    level: Math.max(1, s.level || 1),
    content: (s.content || '').replace(/\n{3,}/g, '\n\n').trim(),
    startPage: s.startPage,
    endPage: s.endPage,
    images: s.images || [],
  }));

  return normalized;
}

/* -------------------------
 * Heading detection (same heuristics)
 * ------------------------- */

function detectHeading(line) {
  if (!line || line.trim().length === 0) return null;
  const trimmed = line.trim();

  const numbered = trimmed.match(/^((?:\d+\.)+\d*|\d+)(?:\)|\.|\:)?\s+(.+)$/);
  if (numbered) {
    const numbering = numbered[1];
    const titleText = numbered[2];
    const level = (numbering.match(/\./g) || []).length + 1;
    return { title: `${numbering} ${titleText}`.trim(), level };
  }

  const chap = trimmed.match(/^\s*chapter\s+([ivx\d]+)\b\.?\s*(.*)$/i);
  if (chap) {
    const num = chap[1];
    const rest = chap[2] || '';
    const title = `Chapter ${num}` + (rest ? ' ' + rest : '');
    return { title: title.trim(), level: 1 };
  }

  const isAllCaps = /^[\p{L}\d\W\s]+$/u.test(trimmed) && trimmed.toUpperCase() === trimmed && trimmed.length > 2 && trimmed.length <= 120;
  const shortEnough = trimmed.length <= 120 && trimmed.split(' ').length <= 10;
  if (isAllCaps && shortEnough) {
    return { title: trimmed, level: 1 };
  }

  const words = trimmed.split(/\s+/);
  const titleCaseWords = words.filter(w => /^[A-Z]/.test(w));
  if (words.length <= 8 && titleCaseWords.length / Math.max(1, words.length) >= 0.6) {
    return { title: trimmed, level: 2 };
  }

  return null;
}

function normalizeTitle(t) {
  if (!t) return t;
  return t.replace(/\s+$/, '').replace(/\.+$/, '');
}

/* -------------------------
 * Exports
 * ------------------------- */

module.exports = {
  parsePdfBufferToSections,
  _internal: {
    extractPagesText,
    normalizePageText,
    removeRepeatingHeadersFooters,
    removeFrontAndBackMatter,
    extractSectionsFromPagesWithAssets,
    detectHeading,
    extractInlineFormulasFromText,
    detectMathLikeTextSnippets,
    extractImagesFromPdfWithPdfjs,
    callMathOcrOnImage,
  },
};
