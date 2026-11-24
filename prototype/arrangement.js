/* Selection transfers and spatial operations shared by the canvas commands. */
(function (scope) {
  'use strict';
  const model = typeof module !== 'undefined' ? require('./board.js') : scope.BoardModel;
  const SELECTION = 'mindmapper.selection';
  const SELECTION_VERSION = 1;
  const GROUP_PADDING = 24;

  function hierarchy(board, unlockedOnly = false) {
    const objects = new Map(board.objects.map(item => [item.id, item]));
    const children = new Map();
    function add(parent, child) {
      if (unlockedOnly && (objects.get(parent)?.locked || objects.get(child)?.locked)) return;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    for (const item of board.objects) if (item.groupId) add(item.groupId, item.id);
    for (const branch of board.branches) add(branch.parentId, branch.childId);
    return { objects, children, unlockedOnly };
  }

  function collect(index, ids) {
    const visited = new Set([...ids].filter(id => {
      const item = index.objects.get(id);
      return item && (!index.unlockedOnly || !item.locked);
    }));
    const queue = [...visited];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const child of index.children.get(queue[cursor]) || []) {
        if (visited.has(child)) continue;
        visited.add(child);
        queue.push(child);
      }
    }
    return visited;
  }

  function selections(index, ids) {
    const entries = [...new Set(ids)].filter(id => index.objects.has(id))
      .map(id => ({ id, members: collect(index, [id]) }));
    return entries.filter(entry => !entries.some(other => other !== entry && other.members.has(entry.id)));
  }

  function frameOf(items) {
    const frame = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const box of items) {
      frame.left = Math.min(frame.left, box.x);
      frame.top = Math.min(frame.top, box.y);
      frame.right = Math.max(frame.right, box.x + box.width);
      frame.bottom = Math.max(frame.bottom, box.y + box.height);
    }
    return frame;
  }

  function selectionBoard({ objects, branches, links }) {
    return model.validateBoard({ format: model.BOARD, version: model.SCHEMA,
      id: 'clipboard', title: 'Selection', objects, branches, links });
  }

  function checkedSelection(payload) {
    if (payload?.format !== SELECTION || payload.version !== SELECTION_VERSION) {
      throw new Error('This Mind Mapper selection format is unsupported.');
    }
    const { objects, branches, links } = selectionBoard(payload);
    if (!objects.length) throw new Error('There are no objects in this selection.');
    const result = { format: SELECTION, version: SELECTION_VERSION, objects, branches, links };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > model.MAX_BYTES) {
      throw new Error('The selection exceeds 20 MB.');
    }
    return result;
  }

  function capture(board, ids) {
    const included = collect(hierarchy(board), ids);
    const objects = board.objects.filter(item => included.has(item.id)).map(item => ({
      ...item, groupId: included.has(item.groupId) ? item.groupId : null,
    }));
    return checkedSelection({
      format: SELECTION, version: SELECTION_VERSION, objects,
      branches: board.branches.filter(edge => included.has(edge.parentId) && included.has(edge.childId)),
      links: board.links.filter(edge => included.has(edge.from.objectId) && included.has(edge.to.objectId)),
    });
  }

  function allocator(board) {
    const occupied = new Set([...board.objects, ...board.branches, ...board.links].map(item => item.id));
    return () => {
      let id;
      do { id = model.uid(); } while (occupied.has(id));
      occupied.add(id);
      return id;
    };
  }

  function insert(board, payload, point) {
    if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error('A pasted selection needs a valid position.');
    }
    const selection = checkedSelection(payload);
    const frame = frameOf(selection.objects);
    const dx = point ? point.x - frame.left : 24;
    const dy = point ? point.y - frame.top : 24;
    const freshID = allocator(board);
    const mapping = new Map(selection.objects.map(item => [item.id, freshID()]));
    const objects = selection.objects.map(item => ({
      ...item, id: mapping.get(item.id), x: item.x + dx, y: item.y + dy,
      groupId: mapping.get(item.groupId) || null,
    }));
    const branches = selection.branches.map(edge => ({
      ...edge, id: freshID(), parentId: mapping.get(edge.parentId), childId: mapping.get(edge.childId),
    }));
    const links = selection.links.map(edge => ({
      ...edge, id: freshID(), from: { ...edge.from, objectId: mapping.get(edge.from.objectId) },
      to: { ...edge.to, objectId: mapping.get(edge.to.objectId) },
      ...(edge.waypoints ? { waypoints: edge.waypoints.map(([x, y]) => [x + dx, y + dy]) } : {}),
    }));
    const destination = model.validateBoard({
      ...board, objects: [...board.objects, ...objects], branches: [...board.branches, ...branches],
      links: [...board.links, ...links],
    });
    board.objects = orderedMembers(destination.objects);
    board.branches = destination.branches;
    board.links = destination.links;
    const children = new Set(branches.map(edge => edge.childId));
    return objects.filter(item => !item.groupId && !children.has(item.id)).map(item => item.id);
  }

  function move(board, ids, dx, dy) {
    const moving = collect(hierarchy(board, true), ids);
    for (const item of board.objects) {
      if (!moving.has(item.id)) continue;
      item.x += dx;
      item.y += dy;
    }
    return board;
  }

  function checkedUnits(board, ids) {
    const index = hierarchy(board);
    const units = selections(index, ids);
    const all = new Set();
    for (const unit of units) {
      for (const member of unit.members) {
        if (index.objects.get(member).locked) throw new Error('Unlock the selected objects and their contents before arranging them.');
        if (all.has(member)) throw new Error('Arrange the overlapping groups or branches separately.');
        all.add(member);
      }
    }
    return { units, all, index };
  }

  function leadingValue(frame, action) {
    switch (action) {
      case 'left': return frame.left;
      case 'center': return (frame.left + frame.right) / 2;
      case 'right': return frame.right;
      case 'top': return frame.top;
      case 'middle': return (frame.top + frame.bottom) / 2;
      case 'bottom': return frame.bottom;
      default: throw new Error('Choose an alignment direction.');
    }
  }

  function align(board, ids, action, boxes) {
    const { units, index } = checkedUnits(board, ids);
    const distribute = action === 'distribute-x' || action === 'distribute-y';
    const horizontal = ['left', 'center', 'right', 'distribute-x'].includes(action);
    if (!horizontal && !['top', 'middle', 'bottom', 'distribute-y'].includes(action)) {
      throw new Error('Choose an alignment direction.');
    }
    if (units.length < (distribute ? 3 : 2)) throw new Error(distribute ? 'Select at least three objects to distribute.' : 'Select at least two objects to align.');
    const first = horizontal ? 'left' : 'top';
    const last = horizontal ? 'right' : 'bottom';
    const axis = horizontal ? 'x' : 'y';
    const items = units.map(unit => ({
      ...unit, bounds: frameOf([...unit.members].map(id => boxes?.get(id) || index.objects.get(id))),
    }));
    const extent = {
      left: Math.min(...items.map(unit => unit.bounds.left)), top: Math.min(...items.map(unit => unit.bounds.top)),
      right: Math.max(...items.map(unit => unit.bounds.right)), bottom: Math.max(...items.map(unit => unit.bounds.bottom)),
    };
    const shift = (unit, delta) => {
      for (const id of unit.members) index.objects.get(id)[axis] += delta;
    };
    if (!distribute) {
      const target = leadingValue(extent, action);
      for (const unit of items) shift(unit, target - leadingValue(unit.bounds, action));
      return board;
    }
    items.sort((a, b) => a.bounds[first] - b.bounds[first] || a.bounds[last] - b.bounds[last]);
    const span = unit => unit.bounds[last] - unit.bounds[first];
    const gap = (items.at(-1).bounds[last] - items[0].bounds[first] - items.reduce((total, unit) => total + span(unit), 0)) / (items.length - 1);
    let destination = items[0].bounds[first];
    for (const unit of items) {
      shift(unit, destination - unit.bounds[first]);
      destination += span(unit) + gap;
    }
    return board;
  }

  function group(board, ids, boxes) {
    const { units, all, index } = checkedUnits(board, ids);
    if (units.length < 2) throw new Error('Select at least two objects to group.');
    const { left, top, right, bottom } = frameOf([...all].map(id => boxes?.get(id) || index.objects.get(id)));
    const memberRoots = units.map(unit => index.objects.get(unit.id));
    const sameParent = memberRoots.every(item => item.groupId === memberRoots[0].groupId);
    const frame = {
      id: allocator(board)(), type: 'group', text: 'Frame',
      x: left - GROUP_PADDING, y: top - GROUP_PADDING - 16,
      width: right - left + 2 * GROUP_PADDING, height: bottom - top + 2 * GROUP_PADDING + 16,
      groupId: sameParent ? memberRoots[0].groupId : null,
      style: {}, locked: false, folded: false,
    };
    // Keep whole branch trees inside the new frame, while preserving nested frames.
    const members = new Set([...all].filter(id => !all.has(index.objects.get(id).groupId)));
    const objects = board.objects.map(item => members.has(item.id) ? { ...item, groupId: frame.id } : item);
    const first = objects.findIndex(item => all.has(item.id));
    objects.splice(first, 0, frame);
    board.objects = orderedMembers(model.validateBoard({ ...board, objects }).objects);
    return frame.id;
  }

  function ungroup(board, ids) {
    const selected = new Set(ids);
    const available = new Map(board.objects.map(item => [item.id, item]));
    const frames = new Set(board.objects.filter(item => selected.has(item.id) && item.type === 'group').map(item => item.id));
    if ([...frames].some(id => available.get(id).locked)) throw new Error('Unlock the selected frames before ungrouping.');
    if (frames.size === 0) return [];
    const released = [];
    board.objects = board.objects.filter(item => !frames.has(item.id)).map(item => {
      if (!frames.has(item.groupId)) return item;
      let groupId = item.groupId;
      while (frames.has(groupId)) groupId = available.get(groupId).groupId;
      released.push(item.id);
      return { ...item, groupId };
    });
    board.links = board.links.filter(edge => !frames.has(edge.from.objectId) && !frames.has(edge.to.objectId));
    return released;
  }

  function orderedMembers(objects) {
    const byId = new Map(objects.map(item => [item.id, item]));
    const arranged = new Map();
    function add(item) {
      if (arranged.has(item.id)) return;
      const parent = byId.get(item.groupId);
      if (parent) add(parent);
      arranged.set(item.id, item);
    }
    for (const item of objects) add(item);
    return [...arranged.values()];
  }

  function order(board, ids, direction) {
    if (direction !== 'front' && direction !== 'back') throw new Error('Choose a stacking direction.');
    const { all } = checkedUnits(board, ids);
    const moved = board.objects.filter(item => all.has(item.id));
    const remaining = board.objects.filter(item => !all.has(item.id));
    board.objects = orderedMembers(direction === 'front' ? [...remaining, ...moved] : [...moved, ...remaining]);
    return board;
  }

  function anchors(start, end) {
    return [start, (start + end) / 2, end];
  }

  function alignment(source, targets, delta, limit) {
    let best;
    for (const at of targets) {
      for (const anchor of source) {
        const adjustment = at - anchor - delta;
        const distance = Math.abs(adjustment);
        if (distance <= limit && (!best || distance < best.distance)) best = { at, value: delta + adjustment, distance };
      }
    }
    return best;
  }

  function snap(board, ids, dx, dy, { grid = false, objects = true, threshold = 7, gridSize = 18, boxes } = {}) {
    if (!grid && !objects) return { dx, dy };
    const moving = collect(hierarchy(board, true), ids);
    const shown = model.visibleObjects(board);
    const box = item => boxes?.get(item.id) || item;
    const active = shown.filter(item => moving.has(item.id)).map(box);
    if (!active.length) return { dx, dy };
    const frame = frameOf(active);
    const stationary = objects ? shown.filter(item => !moving.has(item.id)).map(box) : [];
    const xs = stationary.flatMap(item => anchors(item.x, item.x + item.width));
    const ys = stationary.flatMap(item => anchors(item.y, item.y + item.height));
    const objectX = alignment(anchors(frame.left, frame.right), xs, dx, threshold);
    const objectY = alignment(anchors(frame.top, frame.bottom), ys, dy, threshold);
    const gridOK = grid && Number.isFinite(gridSize) && gridSize > 0;
    const gridX = Math.round((frame.left + dx) / gridSize) * gridSize;
    const gridY = Math.round((frame.top + dy) / gridSize) * gridSize;
    const result = {
      dx: objectX?.value ?? (gridOK ? gridX - frame.left : dx),
      dy: objectY?.value ?? (gridOK ? gridY - frame.top : dy),
    };
    if (objectX || gridOK) result.xGuide = objectX?.at ?? gridX;
    if (objectY || gridOK) result.yGuide = objectY?.at ?? gridY;
    return result;
  }

  function marquee(boxes, { x, y, width, height }) {
    const left = Math.min(x, x + width), right = Math.max(x, x + width);
    const top = Math.min(y, y + height), bottom = Math.max(y, y + height);
    return [...boxes].filter(([, box]) => {
      const r = box.x + box.width, b = box.y + box.height;
      if (box.type === 'group') return box.x >= left && r <= right && box.y >= top && b <= bottom;
      return box.x < right && r > left && box.y < bottom && b > top;
    }).map(([id]) => id);
  }

  const api = { SELECTION, capture, insert, move, align, group, ungroup, order, snap, marquee };
  if (typeof module !== 'undefined') module.exports = api;
  scope.BoardArrangement = api;
})(globalThis);
