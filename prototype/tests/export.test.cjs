'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const Board = require('../board.js');
const Arrangement = require('../arrangement.js');

const source = ['geometry.js', 'export.js'].map(name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8')).join('\n');
const api = vm.runInNewContext(source + '\nBoardExport;', {
  BoardModel: Board,
  BoardArrangement: Arrangement,
  document: { createElement: () => ({ getContext: () => ({ measureText: value => ({ width: Array.from(value).length * 7 }) }) }) },
  matchMedia: () => ({ matches: true }),
});
const local = value => JSON.parse(JSON.stringify(value));

function sampleBoard() {
  const board = Board.emptyBoard('Studio & signal');
  board.objects = [
    Board.createObject('group', [-350, -150], { id: 'frame', width: 290, height: 210, text: 'Tracking' }),
    Board.createObject('branch', [-329, -105], { id: 'root', groupId: 'frame', text: 'Mic café\n録音', folded: true,
      style: { fill: '#e2d0a880', stroke: '#1238', textColor: '#674980aa', italic: true, fontWeight: 'bold' } }),
    Board.createObject('branch', [-161, -35], { id: 'child', width: 80, text: 'Folded idea' }),
    Board.createObject('stroke', [-73, 30], { id: 'ink', points: [[0, 0], [50, 12]], style: { stroke: '#169a' } }),
    Board.createObject('shape', [80, -45], { id: 'outside', text: 'Unrelated outside note' }),
  ];
  board.branches = [{ id: 'branch', parentId: 'root', childId: 'child', order: 0, side: 'right' }];
  board.links = [{ id: 'connector', label: 'Take 1 →', from: { objectId: 'root', port: 'top' },
    to: { objectId: 'outside', port: 'left' }, style: { route: 'elbow', arrow: 'both' },
    waypoints: [[-264, -230], [20, -230]] }];
  return Board.validateBoard(board);
}

test('the board figure respects folding and exports shaped text and colour without editor controls', () => {
  const board = sampleBoard();
  const folded = api.plan(board, { padding: 0 });
  const expanded = api.plan(board, { padding: 0, includeFolded: true, background: 'white' });
  const svg = api.svg(folded);
  assert.ok(folded.area.x < 0 && folded.area.y < 0);
  assert.match(svg, new RegExp('viewBox="0 0 ' + folded.area.width + ' ' + folded.area.height + '"'));
  assert.match(svg, /font-family="Arial, Liberation Sans, sans-serif"/);
  assert.match(svg, /<title>Studio &amp; signal<\/title>/);
  assert.match(svg, /Mic café/);
  assert.match(svg, /録音/);
  assert.match(svg, /font-weight="bold" font-style="italic" textLength="[\d.]+" lengthAdjust="spacingAndGlyphs"/);
  assert.match(svg, /fill="#e2d0a8" fill-opacity="0\.50/);
  assert.match(svg, /stroke="#123" stroke-opacity="0\.53/);
  assert.match(svg, /fill="#674980" fill-opacity="0\.66/);
  assert.match(svg, /stroke="#169" stroke-opacity="0\.66/);
  assert.doesNotMatch(svg, /data-object-id="child"|edge-target|stroke-hit|<foreignObject|<image |<script |fill="#ffffff"\/><g transform/);
  assert.match(api.svg(expanded), /data-object-id="child"[\s\S]*>Folded <\/text>[\s\S]*>idea<\/text>/);
  assert.match(api.svg(expanded), /fill="#ffffff"\/><g transform/);
  assert.equal(api.plan(board, { background: 'board' }).background, '#1e1e1e');
  assert.equal(api.plan(Board.emptyBoard()), null);
});

test('a selection shares the canvas routes, includes selected groups, and can export a connector alone', () => {
  const board = sampleBoard();
  const folded = api.plan(board, { scope: 'selection', ids: ['frame'] });
  const expanded = api.plan(board, { scope: 'selection', ids: ['frame'], includeFolded: true });
  assert.deepEqual(Array.from(folded.drawing.objects, object => object.id), ['frame', 'root']);
  assert.deepEqual(Array.from(expanded.drawing.objects, object => object.id), ['frame', 'root', 'child']);
  assert.deepEqual(Array.from(expanded.drawing.edges, edge => edge.id), ['branch']);
  assert.throws(() => api.plan(board, { scope: 'selection' }), /Select objects or a connector/);

  const figure = api.plan(board, { scope: 'selection', edgeId: 'connector', padding: 0 });
  assert.equal(figure.drawing.objects.length, 0);
  const edge = figure.drawing.edges[0];
  assert.equal(edge.path, api.plan(board).drawing.edges[0].path);
  assert.equal(edge.arrows.length, 2);
  for (const [x, y] of [...edge.points, ...edge.arrows.flat()]) {
    assert.ok(x >= figure.area.x && x < figure.area.x + figure.area.width);
    assert.ok(y >= figure.area.y && y < figure.area.y + figure.area.height);
  }
  assert.match(api.svg(figure), /Take 1 →/);
});

test('connector labels retain paper backings above every wire on transparent and dark figures', () => {
  const board = Board.starterBoard('signal');
  for (const [background, paper, ink] of [['transparent', '#ffffff', '#242426'], ['board', '#1e1e1e', '#e8e8ed']]) {
    const figure = api.plan(board, { background, padding: 0 });
    const svg = api.svg(figure);
    const label = svg.match(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" rx="2" fill="(#[\da-f]+)"\/><text [^<>]+>Input<\/text>/);
    assert.ok(label);
    assert.equal(label[5], paper);
    assert.ok(label[0].includes('fill="' + ink + '"'));
    for (const edge of figure.drawing.edges) {
      const wire = svg.indexOf('<path d="' + edge.path + '"');
      assert.ok(wire >= 0 && wire < label.index);
    }
    const [x, y, width, height] = label.slice(1, 5).map(Number);
    const edge = figure.drawing.edges.find(candidate => candidate.text === 'Input');
    assert.ok(x < edge.label[0] && edge.label[0] < x + width);
    assert.ok(y < edge.label[1] && edge.label[1] < y + height);
    if (background === 'transparent') assert.doesNotMatch(svg, /<rect x="0" y="0"/);
  }
});

test('a named frame has a fixed spatial crop, with the border and intersecting ink inside a separate margin', () => {
  const board = sampleBoard();
  assert.equal(api.listFrames(board)[0].id, 'frame');
  const frame = api.plan(board, { scope: 'frame', frameId: 'frame', padding: 0 });
  assert.equal(frame.title, 'Tracking');
  assert.deepEqual(local(frame.area), { x: -351, y: -151, width: 292, height: 212 });
  assert.deepEqual(local(frame.clip), local(frame.area));
  assert.deepEqual(local(api.plan(board, { scope: 'frame', frameId: 'frame', padding: 20 }).area),
    { x: -371, y: -171, width: 332, height: 252 });
  const svg = api.svg(frame);
  assert.match(svg, /<g transform="translate\(351 151\)"><defs><clipPath id="frame-clip"><rect x="-351" y="-151" width="292" height="212"\/>/);
  assert.match(svg, /<g data-object-id="ink"><path d="M-73 30 L-23 42"/);
  assert.doesNotMatch(svg, /Unrelated outside/);
  assert.throws(() => api.plan(board, { scope: 'frame', frameId: 'outside' }), /Choose a visible frame/);
});

test('a single point stroke receives cap room, and large figures keep a bounded preview and reject raster allocation', () => {
  const board = Board.emptyBoard();
  board.objects = [Board.createObject('stroke', [-0.75, -0.2], { id: 'dot', points: [[0, 0]] })];
  const dot = api.plan(board, { padding: 0 });
  assert.deepEqual(local(dot.area), { x: -2, y: -2, width: 3, height: 3 });
  assert.deepEqual(local(api.dimensions(dot, 2.5)), { width: 8, height: 8 });
  assert.throws(() => api.dimensions(dot, 0), /positive/);
  board.objects.push(Board.createObject('shape', [500000, 350000], { id: 'distant' }));
  const wide = api.plan(board);
  assert.throws(() => api.dimensions(wide), /16.8 megapixels/);
  assert.throws(() => api.dimensions({ area: { width: 5000, height: 4500 } }), /16.8 megapixels/);
  assert.match(api.svg(wide, { preview: true }), /width="1600" height="[1-9][\d]{0,3}"/);
  assert.match(api.svg(wide), new RegExp('width="' + wide.area.width + '" height="' + wide.area.height + '"'));
});
