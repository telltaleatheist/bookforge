#!/usr/bin/env node
/**
 * Compare text extraction between mupdf.js, mutool, and poppler
 * to determine if we can consolidate to a single tool
 */

import * as mupdf from 'mupdf';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TEST_PDF = process.argv[2];
if (!TEST_PDF) {
  console.log('Usage: node compare-text-extraction.js <pdf-file>');
  process.exit(1);
}

async function extractWithMupdfJs(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');

  let allText = '';
  const pageCount = doc.countPages();

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const stext = page.toStructuredText('preserve-whitespace');
    allText += stext.asText() + '\n---PAGE BREAK---\n';
  }

  return allText;
}

async function extractWithMutool(pdfPath) {
  try {
    const { stdout } = await execAsync(`/opt/homebrew/bin/mutool draw -F text "${pdfPath}"`, {
      maxBuffer: 50 * 1024 * 1024
    });
    return stdout;
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

async function extractWithPoppler(pdfPath) {
  // Try bundled poppler first, then system
  const paths = [
    './resources/bin/pdftotext-arm64',
    './resources/bin/pdftotext',
    '/opt/homebrew/bin/pdftotext',
    'pdftotext'
  ];

  for (const p of paths) {
    try {
      const { stdout } = await execAsync(`"${p}" -layout "${pdfPath}" -`, {
        maxBuffer: 50 * 1024 * 1024
      });
      return stdout;
    } catch {
      continue;
    }
  }
  return 'ERROR: pdftotext not found';
}

function analyzeText(text, label) {
  // Count digits
  const digits = (text.match(/\d/g) || []).length;

  // Count specific number patterns
  const pageNumbers = (text.match(/\b\d{1,4}\b/g) || []).length;
  const years = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
  const decimals = (text.match(/\d+\.\d+/g) || []).length;

  // Count special chars
  const specialChars = (text.match(/[^\w\s]/g) || []).length;

  // Sample: find lines with numbers
  const linesWithNumbers = text.split('\n')
    .filter(line => /\d/.test(line))
    .slice(0, 5);

  console.log(`\n=== ${label} ===`);
  console.log(`Total length: ${text.length} chars`);
  console.log(`Digits found: ${digits}`);
  console.log(`Number patterns: ${pageNumbers} standalone, ${years} years, ${decimals} decimals`);
  console.log(`Special chars: ${specialChars}`);
  console.log(`Sample lines with numbers:`);
  linesWithNumbers.forEach(line => console.log(`  "${line.trim().substring(0, 80)}"`));

  return { digits, pageNumbers, specialChars, length: text.length };
}

async function main() {
  console.log(`Comparing text extraction for: ${TEST_PDF}\n`);

  // Extract with all three methods
  console.log('Extracting with mupdf.js...');
  const mupdfText = await extractWithMupdfJs(TEST_PDF);

  console.log('Extracting with mutool...');
  const mutoolText = await extractWithMutool(TEST_PDF);

  console.log('Extracting with poppler...');
  const popplerText = await extractWithPoppler(TEST_PDF);

  // Analyze each
  const mupdfStats = analyzeText(mupdfText, 'mupdf.js');
  const mutoolStats = analyzeText(mutoolText, 'mutool');
  const popplerStats = analyzeText(popplerText, 'poppler');

  // Compare
  console.log('\n=== COMPARISON ===');
  console.log(`Digit counts: mupdf.js=${mupdfStats.digits}, mutool=${mutoolStats.digits}, poppler=${popplerStats.digits}`);

  if (mupdfStats.digits === mutoolStats.digits && mutoolStats.digits === popplerStats.digits) {
    console.log('✅ All three tools extracted the same number of digits');
  } else {
    console.log('⚠️  Digit counts differ between tools');
    if (mupdfStats.digits < popplerStats.digits) {
      console.log(`   mupdf.js is missing ${popplerStats.digits - mupdfStats.digits} digits compared to poppler`);
    }
    if (mutoolStats.digits < popplerStats.digits) {
      console.log(`   mutool is missing ${popplerStats.digits - mutoolStats.digits} digits compared to poppler`);
    }
  }

  // Save outputs for manual comparison
  const outDir = '/tmp/text-extraction-compare';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/mupdf.txt`, mupdfText);
  fs.writeFileSync(`${outDir}/mutool.txt`, mutoolText);
  fs.writeFileSync(`${outDir}/poppler.txt`, popplerText);
  console.log(`\nFull outputs saved to ${outDir}/`);
}

main().catch(console.error);
