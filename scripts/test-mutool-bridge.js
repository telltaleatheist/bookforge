#!/usr/bin/env node
/**
 * Quick test of the mutool-bridge implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the compiled bridge
const { MutoolBridge } = await import('../dist/electron/mutool-bridge.js');

const TEST_PDF = process.argv[2] || '/Users/telltale/Documents/BookForge/files/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf';

async function main() {
  console.log('=== MuTool Bridge Test ===\n');

  const bridge = new MutoolBridge();

  // Check availability
  const available = await bridge.isAvailable();
  console.log(`mutool available: ${available}`);

  if (!available) {
    console.error('ERROR: mutool binary not found!');
    console.error('Run: npm run download:mupdf');
    process.exit(1);
  }

  // Test extraction
  console.log(`\nTesting PDF: ${TEST_PDF}\n`);

  // We need page dimensions - for simplicity use default letter size
  const pageDimensions = [];
  for (let i = 0; i < 100; i++) {
    pageDimensions.push({ width: 612, height: 792 });
  }

  console.log('Extracting blocks and spans...');
  const startTime = Date.now();

  const { blocks, spans } = await bridge.extractAll(TEST_PDF, 100, pageDimensions);

  const elapsed = Date.now() - startTime;
  console.log(`\nExtraction complete in ${elapsed}ms`);
  console.log(`  Blocks: ${blocks.length}`);
  console.log(`  Spans: ${spans.length}`);

  // Sample blocks
  console.log('\nSample blocks (first 5):');
  for (let i = 0; i < Math.min(5, blocks.length); i++) {
    const b = blocks[i];
    console.log(`  [${b.page}] "${b.text.substring(0, 50).replace(/\n/g, '\\n')}..." (${b.font_name}, ${b.font_size}pt)`);
  }

  // Check for numbers
  const blockText = blocks.map(b => b.text).join('\n');
  const digitCount = (blockText.match(/\d/g) || []).length;
  console.log(`\nDigit count in blocks: ${digitCount}`);

  // Check font variety
  const fonts = new Set(blocks.map(b => b.font_name));
  console.log(`Unique fonts: ${fonts.size}`);
  console.log(`  ${[...fonts].slice(0, 5).join(', ')}${fonts.size > 5 ? '...' : ''}`);

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
