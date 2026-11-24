const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const Board = require('../board.js');

const fontUses = [];
const measureContext = {
  font: '',
  measureText(value) {
    fontUses.push(this.font);
    const size = Number(this.font.match(/(\d+)px/)?.[1] || 13);
    const multiplier = this.font.includes('bold') ? .7 : .55;
    return { width: Array.from(value).length * size * multiplier };
  },
};
const geometrySource = fs.readFileSync(path.resolve(__dirname, '../geometry.js'), 'utf8');
const Geometry = vm.runInNewContext(geometrySource + '\nBoardGeometry;', {
  BoardModel: Board,
  document: { createElement: () => ({ getContext: () => measureContext }) },
  matchMedia: () => ({ matches: false }),
});

test('phase-three shapes keep rounded corners and new style options round-trip', () => {
  const board = Board.emptyBoard();
  const old = { id: 'old', type: 'shape', x: 0, y: 0, width: 150, height: 46, text: 'Existing' };
  board.objects.push(old, Board.createObject('note', [20, 48], {
    text: 'First\nSecond',
    style: { fill: '#ffeecc', fontSize: 20, fontWeight: 'bold', italic: true },
  }));
  const restored = Board.validateBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(restored.objects[0].shape, 'rounded');
  assert.equal(restored.objects[1].type, 'note');
  assert.deepEqual(restored.objects[1], board.objects[1]);
  assert.equal(Board.createObject('text', [0, 0], { style: { fontWeight: 700 } }).style.fontWeight, 'bold');
  assert.throws(() => Board.createObject('shape', [0, 0], { shape: 'anything' }), /invalid/);
});

test('starter boards have fresh identities, valid contents, and distinct use cases', () => {
  const starters = ['mindmap', 'flowchart', 'signal'].map(kind => Board.starterBoard(kind));
  assert.equal(new Set(starters.map(board => board.id)).size, 3);
  assert.notEqual(Board.starterBoard('mindmap').objects[0].id, starters[0].objects[0].id);
  assert.ok(starters[0].branches.length >= 3);
  assert.ok(starters[1].objects.some(item => item.shape === 'decision'));
  assert.ok(starters[1].links.some(link => link.label === 'No'));
  assert.ok(starters[2].objects.some(item => item.type === 'note'));
  assert.ok(starters[2].objects.some(item => item.shape === 'junction'));
  assert.ok(starters[2].links.some(link => link.label === 'Return' && link.style.dashed));
  for (const starter of starters) assert.deepEqual(Board.validateBoard(starter), starter);
  assert.equal(Board.emptyBoard().objects.length, 0);
});

test('the editor and SVG share shape geometry, line endpoints, and styled text', () => {
  const board = Board.emptyBoard('Styled & sized');
  board.objects = [
    Board.createObject('shape', [0, 0], { id: 'rectangle', shape: 'rectangle' }),
    Board.createObject('shape', [140, 0], { id: 'rounded', shape: 'rounded' }),
    Board.createObject('shape', [310, 0], { id: 'decision', shape: 'decision',
      text: 'Wide words wrap\ninside & center', style: { fontSize: 18, fontWeight: 'bold', italic: true } }),
    Board.createObject('shape', [450, 0], { id: 'circle', shape: 'circle',
      width: 90, height: 52, text: 'One\nTwo\nThree' }),
    Board.createObject('shape', [600, 20], { id: 'line', shape: 'line', width: 120, height: 22, lineDirection: 'up' }),
    Board.createObject('note', [0, 210], { id: 'note', text: 'Note\nmultiline' }),
  ];
  board.links = [{
    id: 'link',
    from: { objectId: 'line', port: 'right' },
    to: { objectId: 'note', port: 'left' },
    style: { route: 'straight' },
  }];
  const drawing = Geometry.scene(Board.validateBoard(board));
  const circle = drawing.byId.get('circle');
  assert.equal(circle.width, circle.height);
  const decision = drawing.byId.get('decision');
  assert.ok(decision.textInset > 11);
  assert.ok(decision.height >= 2 * decision.textHeight + 16);
  assert.ok(fontUses.some(font => /^italic bold 18px /.test(font)));
  assert.equal(Geometry.textStyle(decision).fontWeight, 'bold');
  assert.equal(Geometry.textStyle(decision).textAlign, 'center');
  assert.equal(Geometry.textStyle(drawing.byId.get('note')).alignContent, 'start');
  assert.match(drawing.edges[0].path, /^M720 20 L/);
  const svg = Geometry.svg(drawing, board.title);
  assert.match(svg, /<title>Styled &amp; sized<\/title>/);
  assert.match(svg, /data-object-id="rectangle"><rect[^>]+rx="0"/);
  assert.match(svg, /data-object-id="rounded"><rect[^>]+rx="7"/);
  assert.match(svg, /data-object-id="decision"><polygon/);
  assert.match(svg, /data-object-id="circle"><circle/);
  assert.match(svg, /data-object-id="line"><line x1="600" y1="42" x2="720" y2="20"/);
  assert.match(svg, /font-weight="bold" font-style="italic" text-anchor="middle"/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /multiline/);
  assert.ok(Geometry.bounds(drawing).width >= 720);
});
