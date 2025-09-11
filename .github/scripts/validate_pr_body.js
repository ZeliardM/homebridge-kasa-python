#!/usr/bin/env node
/**
 * Strict PR validation (beta-only target).
 * Rules:
 *  - Base branch MUST be exactly 'beta'
 *  - Requires at least one classification label from:
 *      bug, fix, enhancement, feature, breaking-change, docs, dependency
 *  - If 'breaking-change' present:
 *      Must include markers:
 *        BREAKING_CHANGE_EXPLANATION_START
 *        BREAKING_CHANGE_EXPLANATION_END
 *      with >= 60 chars of content between them.
 *  - Skip validation for github-actions[bot].
 * Input:
 *  - PR_DATA_B64 (base64-encoded JSON of pull_request object)
 *  - ACTOR (GitHub actor)
 */

function fail(msg) {
  console.error(`❌ VALIDATION FAILED: ${msg}`);
  process.exit(1);
}

const actor = process.env.ACTOR || '';

if (actor === 'github-actions[bot]') {
  console.log('Bypassing validation for github-actions[bot].');
  process.exit(0);
}

const b64 = process.env.PR_DATA_B64 || '';
if (!b64) {
  fail('Missing PR_DATA_B64 environment variable.');
}

let raw;
try {
  raw = Buffer.from(b64, 'base64').toString('utf8');
} catch (e) {
  fail(`Unable to base64 decode PR_DATA_B64: ${e.message}`);
}

let pr;
try {
  pr = JSON.parse(raw);
} catch (e) {
  fail(`Unable to parse decoded PR JSON: ${e.message}`);
}

const base = (pr.base && pr.base.ref) || '';
const labels = Array.isArray(pr.labels)
  ? pr.labels.map(l => (l.name || '').toLowerCase())
  : [];
const body = pr.body || '';

if (base !== 'beta') {
  fail(`PR base branch "${base}" is invalid. All PRs must target 'beta'.`);
}

const CLASS_LABELS = [
  'bug',
  'fix',
  'enhancement',
  'feature',
  'breaking-change',
  'docs',
  'dependency'
];

if (!labels.some(l => CLASS_LABELS.includes(l))) {
  fail(
    `At least one classification label required (${CLASS_LABELS.join(
      ', '
    )}). Current labels: ${labels.length ? labels.join(', ') : '(none)'}`
  );
}

if (labels.includes('breaking-change')) {
  const startToken = 'BREAKING_CHANGE_EXPLANATION_START';
  const endToken = 'BREAKING_CHANGE_EXPLANATION_END';
  const startIdx = body.indexOf(startToken);
  const endIdx = body.indexOf(endToken);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    fail(
      'breaking-change label present but explanation markers missing/malformed.\n' +
      `Include:\n${startToken}\n... explanation ...\n${endToken}`
    );
  }

  const segment = body
    .substring(startIdx + startToken.length, endIdx)
    .trim();

  if (segment.length < 60) {
    fail(
      `Breaking change explanation too short (<60 chars). Provide rationale + migration steps. Current length: ${segment.length}`
    );
  }
}

console.log('✅ PR validation passed.');
