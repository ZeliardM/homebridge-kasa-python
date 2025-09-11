#!/usr/bin/env node
/**
 * Strict PR validation (Option A / V3 semantics):
 *  - Base branch MUST be exactly 'beta'
 *  - Requires at least one classification label:
 *      bug, fix, enhancement, feature, breaking-change, docs, dependency
 *  - If breaking-change present:
 *      Must contain markers:
 *          BREAKING_CHANGE_EXPLANATION_START
 *          BREAKING_CHANGE_EXPLANATION_END
 *        with >= 60 chars of explanation content between them.
 *  - Bypasses validation only for github-actions[bot].
 */

function fail(msg) {
  console.error(`❌ VALIDATION FAILED: ${msg}`);
  process.exit(1);
}

const raw = process.env.PR_DATA || '';
if (!raw.trim()) {
  fail('Missing PR_DATA environment variable.');
}

let pr;
try {
  pr = JSON.parse(raw);
} catch (e) {
  fail(`Unable to parse PR_DATA JSON: ${e.message}`);
}

const actor = process.env.ACTOR || '';
if (actor === 'github-actions[bot]') {
  console.log('Bypassing validation for github-actions[bot].');
  process.exit(0);
}

const base = (pr.base && pr.base.ref) || '';
const labels = Array.isArray(pr.labels)
  ? pr.labels.map(l => (l.name || '').toLowerCase())
  : [];
const body = pr.body || '';

// 1. Base branch enforcement
if (base !== 'beta') {
  fail(`PR base branch "${base}" is invalid. All PRs must target 'beta'.`);
}

// 2. Classification label requirement
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

// 3. Breaking change explanation requirement
if (labels.includes('breaking-change')) {
  const startToken = 'BREAKING_CHANGE_EXPLANATION_START';
  const endToken = 'BREAKING_CHANGE_EXPLANATION_END';
  const startIdx = body.indexOf(startToken);
  const endIdx = body.indexOf(endToken);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    fail(
      'breaking-change label present but explanation markers are missing or malformed.\n' +
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
