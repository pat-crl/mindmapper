const assert = require('node:assert/strict');
const { test } = require('node:test');
const Board = require('../board.js');
const Arrange = require('../arrangement.js');

const find = (board, id) => board.objects.find(item => item.id === id);
const position = item => [item.x, item.y];
const shape = (id, x, y, width = 30, height = 25) => ({ id, type: 'shape', x, y, width, height, text: id });
const boardWith = (objects, branches = [], links = []) =>
  Board.validateBoard({ ...Board.emptyBoard('Arrange'), objects, branches, links });

test('copy includes frame and branch contents and excludes external references', () => {
  const board = Board.exampleBoard();
  board.links.push({ id: 'external', from: { objectId: 'takes' }, to: { objectId: 'note' } });
  const selection = Arrange.capture(board, ['frame', 'mic', 'takes']);
  assert.equal(selection.format, 'mindmapper.selection');
  assert.deepEqual(selection.objects.map(item => item.id), ['frame', 'mic', 'preamp', 'monitor', 'takes', 'dry-take', 'room-mic']);
  assert.deepEqual(selection.branches.map(item => item.id), ['take-dry', 'take-room']);
  assert.deepEqual(selection.links.map(item => item.id), ['to-preamp', 'to-monitor', 'feedback']);
  assert.equal(Arrange.capture(board, ['mic']).objects[0].groupId, null);
  selection.objects[1].style.stroke = '#ffffff';
  assert.notEqual(find(board, 'mic').style.stroke, '#ffffff');
});

test('repeated cross-board paste remaps every ID and retains internal ports, labels and geometry', () => {
  const source = Board.exampleBoard();
  const selection = JSON.parse(JSON.stringify(Arrange.capture(source, ['frame', 'takes'])));
  const destination = Board.emptyBoard();
  const [group, root] = Arrange.insert(destination, selection, { x: 200, y: 300 });
  assert.equal(find(destination, group).type, 'group');
  assert.equal(find(destination, root).type, 'branch');
  assert.deepEqual(position(find(destination, group)), [200, 300]);
  assert.equal(destination.objects.find(item => item.text === 'Microphone\nInput').groupId, group);
  assert.equal(destination.branches.find(branch => branch.parentId === root).side, 'right');
  assert.equal(destination.links.find(link => link.label === 'mic level').from.port, 'right');
  const before = destination.objects.map(item => item.id);
  const duplicate = Arrange.insert(destination, selection);
  assert.equal(duplicate.length, 2);
  assert.ok(duplicate.every(id => !before.includes(id)));
  const allIds = [...destination.objects, ...destination.branches, ...destination.links].map(item => item.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(allIds.every(id => ![...source.objects, ...source.branches, ...source.links].some(item => item.id === id)));
  assert.doesNotThrow(() => Board.validateBoard(destination));
});

test('invalid paste leaves the destination unchanged', () => {
  const board = Board.exampleBoard();
  const payload = Arrange.capture(board, ['frame']);
  payload.links[0].to.objectId = 'missing';
  const before = JSON.stringify(board);
  assert.throws(() => Arrange.insert(board, payload), /missing object/);
  assert.throws(() => Arrange.insert(board, Arrange.capture(board, ['frame']), { x: 1e9, y: 0 }), /outside/);
  assert.equal(JSON.stringify(board), before);
});

test('frames move branches through group membership while locked objects remain fixed', () => {
  const board = boardWith([
    { ...shape('frame', 0, 0, 100, 100), type: 'group' },
    { ...shape('parent', 10, 20), type: 'branch', groupId: 'frame' },
    { ...shape('child', 130, 30), type: 'branch' },
    { ...shape('locked', 150, 35), type: 'branch', locked: true },
  ], [{ id: 'one', parentId: 'parent', childId: 'child' }, { id: 'two', parentId: 'parent', childId: 'locked' }]);
  Arrange.move(board, ['frame', 'child'], 40, 55);
  assert.deepEqual(position(find(board, 'frame')), [40, 55]);
  assert.deepEqual(position(find(board, 'parent')), [50, 75]);
  assert.deepEqual(position(find(board, 'child')), [170, 85]);
  assert.deepEqual(position(find(board, 'locked')), [150, 35]);
});

test('align moves whole subtrees and uses rendered dimensions', () => {
  const board = Board.exampleBoard();
  const child = position(find(board, 'dry-take'));
  const parent = position(find(board, 'takes'));
  const rendered = new Map([['note', { ...find(board, 'note'), height: 180 }]]);
  Arrange.align(board, ['takes', 'room-mic', 'note'], 'bottom', rendered);
  const [x, y] = position(find(board, 'takes'));
  assert.deepEqual([x, y], [parent[0], parent[1] + 87]);
  assert.deepEqual(position(find(board, 'dry-take')), [child[0], child[1] + 87]);
  assert.equal(find(board, 'note').y, 63);
});

test('distribution equalises edge gaps while keeping the two outer objects in place', () => {
  const board = boardWith([shape('a', 0, 0, 20), shape('b', 50, 7, 60), shape('c', 240, 5, 30)]);
  Arrange.align(board, ['a', 'b', 'c'], 'distribute-x');
  assert.deepEqual(board.objects.map(item => item.x), [0, 100, 240]);
  assert.deepEqual(board.objects.map(item => item.y), [0, 7, 5]);
});

test('arrangement refuses locked or overlapping units before changing positions', () => {
  const board = Board.exampleBoard();
  find(board, 'room-mic').locked = true;
  const before = JSON.stringify(board);
  assert.throws(() => Arrange.align(board, ['takes', 'note'], 'top'), /Unlock/);
  assert.throws(() => Arrange.group(board, ['takes', 'note']), /Unlock/);
  assert.throws(() => Arrange.order(board, ['takes'], 'front'), /Unlock/);
  assert.equal(JSON.stringify(board), before);

  find(board, 'room-mic').locked = false;
  find(board, 'room-mic').groupId = 'frame';
  const overlap = JSON.stringify(board);
  assert.throws(() => Arrange.align(board, ['takes', 'frame'], 'left'), /overlapping/);
  assert.equal(JSON.stringify(board), overlap);
});

test('grouping attaches whole branch trees and ungroup preserves positions and existing links', () => {
  const board = Board.exampleBoard();
  const branch = position(find(board, 'takes'));
  const note = position(find(board, 'note'));
  const group = Arrange.group(board, ['takes', 'note']);
  assert.equal(find(board, 'dry-take').groupId, group);
  assert.equal(find(board, 'note').groupId, group);
  assert.deepEqual(position(find(board, 'note')), note);
  Arrange.move(board, [group], 14, 35);
  const released = Arrange.ungroup(board, [group]);
  assert.equal(released.length, 4);
  assert.equal(find(board, group), undefined);
  assert.deepEqual(position(find(board, 'takes')), [branch[0] + 14, branch[1] + 35]);
  assert.equal(board.branches.length, 2);
  assert.equal(board.links.length, 3);
  assert.doesNotThrow(() => Board.validateBoard(board));
});

test('stacking preserves relative order and keeps frames behind members', () => {
  const board = Board.exampleBoard();
  Arrange.order(board, ['note', 'waveform'], 'back');
  assert.deepEqual(board.objects.slice(0, 2).map(item => item.id), ['note', 'waveform']);
  Arrange.order(board, ['mic'], 'back');
  assert.deepEqual(board.objects.slice(0, 2).map(item => item.id), ['frame', 'mic']);
  Arrange.order(board, ['frame'], 'front');
  assert.deepEqual(board.objects.slice(-4).map(item => item.id), ['frame', 'mic', 'preamp', 'monitor']);
});

test('snapping favours visible stationary edges and otherwise uses the grid', () => {
  const board = boardWith([
    { ...shape('frame', 0, 0, 100, 100), type: 'group' },
    { ...shape('moving', 40, 30), groupId: 'frame' },
    shape('stationary', 154, 143),
  ]);
  const unsnapped = Arrange.snap(board, ['frame'], 52, 42, { grid: false, objects: false });
  assert.deepEqual(unsnapped, { dx: 52, dy: 42 });
  const target = Arrange.snap(board, ['frame'], 52, 42, { grid: true, objects: true });
  assert.deepEqual(target, { dx: 54, dy: 43, xGuide: 154, yGuide: 143 });
  assert.deepEqual(Arrange.snap(board, ['frame'], 5, 7, { grid: true, objects: false, gridSize: 10 }),
    { dx: 10, dy: 10, xGuide: 10, yGuide: 10 });
});

test('marquee supports reverse dragging and does not select a frame when only its interior is covered', () => {
  const boxes = new Map([
    ['frame', { ...shape('frame', 0, 0, 150, 150), type: 'group' }],
    ['inside', shape('inside', 20, 30)],
    ['outside', shape('outside', 200, 250)],
  ]);
  assert.deepEqual(Arrange.marquee(boxes, { x: 70, y: 70, width: -58, height: -53 }), ['inside']);
  assert.deepEqual(Arrange.marquee(boxes, { x: -3, y: -3, width: 160, height: 160 }), ['frame', 'inside']);
});
