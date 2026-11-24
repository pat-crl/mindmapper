'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Board = require('../board.js');
const Structure = require('../structure.js');

const item = (board, id) => board.objects.find(object => object.id === id);
const incoming = (board, id) => board.branches.find(edge => edge.childId === id);
const position = object => [object.x, object.y];

function mindMap() {
  const board = Board.emptyBoard('Mind map');
  board.objects = [
    Board.createObject('branch', [-60, -30], { id: 'root', text: 'Root' }),
    Board.createObject('branch', [620, 270], { id: 'other-root', text: 'Independent map' }),
    Board.createObject('shape', [142, -30], { id: 'note', text: 'Manual block' }),
  ];
  return board;
}

function link(id, from, to, style = {}) {
  return { id, from: { objectId: from, port: 'auto' }, to: { objectId: to, port: 'auto' },
    label: '', style: { route: 'elbow', arrow: 'end', dashed: false, color: '', ...style } };
}

test('child creation balances the root, inherits a nested side, and leaves manual objects in place', () => {
  const board = mindMap();
  const initial = board.objects.map(position);
  const right = Structure.addBranch(board, 'root');
  const left = Structure.addBranch(board, 'root');
  const nested = Structure.addBranch(board, left, { kind: 'child', side: 'right' });
  assert.deepEqual(board.objects.slice(0, 3).map(position), initial);
  assert.equal(incoming(board, right).side, 'right');
  assert.equal(incoming(board, left).side, 'left');
  assert.equal(incoming(board, nested).side, 'left');
  assert.ok(item(board, left).x < item(board, 'root').x);
  assert.ok(item(board, nested).x < item(board, left).x);
  assert.ok(item(board, right).y > item(board, 'note').y + item(board, 'note').height);
  assert.doesNotThrow(() => Board.validateBoard(board));
});

test('sibling creation inserts next in sibling order and unfolds hidden ancestors', () => {
  const board = mindMap();
  const a = Structure.addBranch(board, 'root', { side: 'left' });
  const b = Structure.addBranch(board, 'root', { side: 'left' });
  item(board, 'root').folded = true;
  // The second item becomes visible after insertion and its footprint must be considered.
  item(board, b).y = item(board, a).y + item(board, a).height + 30;
  const old = position(item(board, b));
  const middle = Structure.addBranch(board, a, { kind: 'sibling' });
  assert.equal(item(board, 'root').folded, false);
  assert.equal(incoming(board, middle).side, 'left');
  assert.deepEqual(board.branches.filter(edge => edge.parentId === 'root')
    .sort((first, second) => first.order - second.order).map(edge => edge.childId), [a, middle, b]);
  assert.deepEqual(position(item(board, b)), old);
  assert.ok(item(board, middle).y > item(board, b).y + item(board, b).height);
  item(board, a).locked = true;
  const unchanged = structuredClone(board);
  assert.throws(() => Structure.addBranch(board, a, { kind: 'sibling' }), /unlock/i);
  assert.deepEqual(board, unchanged);
});

test('reparent preserves direct connector identity, relationships and manually placed objects', () => {
  const board = mindMap();
  const left = Structure.addBranch(board, 'root', { side: 'left' });
  const right = Structure.addBranch(board, 'root', { side: 'right' });
  const child = Structure.addBranch(board, right);
  const tail = Structure.addBranch(board, child);
  const former = incoming(board, child);
  former.label = 'Keep this relationship';
  former.style.dashed = true;
  board.links.push(link('loose', child, 'note'));
  item(board, left).folded = true;
  const before = board.objects.map(position);
  const links = structuredClone(board.links);
  Structure.reparent(board, child, left);
  assert.deepEqual(board.objects.map(position), before);
  assert.deepEqual(board.links, links);
  assert.equal(item(board, left).folded, false);
  const newEdge = incoming(board, child);
  assert.equal(newEdge.parentId, left);
  assert.equal(newEdge.id, former.id);
  assert.equal(newEdge.label, former.label);
  assert.equal(newEdge.style.dashed, true);
  assert.equal(newEdge.side, 'left');
  assert.equal(incoming(board, tail).side, 'left');
  assert.doesNotThrow(() => Board.validateBoard(board));
});

test('reparent rejects non-branches, cycles and locked subtrees without partial edits', () => {
  const board = mindMap();
  const child = Structure.addBranch(board, 'root');
  const grandchild = Structure.addBranch(board, child);
  assert.throws(() => Structure.reparent(board, child, grandchild), /descendants/);
  assert.throws(() => Structure.reparent(board, child, 'note'), /mind map branch/);
  item(board, grandchild).locked = true;
  const unchanged = structuredClone(board);
  assert.throws(() => Structure.reparent(board, child, 'other-root'), /unlock/i);
  assert.deepEqual(board, unchanged);
});

test('keyboard traversal uses visible structural siblings and ignores feedback links', () => {
  const board = mindMap();
  const first = Structure.addBranch(board, 'root');
  const second = Structure.addBranch(board, 'root');
  const descendant = Structure.addBranch(board, second);
  board.links.push(link('feedback', descendant, 'root'));
  assert.equal(Structure.traverse(board, 'root', 'child'), first);
  assert.equal(Structure.traverse(board, first, 'next'), second);
  assert.equal(Structure.traverse(board, second, 'previous'), first);
  assert.equal(Structure.traverse(board, descendant, 'parent'), second);
  assert.equal(Structure.traverse(board, 'root', 'next'), 'other-root');
  item(board, second).folded = true;
  assert.equal(Structure.traverse(board, second, 'child'), null);
  assert.equal(Structure.traverse(board, descendant, 'parent'), null);
});

function diamondFlow() {
  const board = Board.emptyBoard('Release steps');
  const blocks = [
    ['source', [-200, 30]], ['decision', [60, -20]], ['draft', [190, 40]],
    ['review', [150, 180]], ['done', [-280, 300]],
  ];
  board.objects = blocks.map(([id, point]) => Board.createObject('shape', point, {
    id, shape: id === 'decision' ? 'decision' : 'rounded',
  }));
  board.objects.push(Board.createObject('branch', [-360, -200], { id: 'outside', text: 'Unrelated map' }));
  board.links = [
    link('a', 'source', 'decision'), link('a-parallel', 'source', 'decision'),
    link('b', 'decision', 'draft'), link('c', 'decision', 'review'),
    link('d', 'draft', 'done'), link('e', 'done', 'review', { arrow: 'start' }),
    link('feedback', 'review', 'decision', { dashed: true }),
    link('external', 'source', 'outside'),
  ];
  return { board, ids: blocks.map(([id]) => id) };
}

test('horizontal flow keeps decision arms in a column and respects direction, parallel wires and feedback', () => {
  const { board, ids } = diamondFlow();
  const before = position(item(board, 'outside'));
  const links = structuredClone(board.links);
  Structure.arrangeFlow(board, [...ids, 'outside'], 'horizontal');
  const x = id => item(board, id).x;
  assert.ok(x('source') < x('decision') && x('decision') < x('draft') && x('draft') < x('done'));
  assert.equal(x('draft'), x('review'));
  assert.ok(item(board, 'draft').y + item(board, 'draft').height < item(board, 'review').y);
  assert.deepEqual(board.branches, []);
  assert.deepEqual(board.links, links);
  assert.deepEqual(position(item(board, 'outside')), before);
  assert.doesNotThrow(() => Board.validateBoard(board));
});

test('vertical flow uses rendered object heights and stays stable across repeated layout', () => {
  const { board, ids } = diamondFlow();
  const boxes = new Map(board.objects.map(item => [item.id, { ...item, height: item.id === 'source' ? 220 : item.height }]));
  Structure.arrangeFlow(board, ids, 'vertical', boxes);
  assert.ok(item(board, 'decision').y > item(board, 'source').y + 220);
  assert.equal(item(board, 'draft').y, item(board, 'review').y);
  assert.notEqual(item(board, 'draft').x, item(board, 'review').x);
  const positions = board.objects.map(position);
  Structure.arrangeFlow(board, ids, 'vertical', boxes);
  assert.deepEqual(board.objects.map(position), positions);
});

test('disconnected stages can be placed in timeline order and locked selection remains unchanged', () => {
  const { board, ids } = diamondFlow();
  board.links = [];
  Structure.arrangeFlow(board, ['draft', 'source', 'decision'], 'horizontal');
  const x = id => item(board, id).x;
  assert.ok(x('source') < x('decision') && x('decision') < x('draft'));
  assert.equal(item(board, 'source').y, item(board, 'decision').y);
  item(board, 'decision').locked = true;
  const before = structuredClone(board);
  assert.throws(() => Structure.arrangeFlow(board, ids, 'vertical'), /unlock/i);
  assert.deepEqual(board, before);
});

test('a solid cyclic flow starts at its visually leading node and leaves the feedback connector intact', () => {
  const { board } = diamondFlow();
  board.links = [link('one', 'source', 'decision'), link('two', 'decision', 'draft'), link('back', 'draft', 'source')];
  Structure.arrangeFlow(board, ['source', 'decision', 'draft'], 'horizontal');
  const x = id => item(board, id).x;
  assert.ok(x('source') < x('decision') && x('decision') < x('draft'));
  assert.equal(board.links.find(link => link.id === 'back').to.objectId, 'source');
});
