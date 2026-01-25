#!/usr/bin/env node
/**
 * Utility to apply chapter structure to a single-chapter EPUB
 *
 * Usage: node apply-chapters.js <epub-path> <bfp-path> [output-path]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');

// Read chapters from BFP file
function loadChaptersFromBfp(bfpPath) {
  const content = fs.readFileSync(bfpPath, 'utf-8');
  const project = JSON.parse(content);
  return project.chapters || [];
}

// Extract text content from EPUB
function extractEpubText(epubPath) {
  // Create temp directory
  const tempDir = fs.mkdtempSync('/tmp/epub-');

  try {
    // Unzip EPUB
    execSync(`unzip -q "${epubPath}" -d "${tempDir}"`);

    // Find chapter file
    const oebpsDir = path.join(tempDir, 'OEBPS');
    let chapterFile;

    if (fs.existsSync(oebpsDir)) {
      const files = fs.readdirSync(oebpsDir);
      chapterFile = files.find(f => f.endsWith('.xhtml') && !f.includes('nav'));
      if (chapterFile) {
        chapterFile = path.join(oebpsDir, chapterFile);
      }
    }

    if (!chapterFile || !fs.existsSync(chapterFile)) {
      throw new Error('No chapter file found in EPUB');
    }

    const content = fs.readFileSync(chapterFile, 'utf-8');

    // Also get title from content.opf
    let title = 'Untitled';
    const opfFiles = fs.readdirSync(oebpsDir).filter(f => f.endsWith('.opf'));
    if (opfFiles.length > 0) {
      const opfContent = fs.readFileSync(path.join(oebpsDir, opfFiles[0]), 'utf-8');
      const titleMatch = opfContent.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
      if (titleMatch) {
        title = titleMatch[1];
      }
    }

    return { content, title };
  } finally {
    // Cleanup
    execSync(`rm -rf "${tempDir}"`);
  }
}

// Extract paragraphs from HTML
function extractParagraphs(html) {
  const paragraphs = [];
  const regex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    // Decode HTML entities
    let text = match[1]
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, '') // Remove any nested tags
      .trim();

    if (text) {
      paragraphs.push(text);
    }
  }

  return paragraphs;
}

// Find chapter positions in paragraphs
function findChapterPositions(paragraphs, chapters) {
  const positions = [];

  for (const chapter of chapters) {
    const normalizedTitle = chapter.title.toUpperCase().replace(/\s+/g, ' ').trim();

    for (let i = 0; i < paragraphs.length; i++) {
      const normalizedPara = paragraphs[i].toUpperCase().replace(/\s+/g, ' ').trim();

      // Exact match or paragraph that is mostly the title
      if (normalizedPara === normalizedTitle ||
          (normalizedPara.includes(normalizedTitle) && normalizedPara.length < normalizedTitle.length * 1.5)) {
        // Check if this position hasn't been assigned
        if (!positions.find(p => p.index === i)) {
          positions.push({ chapter, index: i });
          console.log(`Found "${chapter.title}" at paragraph ${i}`);
          break;
        }
      }
    }
  }

  return positions.sort((a, b) => a.index - b.index);
}

// Escape XML
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Generate chapter XHTML
function generateChapterXhtml(title, paragraphs) {
  const content = paragraphs.map(p => `  <p>${escapeXml(p)}</p>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    h1 { font-size: 1.5em; margin-bottom: 1em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
${content}
</body>
</html>`;
}

// Generate nav.xhtml
function generateNavXhtml(chapterTitles) {
  const items = chapterTitles.map((title, i) =>
    `      <li><a href="chapter${i + 1}.xhtml">${escapeXml(title)}</a></li>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

// Generate content.opf
function generateContentOpf(title, chapterTitles) {
  const manifest = chapterTitles.map((_, i) =>
    `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n');

  const spine = chapterTitles.map((_, i) =>
    `    <itemref idref="chapter${i + 1}"/>`
  ).join('\n');

  const date = new Date().toISOString().split('T')[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${generateUUID()}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`;
}

// Create EPUB file
function createEpub(outputPath, title, chapterData) {
  const tempDir = fs.mkdtempSync('/tmp/epub-out-');

  try {
    // Create directory structure
    fs.mkdirSync(path.join(tempDir, 'META-INF'));
    fs.mkdirSync(path.join(tempDir, 'OEBPS'));

    // Write mimetype (must be first, uncompressed)
    fs.writeFileSync(path.join(tempDir, 'mimetype'), 'application/epub+zip');

    // Write container.xml
    fs.writeFileSync(path.join(tempDir, 'META-INF', 'container.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    // Get chapter titles
    const chapterTitles = chapterData.map(c => c.title);

    // Write content.opf
    fs.writeFileSync(
      path.join(tempDir, 'OEBPS', 'content.opf'),
      generateContentOpf(title, chapterTitles)
    );

    // Write nav.xhtml
    fs.writeFileSync(
      path.join(tempDir, 'OEBPS', 'nav.xhtml'),
      generateNavXhtml(chapterTitles)
    );

    // Write chapter files
    chapterData.forEach((chapter, i) => {
      fs.writeFileSync(
        path.join(tempDir, 'OEBPS', `chapter${i + 1}.xhtml`),
        generateChapterXhtml(chapter.title, chapter.paragraphs)
      );
    });

    // Create EPUB (zip file)
    // Must add mimetype first, uncompressed
    execSync(`cd "${tempDir}" && zip -X0 "${outputPath}" mimetype`);
    execSync(`cd "${tempDir}" && zip -rX9 "${outputPath}" META-INF OEBPS`);

    return true;
  } finally {
    execSync(`rm -rf "${tempDir}"`);
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node apply-chapters.js <epub-path> <bfp-path> [output-path]');
    console.log('');
    console.log('This script applies chapter structure from a BookForge project file (.bfp)');
    console.log('to a single-chapter EPUB, creating a new EPUB with proper chapters.');
    process.exit(1);
  }

  const [epubPath, bfpPath, outputPath] = args;
  const finalOutputPath = outputPath || epubPath.replace('.epub', '_with_chapters.epub');

  console.log(`Loading chapters from: ${bfpPath}`);
  const chapters = loadChaptersFromBfp(bfpPath);

  if (chapters.length === 0) {
    console.error('No chapters found in project file');
    process.exit(1);
  }

  console.log(`Found ${chapters.length} chapters in project`);

  console.log(`\nExtracting text from: ${epubPath}`);
  const { content, title } = extractEpubText(epubPath);

  console.log(`Book title: ${title}`);

  const paragraphs = extractParagraphs(content);
  console.log(`Extracted ${paragraphs.length} paragraphs`);

  console.log(`\nSearching for chapter markers...`);
  const positions = findChapterPositions(paragraphs, chapters);

  if (positions.length === 0) {
    console.error('Could not find any chapter markers in the text');
    console.log('\nChapter titles being searched for:');
    chapters.forEach(c => console.log(`  - "${c.title}"`));
    process.exit(1);
  }

  console.log(`Found ${positions.length} of ${chapters.length} chapters`);

  // Build chapter data
  const chapterData = [];

  // Add introduction (content before first chapter)
  if (positions[0].index > 0) {
    chapterData.push({
      title: 'Introduction',
      paragraphs: paragraphs.slice(0, positions[0].index)
    });
  }

  // Add each chapter
  for (let i = 0; i < positions.length; i++) {
    const startIndex = positions[i].index + 1; // Skip title paragraph
    const endIndex = i < positions.length - 1 ? positions[i + 1].index : paragraphs.length;

    chapterData.push({
      title: positions[i].chapter.title,
      paragraphs: paragraphs.slice(startIndex, endIndex)
    });
  }

  console.log(`\nCreating EPUB with ${chapterData.length} chapters...`);

  createEpub(finalOutputPath, title, chapterData);

  console.log(`\nSuccess! Created: ${finalOutputPath}`);
  console.log(`\nChapter summary:`);
  chapterData.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.title} (${c.paragraphs.length} paragraphs)`);
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
