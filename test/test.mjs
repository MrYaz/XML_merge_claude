/**
 * Node.js test for the XML product feed matcher core logic.
 * Uses jsdom to replicate browser DOMParser/XMLSerializer.
 */
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
const { DOMParser, XMLSerializer } = dom.window;

/* ---- Core functions (same as in index.html) ---- */

function extractLastTable(html) {
    const re = /<table[\s\S]*?<\/table>/gi;
    let last = null;
    let m;
    while ((m = re.exec(html)) !== null) { last = m; }
    return last ? last[0] : null;
}

function replaceLastTable(html, newTable) {
    const re = /<table[\s\S]*?<\/table>/gi;
    let last = null;
    let m;
    while ((m = re.exec(html)) !== null) {
        last = { idx: m.index, len: m[0].length };
    }
    if (last) {
        return html.substring(0, last.idx) + newTable +
               html.substring(last.idx + last.len);
    }
    const cdataClose = html.lastIndexOf(']]>');
    if (cdataClose !== -1) {
        return html.substring(0, cdataClose) + newTable + html.substring(cdataClose);
    }
    return html + newTable;
}

function processFiles(srcText, tgtText) {
    const parser = new DOMParser();
    const srcDoc = parser.parseFromString(srcText, 'text/xml');
    const tgtDoc = parser.parseFromString(tgtText, 'text/xml');

    const sourceMap = {};
    let srcProductCount = 0;
    let srcTablesFound = 0;

    srcDoc.querySelectorAll('product').forEach((p) => {
        srcProductCount++;
        const sku = p.querySelector('sku')?.textContent?.trim();
        const descEl = p.querySelector('html-description');
        if (!sku || !descEl) return;
        const table = extractLastTable(descEl.textContent || '');
        if (table) {
            sourceMap[sku] = table;
            srcTablesFound++;
        }
    });

    let tgtProductCount = 0;
    let matchCount = 0;
    let replacedCount = 0;
    let appendedCount = 0;
    const matchedSkus = [];

    tgtDoc.querySelectorAll('product').forEach((p) => {
        tgtProductCount++;
        const sku = p.querySelector('sku')?.textContent?.trim();
        if (!sku || !sourceMap[sku]) return;

        const descEl = p.querySelector('html-description');
        if (!descEl) return;

        const oldContent = descEl.textContent || '';
        const hadTable = extractLastTable(oldContent) !== null;
        const newContent = replaceLastTable(oldContent, sourceMap[sku]);

        descEl.textContent = newContent;
        matchCount++;
        matchedSkus.push(sku);
        if (hadTable) { replacedCount++; } else { appendedCount++; }
    });

    let resultXml = new XMLSerializer().serializeToString(tgtDoc);
    const origDecl = tgtText.match(/^(<\?xml[^?]*\?>)/);
    const serDecl = resultXml.match(/^(<\?xml[^?]*\?>)/);
    if (origDecl && !serDecl) {
        resultXml = origDecl[1] + '\n' + resultXml;
    } else if (origDecl && serDecl) {
        resultXml = resultXml.replace(serDecl[1], origDecl[1]);
    }
    resultXml = resultXml.replace(/ xmlns=""/g, '');

    return {
        resultXml, srcProductCount, tgtProductCount, srcTablesFound,
        matchCount, replacedCount, appendedCount, matchedSkus
    };
}

/* ---- Tests ---- */

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  PASS  ${name}`);
        passed++;
    } else {
        console.log(`  FAIL  ${name}`);
        failed++;
    }
}

// --- Unit tests ---
console.log('\n--- extractLastTable ---');

assert(
    extractLastTable('<p>hej</p><table><tr><td>A</td></tr></table>') ===
        '<table><tr><td>A</td></tr></table>',
    'Single table'
);

assert(
    extractLastTable('<table>1</table><p>x</p><table>2</table>') ===
        '<table>2</table>',
    'Multiple tables → returns last'
);

assert(
    extractLastTable('<p>no table here</p>') === null,
    'No table → null'
);

console.log('\n--- replaceLastTable ---');

assert(
    replaceLastTable(
        '<p>A</p><table>OLD</table>',
        '<table>NEW</table>'
    ) === '<p>A</p><table>NEW</table>',
    'Replace single table'
);

assert(
    replaceLastTable(
        '<table>1</table><p>x</p><table>OLD</table>',
        '<table>NEW</table>'
    ) === '<table>1</table><p>x</p><table>NEW</table>',
    'Replace last of two tables'
);

assert(
    replaceLastTable(
        '<p>no table</p>',
        '<table>NEW</table>'
    ) === '<p>no table</p><table>NEW</table>',
    'No existing table → append'
);

// --- Integration test ---
console.log('\n--- Full integration ---');

const srcText = readFileSync(new URL('./source.xml', import.meta.url), 'utf-8');
const tgtText = readFileSync(new URL('./target.xml', import.meta.url), 'utf-8');

const r = processFiles(srcText, tgtText);

assert(r.srcProductCount === 4, `Source products: ${r.srcProductCount} === 4`);
assert(r.tgtProductCount === 4, `Target products: ${r.tgtProductCount} === 4`);
assert(r.srcTablesFound === 3, `Source tables found: ${r.srcTablesFound} === 3`);
assert(r.matchCount === 2, `Matches (1001,1002): ${r.matchCount} === 2`);
assert(r.replacedCount === 2, `Replaced: ${r.replacedCount} === 2`);
assert(r.appendedCount === 0, `Appended: ${r.appendedCount} === 0`);
assert(
    r.matchedSkus.includes('1001') && r.matchedSkus.includes('1002'),
    'Matched SKUs contain 1001 and 1002'
);
assert(!r.matchedSkus.includes('1003'), 'SKU 1003 (only in source) not matched');
assert(!r.matchedSkus.includes('1005'), 'SKU 1005 (only in target) not matched');
assert(!r.matchedSkus.includes('1004'), 'SKU 1004 (source has no table) not matched');

// Verify the result XML content
const resultDoc = new DOMParser().parseFromString(r.resultXml, 'text/xml');

// SKU 1001: target table should be replaced with source table (Höjd 100 mm)
const p1001 = [...resultDoc.querySelectorAll('product')]
    .find(p => p.querySelector('sku')?.textContent?.trim() === '1001');
const desc1001 = p1001?.querySelector('html-description')?.textContent || '';
assert(desc1001.includes('100 mm'), 'SKU 1001: contains source data "100 mm"');
assert(!desc1001.includes('GAMMAL'), 'SKU 1001: old table data removed');

// SKU 1002: has 2 tables in target, only last should be replaced
const p1002 = [...resultDoc.querySelectorAll('product')]
    .find(p => p.querySelector('sku')?.textContent?.trim() === '1002');
const desc1002 = p1002?.querySelector('html-description')?.textContent || '';
assert(desc1002.includes('Fakta B'), 'SKU 1002: contains source last table "Fakta B"');
assert(desc1002.includes('GAMMAL TABELL 1'), 'SKU 1002: first table preserved');
assert(!desc1002.includes('GAMMAL TABELL 2'), 'SKU 1002: second (last) table replaced');

// SKU 1005: should be untouched
const p1005 = [...resultDoc.querySelectorAll('product')]
    .find(p => p.querySelector('sku')?.textContent?.trim() === '1005');
const desc1005 = p1005?.querySelector('html-description')?.textContent || '';
assert(desc1005.includes('E-data'), 'SKU 1005: untouched, still has original data');

// Result should preserve XML declaration
assert(r.resultXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML declaration preserved');

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
