const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const Board = require('../board.js');
const Ink = require('../ink.js');

function world(stroke) {
  return stroke.points.map(([x, y]) => [stroke.x + x, stroke.y + y]);
}

function line(points, additions = {}) {
  return { ...Ink.createStroke(points), ...additions };
}

const geometrySource = fs.readFileSync(path.resolve(__dirname, '../geometry.js'), 'utf8');
const Geometry = vm.runInNewContext(geometrySource + '\nBoardGeometry;', {
  BoardModel: Board,
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) },
  matchMedia: () => ({ matches: false }),
});

test('a tap survives as a local one-point stroke and has a usable hit area', () => {
  const dot = Ink.createStroke([[-8, 22], [-8, 22]]);
  assert.deepEqual(world(dot), [[-8, 22]]);
  assert.ok(dot.width > 0 && dot.height > 0);
  assert.equal(Ink.hitStroke(dot, [-5, 22], 3), true);
  assert.equal(Ink.hitStroke(dot, [-4, 22], 3), false);
  assert.equal(Ink.hitStroke(Board.createObject('shape', [0, 0]), [0, 0], 4), false);
});

test('a single eraser click splits a stroke exactly at the two circle intersections', () => {
  const board = Board.emptyBoard();
  const frame = Board.createObject('group', [-30, -30]);
  const original = line([[-10, 0], [90, 0]], { groupId: frame.id, text: 'Study', notes: 'Original ink',
    style: { fill: '', stroke: '#9a3923', textColor: '' } });
  const after = Board.createObject('note', [10, 20]);
  board.objects.push(frame, original, after);
  const erased = Ink.erase(board, [[40, 0]], 10);
  assert.equal(erased.changed, true);
  assert.equal(erased.removedIds.length, 0);
  assert.equal(erased.addedIds.length, 1);
  const [, first, second] = board.objects;
  assert.equal(first.id, original.id);
  assert.equal(second.id, erased.addedIds[0]);
  assert.equal(board.objects.at(-1), after);
  assert.deepEqual(world(first), [[-10, 0], [30, 0]]);
  assert.deepEqual(world(second), [[50, 0], [90, 0]]);
  for (const piece of [first, second]) {
    assert.equal(piece.groupId, frame.id);
    assert.equal(piece.notes, 'Original ink');
    assert.equal(piece.style.stroke, '#9a3923');
  }
  assert.equal(Ink.hitStroke(first, [41, 0], 4), false);
});

test('a sparse, fast eraser drag cuts continuously between pointer samples', () => {
  const board = Board.emptyBoard();
  board.objects.push(line([[0, -15], [70, -15], [120, -15]]));
  assert.equal(Ink.hitStroke(board.objects[0], [110, -12], 3), true);
  Ink.erase(board, [[95, -90], [95, 90]], 7);
  assert.deepEqual(board.objects.map(world), [
    [[0, -15], [70, -15], [88, -15]], [[102, -15], [120, -15]],
  ]);
});

test('separate eraser passes on one stroke do not remove the ink between them', () => {
  const board = Board.emptyBoard();
  board.objects.push(line([[0, 0], [100, 0]]));
  Ink.erase(board, [[20, -10], [20, 10], [80, 10], [80, -10]], 5);
  assert.deepEqual(board.objects.map(world), [[[0, 0], [15, 0]], [[25, 0], [75, 0]], [[85, 0], [100, 0]]]);
});

test('locked and hidden strokes survive while links to fully erased strokes are removed', () => {
  const board = Board.emptyBoard();
  const group = Board.createObject('group', [0, 0], { folded: true });
  const visible = line([[0, 0], [35, 0]]);
  const locked = line([[0, 5], [35, 5]], { locked: true });
  const hidden = line([[0, 2], [35, 2]], { groupId: group.id });
  const end = Board.createObject('note', [50, 0]);
  board.objects.push(group, visible, locked, hidden, end);
  const connector = { id: 'ink-link', from: { objectId: visible.id, port: 'auto' }, to: { objectId: end.id, port: 'auto' } };
  board.links.push(connector);
  const original = JSON.stringify(board);
  const draft = structuredClone(board);
  const cut = Ink.erase(draft, [[15, 0]], 6);
  assert.equal(cut.addedIds.length, 1);
  assert.equal(draft.links[0].from.objectId, visible.id);
  assert.equal(JSON.stringify(board), original, 'discarding a draft leaves original ink untouched');

  const removed = Ink.erase(board, [[-10, 0], [48, 0]], 10);
  assert.deepEqual(removed.removedIds, [visible.id]);
  assert.equal(board.links.length, 0);
  assert.ok(board.objects.includes(locked));
  assert.ok(board.objects.includes(hidden));
  assert.doesNotThrow(() => Board.validateBoard(board));
});

test('a fully erased dot disappears and no-overlap preserves the original objects', () => {
  const board = Board.emptyBoard();
  const dot = Ink.createStroke([[25, 3]]);
  board.objects.push(dot);
  assert.equal(Ink.erase(board, [[25, 14]], 2).changed, false);
  assert.equal(board.objects[0], dot);
  assert.equal(Ink.erase(board, [], 3).changed, false);
  assert.deepEqual(Ink.erase(board, [[0, 0], [50, 0]], 4).removedIds, [dot.id]);
  assert.equal(board.objects.length, 0);
});

test('erased pieces reopen as editable geometry and export as separate SVG paths', () => {
  const board = Board.emptyBoard('Cut ink');
  board.objects.push(line([[0, 0], [70, 0]], { style: { fill: '', stroke: '#663399', textColor: '' } }));
  Ink.erase(board, [[35, 0]], 10);
  const workspace = Board.createWorkspace(board);
  const reopened = Board.validateWorkspace(JSON.parse(JSON.stringify(workspace))).boards[0];
  assert.deepEqual(reopened.objects.map(world), [[[0, 0], [25, 0]], [[45, 0], [70, 0]]]);
  const svg = Geometry.svg(Geometry.scene(reopened), reopened.title);
  assert.match(svg, /d="M0 0 L25 0" fill="none" stroke="#663399"/);
  assert.match(svg, /d="M45 0 L70 0" fill="none" stroke="#663399"/);
});

test('invalid eraser samples and radii fail without changing the board', () => {
  const board = Board.emptyBoard();
  board.objects.push(Ink.createStroke([[1, 1]]));
  const original = JSON.stringify(board);
  assert.throws(() => Ink.erase(board, [[Infinity, 0]], 4), /invalid/);
  assert.throws(() => Ink.erase(board, [[1, 1]], NaN), /radius/);
  assert.throws(() => Ink.createStroke([]), /at least one/);
  assert.equal(JSON.stringify(board), original);
});
