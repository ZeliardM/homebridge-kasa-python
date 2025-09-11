#!/usr/bin/env node
/**
 * PR validation script:
 *  - Enforces base branch starts with 'beta'
 *  - Requires at least one classification label (bug, enhancement, breaking-change, docs, dependency, fix, feature)
 *  - If breaking-change label present, looks for explanation markers and minimum length
 *  - Allows Dependabot dependency PRs to target beta (enforced externally) but still validates labels.
 *  - Optional bypass for github-actions[bot].
 */
const pr = JSON.parse(process.env.PR_DATA || '{}');
const actor = process.env.ACTOR || '';
const base = (pr.base && pr.base.ref) || pr.baseRef || '';
const labels = (pr.labels || []).map(l => l.name.toLowerCase());
const body = pr.body || '';

function fail(msg) {
  console.error(`❌ VALIDATION FAILED: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`⚠️ WARNING: ${msg}`);
}

if (actor === 'github-actions[bot]') {
  console.log('Bypassing validation for github-actions[bot].');
  process.exit(0);
}

if (!base.startsWith('beta')) {
  // Allow emergency dependency hotfix? (Commented out for strictness)
  fail(`PR base branch "${base}" must start with "beta".`);
}

const CLASS_LABELS = ['bug','fix','enhancement','feature','breaking-change','docs','dependency'];

if (!labels.some(l => CLASS_LABELS.includes(l))) {
  fail(`At least one classification label required (${CLASS_LABELS.join(', ')}). Current: ${labels.join(', ') || '(none)'}`);
}

// If breaking-change present, enforce markers
if (labels.includes('breaking-change')) {
  const startIdx = body.indexOf('BREAKING_CHANGE_EXPLANATION_START');
  const endIdx = body.indexOf('BREAKING_CHANGE_EXPLANATION_END');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    fail('breaking-change label present but explanation markers are missing or malformed.');
  }
  const segment = body.substring(startIdx + 'BREAKING_CHANGE_EXPLANATION_START'.length, endIdx).trim();
  if (segment.length < 60) {
    fail('Breaking change explanation too short (<60 chars). Provide rationale & migration.');
  }
}

console.log('✅ PR validation passed.');
