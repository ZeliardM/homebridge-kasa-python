#!/usr/bin/env node
/**
 * PR validation script:
 *  - Enforces base branch IS EXACTLY 'beta'
 *  - Requires at least one classification label (bug, enhancement, breaking-change, docs, dependency, fix, feature)
 *  - If breaking-change label present, requires explanation markers with minimum length
 *  - Bypasses validation for github-actions[bot]
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
const base = (pr.base && pr.base.ref) || '';
const labels = Array.isArray(pr.labels) ? pr.labels.map(l => (l.name || '').toLowerCase()) : [];
const body = pr.body || '';

if (actor === 'github-actions[bot]') {
  console.log('Bypassing validation for github-actions[bot].');
  process.exit(0);
}

// Strict beta branch requirement
if (base !== 'beta') {
  fail(`PR base branch "${base}" is invalid. All contributions must target 'beta'.`);
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

// Breaking change explanation validation
if (labels.includes('breaking-change')) {
  const startToken = 'BREAKING_CHANGE_EXPLANATION_START';
  const endToken = 'BREAKING_CHANGE_EXPLANATION_END';
  const startIdx = body.indexOf(startToken);
  const endIdx = body.indexOf(endToken);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    fail(
      'breaking-change label present but explanation markers are missing or malformed. ' +
      `Include:\n${startToken}\n... explanation ...\n${endToken}`
    );
  }
  const segment = body
    .substring(startIdx + startToken.length, endIdx)
    .trim();

  if (segment.length < 60) {
    fail(
      `Breaking change explanation too short (<60 chars). Provide rationale and migration steps. Current length: ${segment.length}`
    );
  }
}

console.log('✅ PR validation passed.');
