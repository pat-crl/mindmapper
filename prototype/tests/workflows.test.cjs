const assert = require('node:assert/strict');
const { test } = require('node:test');
const Board = require('../board.js');
const Workflows = require('../workflows.js');

const item = (board, id) => board.objects.find(object => object.id === id);
const branch = (board, id) => board.branches.find(edge => edge.childId === id);

test('library duplicate copies the complete board and deletion chooses a neighbour or a new blank board', () => {
  const original = Board.exampleBoard();
  const workspace = Board.createWorkspace(original);
  const first = Workflows.duplicateBoard(workspace, original.id);
  const second = Workflows.duplicateBoard(first, original.id);
  const copy = second.boards[1];
  assert.equal(copy.title, original.title + ' copy 2');
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.id, first.activeBoardId);
  assert.deepEqual(copy.objects, original.objects);
  assert.deepEqual(copy.links, original.links);
  assert.deepEqual(copy.branches, original.branches);
  item(copy, 'takes').text = 'Editable copy';
  assert.notEqual(item(original, 'takes').text, 'Editable copy');
  assert.equal(workspace.boards.length, 1);
  const withoutCopy = Workflows.removeBoard(second, copy.id);
  assert.equal(withoutCopy.activeBoardId, first.activeBoardId);
  const withoutOriginal = Workflows.removeBoard(withoutCopy, original.id);
  assert.equal(withoutOriginal.activeBoardId, first.activeBoardId);
  const blank = Workflows.removeBoard(withoutOriginal, first.activeBoardId);
  assert.equal(blank.boards.length, 1);
  assert.equal(blank.boards[0].objects.length, 0);
  assert.equal(blank.activeBoardId, blank.boards[0].id);
  assert.throws(() => Workflows.removeBoard(blank, 'missing'), /no longer exists/);
});

test('search includes text, notes, source links and connector labels even under folded groups and branches', () => {
  const board = Board.exampleBoard();
  Object.assign(item(board, 'dry-take'), { groupId: 'inside', notes: 'Use [A/B] switch.' });
  Object.assign(item(board, 'room-mic'), { groupId: 'outside', source: 'https://example.org/routing' });
  item(board, 'takes').folded = true;
  item(board, 'frame').folded = true;
  board.objects.push(
    { id: 'outside', type: 'group', x: 10, y: 10, width: 100, height: 100, folded: true },
    { id: 'inside', type: 'group', x: 20, y: 20, width: 90, height: 90, groupId: 'outside', folded: true },
  );
  board.links.push({ id: 'feedback-room', from: { objectId: 'dry-take' }, to: { objectId: 'room-mic' }, label: 'Hidden correlation' });
  assert.deepEqual(Workflows.searchBoard(board, '[a/b]').map(match => [match.id, match.field]), [['dry-take', 'notes']]);
  assert.deepEqual(Workflows.searchBoard(board, '/routing').map(match => [match.id, match.field]), [['room-mic', 'source']]);
  assert.deepEqual(Workflows.searchBoard(board, 'dry take').map(match => [match.id, match.field]), [['dry-take', 'text']]);
  const [match] = Workflows.searchBoard(board, 'CORRELATION');
  assert.deepEqual([match.kind, match.id, match.field], ['edge', 'feedback-room', 'label']);
  assert.equal(Board.visibleObjects(board).some(object => object.id === 'dry-take'), false);
  Workflows.revealMatch(board, match);
  assert.ok(Board.visibleObjects(board).some(object => object.id === 'dry-take'));
  assert.ok(Board.visibleObjects(board).some(object => object.id === 'room-mic'));
  assert.equal(item(board, 'frame').folded, true);
  assert.deepEqual(Workflows.searchBoard(board, ''), []);
});

test('paste outline adds ordered branch trees and preserves existing positions and connectors', () => {
  const board = Board.exampleBoard();
  item(board, 'takes').folded = true;
  branch(board, 'dry-take').order = 3999;
  branch(board, 'room-mic').order = 4000;
  const outside = structuredClone(item(board, 'dry-take'));
  const loose = structuredClone(board.links);
  const ids = Workflows.pasteOutline(board, '1. First\r\n\t- child\r\n\t\t• deeper\r\n    - [x] child two\r\n2) Second', 'takes');
  assert.deepEqual(ids.map(id => item(board, id).text), ['First', 'Second']);
  assert.deepEqual(Board.descendants(board, ids[0]).map(id => item(board, id).text), ['child', 'child two', 'deeper']);
  assert.deepEqual([branch(board, ids[0]).order, branch(board, ids[1]).order], [2, 3]);
  assert.deepEqual([branch(board, 'dry-take').order, branch(board, 'room-mic').order], [0, 1]);
  assert.equal(branch(board, ids[0]).parentId, 'takes');
  assert.equal(item(board, 'takes').folded, false);
  assert.deepEqual(item(board, 'dry-take'), outside);
  assert.deepEqual(board.links, loose);
  assert.ok(item(board, ids[0]).y > outside.y + outside.height);
  assert.doesNotThrow(() => Board.validateBoard(board));

  const blank = Board.emptyBoard();
  const [root] = Workflows.pasteOutline(blank, 'Starting idea\n  Child', undefined, [-40, 70]);
  assert.deepEqual([item(blank, root).x, item(blank, root).y], [-40, 70]);
  assert.equal(branch(blank, root), undefined);
  assert.equal(Board.descendants(blank, root).length, 1);
});

test('invalid outlines leave the entire draft unchanged', () => {
  const board = Board.exampleBoard();
  const original = structuredClone(board);
  assert.throws(() => Workflows.pasteOutline(board, '  •\n   -', 'takes'), /at least one idea/);
  assert.throws(() => Workflows.pasteOutline(board, 'x'.repeat(20001), 'takes'), /20,000/);
  const nested = Array.from({ length: 103 }, (_, depth) => ' '.repeat(depth) + 'x').join('\n');
  assert.throws(() => Workflows.pasteOutline(board, nested, 'takes'), /nested/);
  assert.deepEqual(board, original);
});

test('outline copy keeps ordered nested ideas, notes and source links with safe HTML', () => {
  const board = Board.exampleBoard();
  Object.assign(item(board, 'dry-take'), {
    text: 'Dry <take>\nsecond line',
    notes: 'A note with *literal stars* & a quote "here"',
    source: 'https://example.org/search?q=one&lang=en',
  });
  Object.assign(item(board, 'room-mic'), { source: 'javascript:alert(1)' });
  item(board, 'takes').folded = true;
  const rendered = Workflows.outline(board, ['takes', 'dry-take']);
  assert.match(rendered.text, /^- Record takes\n  - Dry /);
  assert.match(rendered.text, /Notes: A note with \\\*literal stars\\\*/);
  assert.match(rendered.text, /Source: <https:\/\/example\.org\/search\?q=one&lang=en>/);
  assert.equal(rendered.html.match(/Dry &lt;take&gt;/g).length, 1);
  assert.match(rendered.html, /<ul><li>Record takes<ul><li>Dry &lt;take&gt;<br>second line<p>Notes:/);
  assert.match(rendered.html, /href="https:\/\/example\.org\/search\?q=one&amp;lang=en"/);
  assert.match(rendered.html, /Source: javascript:alert\(1\)/);
  assert.doesNotMatch(rendered.html, /href="javascript:/);
  assert.deepEqual(Workflows.outline(board, ['monitor']), { text: '', html: '' });
  assert.equal(Workflows.sourceURL('file:///etc/example'), null);
});
