const assert = require('node:assert/strict');
const { test } = require('node:test');
const Board = require('../board.js');
const Legacy = require('../../src/model.js');

const measure = (text, size) => Array.from(text).length * size * .62;
const copy = value => JSON.parse(JSON.stringify(value));
const find = (board, id) => board.objects.find(object => object.id === id);

function legacySample(version) {
  const map = Legacy.createMap('Field notes');
  const data = map.data;
  const root = data.rootId;
  const first = Legacy.add(data, root, 'child', 'left');
  const second = Legacy.add(data, root, 'child', 'right');
  const grandchild = Legacy.add(data, first);
  Object.assign(data.nodes[first], {
    text: 'First\n第二', notes: 'A note', source: 'https://example.org/example',
    color: '#0744b5', collapsed: true, connectorLabel: 'first branch', connectorReverse: true,
    connectorType: 'arrow', connectorStyle: 'strict-s', connectorDashed: true,
  });
  Object.assign(data.nodes[root], { text: 'Root', x: -175, y: 120 });
  Object.assign(data, { zoom: .82, panX: 24, panY: -63, snap: true, defaultConnectorType: 'arrow' });
  const feedback = Legacy.addLink(data, second, root);
  const self = Legacy.addLink(data, second, second);
  Object.assign(data.links[0], { connectorLabel: 'Feedback', connectorType: 'both', connectorDashed: true });
  return { version, activeMapId: map.id, maps: [map], root, first, second, grandchild, feedback, self };
}

test('a board can be empty and a mixed workspace round-trips without shape or stroke loss', () => {
  assert.equal(Board.createWorkspace().boards[0].objects.length, 0);
  const workspace = Board.createWorkspace(Board.exampleBoard());
  const drawing = workspace.boards[0].objects.find(item => item.type === 'stroke');
  assert.ok(new Set(workspace.boards[0].objects.map(item => item.type)).size >= 5);
  assert.ok(drawing.points.length > 2);
  assert.deepEqual(Board.validateWorkspace(copy(workspace)), workspace);
  assert.deepEqual(Board.importDocument(workspace).boards, workspace.boards);
});

for (const version of [1, 2, 3, 4]) {
  test(`legacy version ${version} preserves text, positions, side, ordered branches and connector properties`, () => {
    const input = legacySample(version);
    const original = copy(input);
    const source = Legacy.validateLibrary(input).maps[0].data;
    const oldBoxes = Legacy.layout(source, measure, true);
    const [board] = Board.importDocument(input, measure).boards;
    assert.deepEqual(input, original);
    assert.equal(board.legacy.version, version);
    assert.equal(board.legacy.rootId, input.root);
    assert.equal(board.legacy.snap, true);
    assert.equal(board.legacy.defaultLinkStyle.arrow, 'end');
    assert.deepEqual(board.view, { x: 24, y: -63, zoom: .82 });
    for (const [id, node] of Object.entries(source.nodes)) {
      const item = find(board, id);
      const box = oldBoxes[id];
      assert.deepEqual([item.text, item.notes, item.source, item.folded], [node.text, node.notes, node.source, node.collapsed]);
      assert.deepEqual([item.x + item.width / 2, item.y + item.height / 2, item.width, item.height], [box.x, box.y, box.width, box.height]);
      assert.deepEqual(board.branches.filter(edge => edge.parentId === id).sort((a, b) => a.order - b.order).map(edge => edge.childId), node.children);
    }
    const firstEdge = board.branches.find(edge => edge.childId === input.first);
    assert.deepEqual(firstEdge.style, { route: 'elbow', arrow: 'start', dashed: true, color: '#0744b5' });
    assert.equal(firstEdge.side, 'left');
    assert.equal(firstEdge.label, 'first branch');
    const feedback = board.links.find(edge => edge.id === input.feedback);
    assert.equal(feedback.from.objectId, input.second);
    assert.equal(feedback.to.objectId, input.root);
    assert.equal(feedback.style.arrow, 'both');
    assert.equal(board.links.find(edge => edge.id === input.self).to.objectId, input.second);
    assert.deepEqual(Board.validateBoard(copy(board)), board);
  });
}

test('free legacy boards retain independent roots and positions when saved as a new workspace', () => {
  const input = legacySample(4);
  const data = input.maps[0].data;
  data.layoutMode = 'free';
  const separate = Legacy.addRoot(data, { x: 785, y: -260 });
  const [board] = Board.importDocument(input, measure).boards;
  const box = find(board, separate);
  assert.deepEqual([box.x + box.width / 2, box.y + box.height / 2], [785, -260]);
  assert.equal(board.branches.some(edge => edge.childId === separate), false);
  const workspace = Board.createWorkspace(board);
  const added = Board.addImportedBoards(workspace, [board, board]);
  assert.equal(new Set(added.boards.map(item => item.id)).size, 3);
  assert.equal(added.activeBoardId, added.boards[1].id);
  assert.deepEqual(added.boards[1].objects, workspace.boards[0].objects);
  assert.equal(workspace.boards.length, 1);
});

test('loose links can feed back and self-connect while branch cycles and missing endpoints are rejected', () => {
  const board = Board.exampleBoard();
  board.links.push({ id: 'self', from: { objectId: 'mic' }, to: { objectId: 'mic' } });
  assert.doesNotThrow(() => Board.validateBoard(board));
  const brokenLink = copy(board);
  brokenLink.links[0].to.objectId = 'missing';
  assert.throws(() => Board.validateBoard(brokenLink), /missing object/);
  const cyclicBranch = copy(board);
  cyclicBranch.branches.push({ id: 'cycle', parentId: 'dry-take', childId: 'takes' });
  assert.throws(() => Board.validateBoard(cyclicBranch), /cycle/);
  const cyclicGroup = copy(board);
  find(cyclicGroup, 'frame').groupId = 'frame';
  assert.throws(() => Board.validateBoard(cyclicGroup), /cycle/);
  const newer = { ...board, version: 2 };
  assert.throws(() => Board.importDocument(newer), /Expected a Mind Mapper board/);
});

test('branch movement and local relayout keep unrelated objects and the selected root in place', () => {
  const board = Board.exampleBoard();
  find(board, 'room-mic').locked = true;
  const mic = copy(find(board, 'mic'));
  const waveform = copy(find(board, 'waveform'));
  const oldDry = copy(find(board, 'dry-take'));
  const oldRoom = copy(find(board, 'room-mic'));
  Board.moveObjects(board, ['takes', 'dry-take'], 20, -45);
  assert.deepEqual([find(board, 'dry-take').x, find(board, 'dry-take').y], [oldDry.x + 20, oldDry.y - 45]);
  assert.deepEqual(find(board, 'room-mic'), oldRoom);
  const root = copy(find(board, 'takes'));
  Board.relayoutBranch(board, 'takes');
  assert.deepEqual(find(board, 'takes'), root);
  assert.deepEqual(find(board, 'mic'), mic);
  assert.deepEqual(find(board, 'waveform'), waveform);
  assert.deepEqual(find(board, 'room-mic'), oldRoom);
});

test('folding is a view filter, duplicating copies only internal links, and detaching preserves positions', () => {
  const board = Board.exampleBoard();
  board.links.push(
    { id: 'internal', from: { objectId: 'dry-take', port: 'right' }, to: { objectId: 'takes', port: 'left' } },
    { id: 'external', from: { objectId: 'dry-take', port: 'right' }, to: { objectId: 'mic', port: 'left' } },
  );
  find(board, 'takes').folded = true;
  assert.deepEqual(Board.descendants(board, 'takes'), ['dry-take', 'room-mic']);
  assert.equal(Board.visibleObjects(board).some(item => item.id === 'dry-take'), false);
  assert.ok(find(board, 'dry-take'));
  const cloned = Board.duplicateBranch(board, 'takes');
  assert.equal(Board.descendants(board, cloned).length, 2);
  assert.equal(board.links.length, 6);
  const oldDry = copy(find(board, 'dry-take'));
  Board.detachBranch(board, 'dry-take');
  assert.deepEqual(find(board, 'dry-take'), oldDry);
  assert.equal(Board.visibleObjects(board).some(item => item.id === 'dry-take'), true);
  Board.deleteObjects(board, ['takes']);
  assert.ok(find(board, 'dry-take'));
  assert.equal(find(board, 'room-mic'), undefined);
  assert.equal(board.links.some(link => link.id === 'internal'), false);
  assert.doesNotThrow(() => Board.validateBoard(board));
});
