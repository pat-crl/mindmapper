'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const Board = require('../board.js');
const Arrangement = require('../arrangement.js');

const source = fs.readFileSync(path.resolve(__dirname, '../geometry.js'), 'utf8');
const Geometry = vm.runInNewContext(source + '\nBoardGeometry;', {
  BoardModel: Board,
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) },
  matchMedia: () => ({ matches: false }),
});
const local = value => JSON.parse(JSON.stringify(value));

function wire(id, from, to, route = 'elbow') {
  return { id, from: { objectId: from, port: 'right' }, to: { objectId: to, port: 'left' }, style: { route } };
}

function block(id, x, y, width = 80, height = 42) {
  return Board.createObject('shape', [x, y], { id, width, height, text: id });
}

function stage(withBox = false) {
  const board = Board.emptyBoard();
  board.objects = [block('a', 0, 0), block('b', 310, 0)];
  if (withBox) board.objects.push(block('box', 138, -30, 75, 104));
  return board;
}

function crosses([x1, y1], [x2, y2], { x, y, width, height }) {
  return Math.min(x1, x2) < x + width && Math.max(x1, x2) > x
    && Math.min(y1, y2) < y + height && Math.max(y1, y2) > y;
}

function ortho(points) {
  return points.slice(1).every(([x, y], i) => points[i][0] === x || points[i][1] === y);
}

test('ordinary elbows avoid a nearby block and expose real orthogonal bends', () => {
  const board = stage(true);
  board.links = [wire('wire', 'a', 'b')];
  const drawing = Geometry.scene(Board.validateBoard(board));
  const edge = local(drawing.edges[0]);
  const obstacle = drawing.byId.get('box');
  assert.deepEqual(edge.fromPoint, [80, 21]);
  assert.deepEqual(edge.toPoint, [310, 21]);
  assert.ok(ortho(edge.points));
  assert.ok(!edge.points.slice(1).some((point, index) => crosses(edge.points[index], point, obstacle)));
  assert.deepEqual(edge.bends, edge.points.slice(1, -1));
  assert.ok(edge.bends.length < Board.MAX_WAYPOINTS);
  assert.ok(edge.arrows.length);
});

test('manual elbows remain pinned, endpoints move, and an empty route goes back to automatic', () => {
  const board = stage();
  const waypoints = [[115, 21], [115, -53], [229, -53]];
  board.links = [{ ...wire('wire', 'a', 'b'), waypoints }];
  const reopened = Board.validateBoard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(reopened.links[0].waypoints, waypoints);
  reopened.objects[1].x += 31;
  reopened.objects[1].y += 50;
  const manual = local(Geometry.scene(reopened).edges[0]);
  assert.deepEqual(manual.waypoints, waypoints);
  assert.deepEqual(manual.bends, waypoints);
  assert.deepEqual(manual.toPoint, [341, 71]);
  assert.ok(ortho(manual.points));
  for (const [x, y] of waypoints) {
    assert.ok(manual.points.slice(1).some((b, i) => {
      const a = manual.points[i];
      return (x === a[0] && x === b[0] && Math.min(a[1], b[1]) <= y && Math.max(a[1], b[1]) >= y)
        || (y === a[1] && y === b[1] && Math.min(a[0], b[0]) <= x && Math.max(a[0], b[0]) >= x);
    }));
  }
  reopened.links[0].waypoints = [];
  const automatic = Board.validateBoard(reopened);
  assert.equal(automatic.links[0].waypoints, undefined);
  assert.notEqual(Geometry.scene(automatic).edges[0].path, manual.path);
  reopened.links[0].waypoints = [[Infinity, 4]];
  assert.throws(() => Board.validateBoard(reopened), /Waypoint x/);
  reopened.links[0].waypoints = Array.from({ length: Board.MAX_WAYPOINTS + 1 }, () => [0, 0]);
  assert.throws(() => Board.validateBoard(reopened), /Connector waypoints/);
});

test('copying a manually routed connector translates its world-space anchors', () => {
  const board = stage();
  board.links = [{ ...wire('wire', 'a', 'b'), waypoints: [[100, -20], [220, -20]] }];
  const selection = Arrangement.capture(Board.validateBoard(board), ['a', 'b']);
  const pasted = Board.emptyBoard();
  Arrangement.insert(pasted, selection, { x: -20, y: 40 });
  assert.deepEqual(pasted.links[0].waypoints, [[80, 20], [200, 20]]);
  assert.notEqual(pasted.links[0].from.objectId, 'a');
  assert.notEqual(pasted.links[0].to.objectId, 'b');
  assert.deepEqual(selection.links[0].waypoints, [[100, -20], [220, -20]]);
});

test('parallel links fan out in every automatic route and opposing links keep their fixed ports', () => {
  for (const mode of ['straight', 'curve', 'elbow']) {
    const board = stage();
    board.links = [
      wire('first', 'a', 'b', mode),
      wire('parallel', 'a', 'b', mode),
      { ...wire('feedback', 'b', 'a', mode), from: { objectId: 'b', port: 'left' }, to: { objectId: 'a', port: 'right' } },
    ];
    const [first, parallel, feedback] = local(Geometry.scene(Board.validateBoard(board)).edges);
    assert.deepEqual(first.fromPoint, parallel.fromPoint);
    assert.deepEqual(first.fromPoint, feedback.toPoint);
    assert.deepEqual(first.toPoint, feedback.fromPoint);
    assert.equal(new Set([first.points, parallel.points, feedback.points.toReversed()].map(p => JSON.stringify(p))).size, 3);
    if (mode === 'elbow') {
      board.objects.push(block('box', 138, -30, 75, 104));
      const [direct, one, two] = local(Geometry.scene(Board.validateBoard(board)).edges);
      assert.equal(new Set([direct.points, one.points, two.points.toReversed()].map(p => JSON.stringify(p))).size, 3);
    }
  }
});

test('crossing connectors without a junction are distinct; a junction has a single shared attachment point', () => {
  const board = stage();
  board.objects.push(block('north', 153, -110), block('south', 153, 115));
  const vertical = { ...wire('vertical', 'north', 'south', 'straight'),
    from: { objectId: 'north', port: 'bottom' }, to: { objectId: 'south', port: 'top' } };
  board.links = [wire('horizontal', 'a', 'b', 'straight'), vertical];
  const crossing = Geometry.scene(Board.validateBoard(board));
  assert.equal(crossing.edges.length, 2);
  assert.doesNotMatch(Geometry.svg(crossing, board.title), /<circle/);
  const junction = Board.createObject('shape', [187, 15], { id: 'junction', shape: 'junction', text: 'No dot label' });
  board.objects.push(junction);
  board.links = [
    wire('west', 'a', 'junction'),
    { ...vertical, id: 'north', to: { objectId: 'junction', port: 'top' } },
    wire('east', 'junction', 'b'),
    { ...vertical, id: 'south', from: { objectId: 'junction', port: 'bottom' } },
  ].map((link, index) => ({ ...link, id: 'connection-' + index }));
  const connected = Geometry.scene(Board.validateBoard(board));
  const dot = connected.byId.get('junction');
  for (const side of ['top', 'right', 'bottom', 'left', 'auto']) {
    assert.deepEqual(local(Geometry.portPoint(dot, side)), [193, 21]);
  }
  assert.deepEqual(local(connected.edges.map((edge, i) => i < 2 ? edge.toPoint : edge.fromPoint)),
    [[193, 21], [193, 21], [193, 21], [193, 21]]);
  const svg = Geometry.svg(connected, board.title);
  assert.match(svg, /data-object-id="junction"><circle cx="193" cy="21" r="6"/);
  assert.doesNotMatch(svg, /No dot label/);
});

test('self feedback from the same fixed port makes a visible closed orthogonal route', () => {
  const board = stage();
  board.links = [{ ...wire('feedback', 'a', 'a'), to: { objectId: 'a', port: 'right' } }];
  const edge = local(Geometry.scene(Board.validateBoard(board)).edges[0]);
  assert.deepEqual(edge.fromPoint, edge.toPoint);
  assert.ok(ortho(edge.points));
  assert.ok(edge.points.some(([x, y]) => x > edge.fromPoint[0] && y !== edge.fromPoint[1]));
  assert.ok(edge.points.flat().every(Number.isFinite));
});
