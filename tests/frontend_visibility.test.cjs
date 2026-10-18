const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const frontend = path.join(__dirname, '../frontend');
const stylesheet = fs.readFileSync(path.join(frontend, 'styles.css'), 'utf8');
const markup = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');

test('hidden utility always removes an element from layout', () => {
  const hiddenRules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').some(selector => selector.trim() === '.hidden'))
    .map(([, , declarations]) => declarations);

  assert.notEqual(hiddenRules.length, 0, 'styles.css must define a standalone .hidden selector');
  assert.ok(
    hiddenRules.some(declarations => /(?:^|;)\s*display\s*:\s*none\s*!important\s*(?:;|$)/i.test(declarations)),
    '.hidden must set display: none !important so component display rules cannot expose hidden UI',
  );
});

test('conditional controls and panels are hidden in the initial markup', () => {
  const initiallyHiddenIds = [
    'photoPreview',
    'savePhotoBtn',
    'retryVoiceUploadBtn',
    'dangerBanner',
    'detail',
    'handoff',
  ];

  for (const id of initiallyHiddenIds) {
    const tag = [...markup.matchAll(/<[^>]+>/g)]
      .map(match => match[0])
      .find(candidate => new RegExp(`\\bid=["']${id}["']`).test(candidate));
    assert.ok(tag, `index.html must contain #${id}`);
    const classes = tag.match(/\bclass=["']([^"']*)["']/)?.[1].split(/\s+/) ?? [];
    assert.ok(classes.includes('hidden'), `#${id} must start with the hidden class`);
  }
});
