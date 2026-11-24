/* Separate the spatial board from the editor and from the 0.1.6 file format. */
(function (scope) {
  'use strict';
  const legacyModel = typeof module !== 'undefined' ? require('../src/model.js') : scope.Mindmap;
  const BOARD = 'mindmapper.board';
  const WORKSPACE = 'mindmapper.workspace';
  const SCHEMA = 1;
  const MAX_BYTES = legacyModel.MAX_LIBRARY_BYTES;
  const MAX_WAYPOINTS = 64;
  const uid = legacyModel.uid;
  const TYPES = ['text', 'note', 'shape', 'branch', 'stroke', 'group'];
  const SHAPES = ['rectangle', 'rounded', 'decision', 'circle', 'line', 'junction'];
  const PORTS = ['auto', 'left', 'right', 'top', 'bottom'];
  const ROUTES = ['straight', 'curve', 'elbow'];
  const ARROWS = ['none', 'start', 'end', 'both'];
  const own = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
  const defaultMeasure = (value, size) => Array.from(value).length * size * .62;

  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return value;
  }

  function list(value, limit, label, required = false) {
    if (!Array.isArray(value) || value.length > limit || (required && !value.length)) {
      throw new Error(`${label} must contain ${required ? '1' : '0'} to ${limit} items.`);
    }
    return value;
  }

  function identity(value, label) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
        ['__proto__', 'constructor', 'prototype'].includes(value)) {
      throw new Error(`${label} has an invalid ID.`);
    }
    return value;
  }

  function text(value, limit, label, fallback = '') {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} is invalid or too long.`);
    return value;
  }

  function number(value, minimum, maximum, label, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its supported range.`);
    return value;
  }

  function pick(value, options, label, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!options.includes(value)) throw new Error(`${label} is invalid.`);
    return value;
  }

  function color(value, label) {
    if (value === undefined || value === '' || value === 'default') return '';
    if (typeof value !== 'string' || !/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|none)$/i.test(value)) {
      throw new Error(`${label} must be a hex colour, transparent or none.`);
    }
    return value;
  }

  function objectStyle(value = {}) {
    object(value, 'Object style');
    const style = {
      fill: color(value.fill, 'Fill'), stroke: color(value.stroke, 'Stroke'),
      textColor: color(value.textColor, 'Text colour'),
    };
    if (value.fontSize !== undefined) style.fontSize = number(value.fontSize, 8, 96, 'Font size');
    if (value.fontWeight !== undefined) {
      const weight = value.fontWeight === 400 ? 'normal' : value.fontWeight === 700 ? 'bold' : value.fontWeight;
      style.fontWeight = pick(weight, ['normal', 'bold'], 'Font weight');
    }
    if (value.italic !== undefined) {
      if (typeof value.italic !== 'boolean') throw new Error('Italic must be on or off.');
      style.italic = value.italic;
    }
    return style;
  }

  function linkStyle(value = {}) {
    object(value, 'Connector style');
    return {
      route: pick(value.route, ROUTES, 'Route', 'curve'),
      arrow: pick(value.arrow, ARROWS, 'Arrowheads', 'end'),
      dashed: Boolean(value.dashed), color: color(value.color, 'Connector colour'),
    };
  }

  function viewSettings(value = {}) {
    object(value, 'Board view');
    return {
      x: number(value.x, -4e6, 4e6, 'Horizontal pan', 0),
      y: number(value.y, -4e6, 4e6, 'Vertical pan', 0),
      zoom: number(value.zoom, .1, 4, 'Zoom', 1),
    };
  }

  function boardObject(input) {
    object(input, 'Board item');
    const result = {
      id: identity(input.id, 'Board item'),
      type: pick(input.type, TYPES, 'Object type'),
      x: number(input.x, -2e6, 2e6, 'Horizontal position'),
      y: number(input.y, -2e6, 2e6, 'Vertical position'),
      width: number(input.width, 1, 1e6, 'Object width'),
      height: number(input.height, 1, 1e6, 'Object height'),
      text: text(input.text, 20000, 'Object text'),
      notes: text(input.notes, 20000, 'Object notes'),
      source: text(input.source, 2000, 'Object source'),
      style: objectStyle(input.style),
      groupId: input.groupId == null ? null : identity(input.groupId, 'Group'),
      locked: Boolean(input.locked),
      folded: Boolean(input.folded),
    };
    if (result.type === 'shape') {
      result.shape = pick(input.shape, SHAPES, 'Shape', 'rounded');
      if (result.shape === 'line') result.lineDirection = pick(input.lineDirection, ['down', 'up'], 'Line direction', 'down');
    }
    if (result.type === 'stroke') {
      result.points = list(input.points, 25000, 'Stroke points', true).map(point => {
        if (!Array.isArray(point) || point.length !== 2) throw new Error('A stroke point must contain x and y.');
        return [
          number(point[0], -1e6, 1e6, 'Stroke point x'),
          number(point[1], -1e6, 1e6, 'Stroke point y'),
        ];
      });
    }
    return result;
  }

  function checkHierarchy(parents, label) {
    // Colour the completed chains to keep validation linear with many objects.
    const depths = new Map();
    for (const first of parents.keys()) {
      const chain = new Set();
      let next = first;
      while (parents.has(next) && !depths.has(next)) {
        if (chain.has(next)) throw new Error(`${label} contains a cycle.`);
        if (chain.size >= 100) throw new Error(`${label} exceeds 100 levels.`);
        chain.add(next);
        next = parents.get(next);
      }
      let depth = depths.get(next) || 0;
      for (const id of Array.from(chain).reverse()) {
        if (++depth > 100) throw new Error(`${label} exceeds 100 levels.`);
        depths.set(id, depth);
      }
    }
  }

  function legacySettings(input) {
    const value = object(input, 'Legacy properties');
    return {
      version: pick(value.version, [1, 2, 3, 4], 'Original version'),
      rootId: identity(value.rootId, 'Original root'),
      layoutMode: pick(value.layoutMode, ['tree', 'free'], 'Original layout'),
      snap: Boolean(value.snap),
      defaultLinkStyle: linkStyle(value.defaultLinkStyle),
      updatedAt: number(value.updatedAt, -1e15, 1e15, 'Original modification date', 0),
    };
  }

  function validateBoard(input) {
    if (!input || input.format !== BOARD || input.version !== SCHEMA) throw new Error('Expected a Mind Mapper board with version 1.');
    const ids = new Set();
    function unique(value, label) {
      const id = identity(value, label);
      if (ids.has(id)) throw new Error(`${label} has a duplicate ID.`);
      ids.add(id);
      return id;
    }
    const objects = list(input.objects, 4000, 'Board objects').map(boardObject);
    const byId = new Map(objects.map(item => [unique(item.id, 'Board item'), item]));
    const groups = new Map();
    for (const item of objects) {
      if (!item.groupId) continue;
      if (byId.get(item.groupId)?.type !== 'group') throw new Error('An object references a missing group.');
      groups.set(item.id, item.groupId);
    }
    checkHierarchy(groups, 'Group membership');

    const parents = new Map();
    const branches = list(input.branches, 4000, 'Branches').map(record => {
      object(record, 'Branch');
      const parentId = identity(record.parentId, 'Branch parent');
      const childId = identity(record.childId, 'Branch child');
      if (byId.get(parentId)?.type !== 'branch' || byId.get(childId)?.type !== 'branch') {
        throw new Error('Each branch must connect two existing branch objects.');
      }
      if (parents.has(childId)) throw new Error('A branch can have only one parent.');
      parents.set(childId, parentId);
      const order = number(record.order, 0, 4000, 'Sibling order', 0);
      if (!Number.isInteger(order)) throw new Error('Sibling order must be an integer.');
      return {
        id: unique(record.id, 'Branch'), parentId, childId,
        side: pick(record.side, ['left', 'right'], 'Branch side', 'right'), order,
        label: text(record.label, 500, 'Branch label'), style: linkStyle(record.style),
      };
    });
    checkHierarchy(parents, 'Branches');

    function endpoint(value) {
      const record = object(value, 'Connector endpoint');
      const objectId = identity(record.objectId, 'Connector endpoint');
      if (!byId.has(objectId)) throw new Error('A connector endpoint references a missing object.');
      return { objectId, port: pick(record.port, PORTS, 'Connector port', 'auto') };
    }
    const links = list(input.links, 6000, 'Connectors').map(record => {
      object(record, 'Connector');
      const link = {
        id: unique(record.id, 'Connector'), from: endpoint(record.from), to: endpoint(record.to),
        label: text(record.label, 500, 'Connector label'), style: linkStyle(record.style),
      };
      if (record.waypoints !== undefined) {
        const points = list(record.waypoints, MAX_WAYPOINTS, 'Connector waypoints').map(point => {
          if (!Array.isArray(point) || point.length !== 2) throw new Error('A waypoint must contain x and y.');
          return [number(point[0], -4e6, 4e6, 'Waypoint x'), number(point[1], -4e6, 4e6, 'Waypoint y')];
        });
        if (points.length) link.waypoints = points;
      }
      return link;
    });
    const board = {
      format: BOARD, version: SCHEMA, id: identity(input.id, 'Board'),
      title: text(input.title, 500, 'Board title', 'Untitled board'),
      objects, links, branches, view: viewSettings(input.view),
    };
    if (input.legacy !== undefined) board.legacy = legacySettings(input.legacy);
    return board;
  }

  function validateWorkspace(input) {
    if (!input || input.format !== WORKSPACE || input.version !== SCHEMA) {
      throw new Error('Expected a Mind Mapper workspace with version 1.');
    }
    const boards = list(input.boards, 200, 'Workspace boards', true).map(validateBoard);
    if (new Set(boards.map(board => board.id)).size !== boards.length) throw new Error('Workspace has duplicate board IDs.');
    if (!boards.some(board => board.id === input.activeBoardId)) throw new Error('The active board is missing.');
    const result = { format: WORKSPACE, version: SCHEMA, activeBoardId: input.activeBoardId, boards };
    if (legacyModel.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('The workspace exceeds 20 MB.');
    return result;
  }

  function emptyBoard(title = 'Untitled board') {
    return validateBoard({ format: BOARD, version: SCHEMA, id: uid(), title, objects: [], links: [], branches: [] });
  }

  function createWorkspace(board = emptyBoard()) {
    return validateWorkspace({ format: WORKSPACE, version: SCHEMA, activeBoardId: board.id, boards: [board] });
  }

  function createObject(type, [x, y], options = {}) {
    pick(type, TYPES, 'Object type');
    object(options, 'Object options');
    const sizes = {
      text: [200, 46], note: [184, 86], shape: [150, 50],
      branch: [150, 46], group: [286, 185], stroke: [46, 46],
    };
    const shapeSizes = { decision: [144, 92], circle: [96, 96], line: [144, 1], junction: [12, 12] };
    const [width, height] = (type === 'shape' && own(shapeSizes, options.shape) ? shapeSizes[options.shape] : sizes[type]);
    const defaults = type === 'stroke' ? { points: [[0, 0]] } : {};
    return boardObject({ id: uid(), width, height, ...defaults, ...options, type, x, y });
  }

  const starterFactories = {
    mindmap() {
      const board = emptyBoard('Mind map');
      const root = createObject('branch', [-80, -23], { text: 'Main idea', style: { fontWeight: 'bold' } });
      const branches = [
        createObject('branch', [-305, -23], { text: 'Questions' }),
        createObject('branch', [145, -84], { text: 'Ideas' }),
        createObject('branch', [145, 38], { text: 'Next steps' }),
      ];
      board.objects = [root, ...branches];
      board.branches = branches.map((child, order) => ({
        id: uid(), parentId: root.id, childId: child.id,
        side: order === 0 ? 'left' : 'right', order, style: { arrow: 'none' },
      }));
      return board;
    },
    flowchart() {
      const board = emptyBoard('Flowchart');
      const start = createObject('shape', [-314, -25], { shape: 'rounded', text: 'Start' });
      const decision = createObject('shape', [-74, -46], { shape: 'decision', text: 'Ready?' });
      const finish = createObject('shape', [174, -25], { shape: 'rounded', text: 'Finish' });
      const revise = createObject('shape', [-78, 143], { shape: 'rectangle', text: 'Revise' });
      board.objects = [start, decision, finish, revise];
      board.links = [
        starterConnector(start, 'right', decision, 'left'),
        starterConnector(decision, 'right', finish, 'left', 'Yes'),
        starterConnector(decision, 'bottom', revise, 'top', 'No'),
        starterConnector(revise, 'left', start, 'bottom'),
      ];
      return board;
    },
    signal() {
      const board = emptyBoard('Signal flow');
      const frame = createObject('group', [-420, -112], { width: 840, height: 282, text: 'Signal path' });
      const allow = { shape: 'rectangle', groupId: frame.id };
      const source = createObject('shape', [-390, -25], { ...allow, text: 'Source' });
      const processor = createObject('shape', [-75, -25], { ...allow, text: 'Processing' });
      const output = createObject('shape', [240, -25], { ...allow, text: 'Output' });
      const split = createObject('shape', [150, -6], { ...allow, shape: 'junction' });
      const meter = createObject('shape', [240, 93], { ...allow, text: 'Meter' });
      const note = createObject('note', [-75, 198], { text: 'Patch notes' });
      const send = starterConnector(processor, 'right', split, 'auto', 'Send');
      send.style.arrow = 'none';
      board.objects = [frame, source, processor, output, split, meter, note];
      board.links = [
        starterConnector(source, 'right', processor, 'left', 'Input'),
        send,
        starterConnector(split, 'right', output, 'left'),
        starterConnector(split, 'bottom', meter, 'left'),
        starterConnector(output, 'bottom', processor, 'bottom', 'Return', true),
      ];
      return board;
    },
  };

  function starterConnector(from, fromPort, to, toPort, label = '', dashed = false) {
    return {
      id: uid(), from: { objectId: from.id, port: fromPort }, to: { objectId: to.id, port: toPort },
      label, style: { route: 'elbow', dashed },
    };
  }

  function starterBoard(kind) {
    if (!own(starterFactories, kind)) throw new Error('Unknown board starter.');
    return validateBoard(starterFactories[kind]());
  }

  function exampleBoard() {
    const board = emptyBoard('Studio routing');
    board.objects = [
      { id: 'frame', type: 'group', x: -354, y: -208, width: 706, height: 192, text: 'Signal path' },
      { id: 'mic', type: 'shape', x: -324, y: -141, width: 156, height: 62, text: 'Microphone\nInput', groupId: 'frame' },
      { id: 'preamp', type: 'shape', x: -75, y: -141, width: 154, height: 62, text: 'Trim gain\nPreamp', groupId: 'frame' },
      { id: 'monitor', type: 'shape', x: 172, y: -141, width: 150, height: 62, text: 'Monitor\nOutput', groupId: 'frame' },
      { id: 'takes', type: 'branch', x: -324, y: 78, width: 156, height: 50, text: 'Record takes' },
      { id: 'dry-take', type: 'branch', x: -94, y: 46, width: 125, height: 46, text: 'Dry take' },
      { id: 'room-mic', type: 'branch', x: -94, y: 110, width: 125, height: 46, text: 'Room mic' },
      { id: 'note', type: 'text', x: 150, y: 63, width: 172, height: 54, text: 'Listening notes\nCheck room tone' },
      { id: 'waveform', type: 'stroke', x: 180, y: 135, width: 105, height: 30, style: { stroke: '#486784' },
        points: [[0, 17], [15, 17], [24, 6], [33, 27], [45, 11], [55, 20], [70, 12], [81, 17], [105, 17]] },
    ];
    board.links = [
      { id: 'to-preamp', from: { objectId: 'mic', port: 'right' }, to: { objectId: 'preamp', port: 'left' }, label: 'mic level', style: { route: 'straight' } },
      { id: 'to-monitor', from: { objectId: 'preamp', port: 'right' }, to: { objectId: 'monitor', port: 'left' }, label: 'line out', style: { route: 'straight' } },
      { id: 'feedback', from: { objectId: 'monitor', port: 'bottom' }, to: { objectId: 'preamp', port: 'bottom' }, label: 'adjust gain', style: { route: 'elbow', dashed: true } },
    ];
    board.branches = [
      { id: 'take-dry', parentId: 'takes', childId: 'dry-take', side: 'right', order: 0, style: { arrow: 'none' } },
      { id: 'take-room', parentId: 'takes', childId: 'room-mic', side: 'right', order: 1, style: { arrow: 'none' } },
    ];
    return validateBoard(board);
  }

  function importStyle(record) {
    const routes = { 'soft-s': 'curve', 'strict-s': 'elbow', straight: 'straight' };
    const arrow = { line: 'none', arrow: record.connectorReverse ? 'start' : 'end', both: 'both' };
    return {
      route: routes[record.connectorStyle] || 'curve',
      arrow: arrow[record.connectorType] || 'none',
      dashed: record.connectorDashed,
      color: record.color,
    };
  }

  function convertMap(map, originalVersion, measure) {
    // Capture all branches, even folded ones. Keeping their world coordinates
    // lets them unfold in place and avoids reflowing neighbouring free objects.
    const data = map.data;
    const boxes = legacyModel.layout(data, measure, true);
    const branchRecords = [];
    const usedIds = new Set([...Object.keys(data.nodes), ...data.links.map(link => link.id)]);
    let branchCounter = 0;
    const objects = Object.values(data.nodes).map(node => {
      const box = boxes[node.id];
      for (const [order, id] of node.children.entries()) {
        const child = data.nodes[id];
        let branchId;
        do { branchId = 'legacy-branch-' + ++branchCounter; } while (usedIds.has(branchId));
        usedIds.add(branchId);
        branchRecords.push({
          id: branchId, parentId: node.id, childId: id, side: child.side, order,
          label: child.connectorLabel, style: importStyle(child),
        });
      }
      return {
        id: node.id, type: 'branch', text: node.text, notes: node.notes, source: node.source,
        x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height,
        style: { stroke: node.color, fontSize: box.font }, folded: node.collapsed,
      };
    });
    const links = data.links.map(link => ({
      id: link.id, from: { objectId: link.from }, to: { objectId: link.to },
      label: link.connectorLabel, style: importStyle(link),
    }));
    return validateBoard({
      format: BOARD, version: SCHEMA, id: map.id, title: map.name, objects, links, branches: branchRecords,
      view: { x: data.panX, y: data.panY, zoom: data.zoom },
      legacy: {
        version: originalVersion, rootId: data.rootId, layoutMode: data.layoutMode, snap: data.snap, updatedAt: map.updatedAt,
        defaultLinkStyle: importStyle({ connectorType: data.defaultConnectorType, connectorStyle: data.connectorStyle }),
      },
    });
  }

  function importDocument(input, measure = defaultMeasure) {
    if (input?.format === BOARD) return { boards: [validateBoard(input)], warnings: [] };
    if (input?.format === WORKSPACE) {
      const workspace = validateWorkspace(input);
      return { boards: workspace.boards, warnings: [] };
    }
    if (input?.format !== undefined) throw new Error('This document format is not supported.');
    const library = legacyModel.validateLibrary(input);
    const warnings = [];
    if (input.maps.some(map => own(map.data, 'autoZoom'))) warnings.push('The legacy auto-zoom preference was replaced with a saved viewport.');
    return { boards: library.maps.map(map => convertMap(map, input.version, measure)), warnings };
  }

  function addImportedBoards(workspace, boards) {
    list(boards, 200, 'Imported boards', true);
    const ids = new Set(workspace.boards.map(board => board.id));
    const copies = boards.map(record => {
      const board = validateBoard(record);
      while (ids.has(board.id)) board.id = uid();
      ids.add(board.id);
      return board;
    });
    return validateWorkspace({
      ...workspace, activeBoardId: copies[0].id, boards: [...workspace.boards, ...copies],
    });
  }

  function childIndex(edges, parentField, childField) {
    const children = new Map();
    for (const edge of edges) {
      const parent = edge[parentField];
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(edge[childField]);
    }
    return children;
  }

  function walkChildren(children, roots) {
    const visited = new Set(roots);
    const queue = [...roots];
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]) || []) {
        if (visited.has(child)) continue;
        visited.add(child);
        queue.push(child);
      }
    }
    return queue.slice(roots.length);
  }

  function descendants(board, id) {
    const edges = [...board.branches].sort((a, b) => a.order - b.order);
    return walkChildren(childIndex(edges, 'parentId', 'childId'), [id]);
  }

  function visibleObjects(board) {
    const combined = childIndex(board.branches, 'parentId', 'childId');
    for (const item of board.objects) {
      if (!item.groupId) continue;
      if (!combined.has(item.groupId)) combined.set(item.groupId, []);
      combined.get(item.groupId).push(item.id);
    }
    const folded = board.objects.filter(item => item.folded).map(item => item.id);
    const hidden = new Set();
    // Folded ancestors hide their descendants, including other folded objects.
    const queue = folded.flatMap(id => combined.get(id) || []);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (hidden.has(id)) continue;
      hidden.add(id);
      queue.push(...(combined.get(id) || []));
    }
    return hidden.size ? board.objects.filter(item => !hidden.has(item.id)) : board.objects;
  }

  function relayoutBranch(board, id) {
    const ids = new Set([id, ...descendants(board, id)]);
    const items = new Map(board.objects.filter(item => ids.has(item.id)).map(item => [item.id, item]));
    const root = items.get(id);
    if (root?.type !== 'branch') return board;
    const nodes = Object.fromEntries([...items].map(([key, item]) => [key, {
      id: key, parentId: null, children: [], side: null, x: item.x + item.width / 2, y: item.y + item.height / 2,
    }]));
    for (const edge of [...board.branches].sort((a, b) => a.order - b.order)) {
      if (!ids.has(edge.parentId) || !ids.has(edge.childId)) continue;
      nodes[edge.parentId].children.push(edge.childId);
      nodes[edge.childId].parentId = edge.parentId;
      nodes[edge.childId].side = edge.side;
    }
    const boxes = legacyModel.layout({ rootId: id, nodes, layoutMode: 'tree' }, defaultMeasure, true, node => {
      const item = items.get(node.id);
      return { width: item.width, height: item.height };
    });
    for (const [key, item] of items) {
      if (key === id || item.locked) continue;
      item.x = boxes[key].x - item.width / 2;
      item.y = boxes[key].y - item.height / 2;
    }
    return board;
  }

  function moveObjects(board, ids, dx, dy) {
    const movable = board.objects.filter(item => !item.locked);
    const allowed = new Set(movable.map(item => item.id));
    const roots = [...new Set(ids)].filter(id => allowed.has(id));
    const branchChildren = childIndex(board.branches.filter(edge => allowed.has(edge.childId)), 'parentId', 'childId');
    const groupChildren = childIndex(movable, 'groupId', 'id');
    const moved = new Set([...roots, ...walkChildren(branchChildren, roots)]);
    for (const child of walkChildren(groupChildren, [...moved])) moved.add(child);
    for (const item of movable) {
      if (!moved.has(item.id)) continue;
      item.x += dx;
      item.y += dy;
    }
    return board;
  }

  function detachBranch(board, id) {
    board.branches = board.branches.filter(edge => edge.childId !== id);
    return board;
  }

  function deleteObjects(board, ids) {
    const roots = [...new Set(ids)];
    const removed = new Set([...roots, ...walkChildren(childIndex(board.branches, 'parentId', 'childId'), roots)]);
    const byId = new Map(board.objects.map(item => [item.id, item]));
    board.objects = board.objects.filter(item => !removed.has(item.id));
    for (const item of board.objects) {
      while (removed.has(item.groupId)) item.groupId = byId.get(item.groupId)?.groupId || null;
    }
    board.branches = board.branches.filter(edge => !removed.has(edge.parentId) && !removed.has(edge.childId));
    board.links = board.links.filter(edge => !removed.has(edge.from.objectId) && !removed.has(edge.to.objectId));
    return board;
  }

  function duplicateBranch(board, id, offset = 40) {
    if (!board.objects.some(item => item.id === id && item.type === 'branch')) return null;
    const mapping = new Map([id, ...descendants(board, id)].map(key => [key, uid()]));
    for (const item of [...board.objects]) {
      if (!mapping.has(item.id)) continue;
      board.objects.push({ ...legacyModel.clone(item), id: mapping.get(item.id), x: item.x + offset, y: item.y + offset });
    }
    for (const edge of [...board.branches]) {
      if (!mapping.has(edge.parentId) || !mapping.has(edge.childId)) continue;
      board.branches.push({ ...legacyModel.clone(edge), id: uid(), parentId: mapping.get(edge.parentId), childId: mapping.get(edge.childId) });
    }
    for (const edge of [...board.links]) {
      if (!mapping.has(edge.from.objectId) || !mapping.has(edge.to.objectId)) continue;
      const copy = {
        ...legacyModel.clone(edge), id: uid(),
        from: { ...edge.from, objectId: mapping.get(edge.from.objectId) },
        to: { ...edge.to, objectId: mapping.get(edge.to.objectId) },
      };
      if (edge.waypoints) copy.waypoints = edge.waypoints.map(([x, y]) => [x + offset, y + offset]);
      board.links.push(copy);
    }
    return mapping.get(id);
  }

  const api = {
    SCHEMA, BOARD, WORKSPACE, MAX_BYTES, MAX_WAYPOINTS, SHAPES, uid, emptyBoard, exampleBoard, createWorkspace, createObject, starterBoard,
    validateBoard, validateWorkspace, importDocument, addImportedBoards,
    descendants, visibleObjects, relayoutBranch, moveObjects, detachBranch, deleteObjects, duplicateBranch,
  };
  if (typeof module !== 'undefined') module.exports = api;
  scope.BoardModel = api;
})(globalThis);
