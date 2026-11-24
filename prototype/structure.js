/* Structural branch commands and layout for the selected parts of a flow. */
(function (scope) {
  'use strict';
  const model = typeof module !== 'undefined' ? require('./board.js') : scope.BoardModel;
  const branchGap = 28;
  const branchOffset = 52;
  const flowGap = 70;
  const laneGap = 34;

  function branchObject(board, id) {
    const item = board.objects.find(object => object.id === id);
    if (item?.type !== 'branch') throw new Error('Choose a mind map branch.');
    return item;
  }

  function checkSide(side) {
    if (side !== undefined && side !== 'left' && side !== 'right') throw new Error('Choose the left or right side.');
  }

  function siblings(board, parentId, excluding) {
    return board.branches.filter(edge => edge.parentId === parentId && edge.childId !== excluding)
      .sort((first, second) => first.order - second.order);
  }

  function availableID(board) {
    const used = new Set([...board.objects, ...board.links, ...board.branches].map(item => item.id));
    return () => {
      let id;
      do { id = model.uid(); } while (used.has(id));
      used.add(id);
      return id;
    };
  }

  function unfoldPath(objects, edges, origins) {
    const byId = new Map(objects.map(item => [item.id, item]));
    const parents = new Map(edges.map(edge => [edge.childId, edge.parentId]));
    const visited = new Set();
    const queue = [...origins];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      const item = byId.get(id);
      const parent = parents.get(id);
      if (parent) queue.push(parent);
      if (item?.groupId) queue.push(item.groupId);
    }
    return objects.map(item => item.folded && visited.has(item.id) ? { ...item, folded: false } : item);
  }

  function replaceBoardParts(board, objects, branches) {
    // Check the whole candidate before changing either array of the draft.
    model.validateBoard({ ...board, objects, branches });
    board.objects = objects;
    board.branches = branches;
    return board;
  }

  function nextSide(edges) {
    const left = edges.filter(edge => edge.side === 'left').length;
    return left * 2 < edges.length ? 'left' : 'right';
  }

  function placeBranch(board, object, parent, after, side) {
    const x = side === 'left' ? parent.x - branchOffset - object.width : parent.x + parent.width + branchOffset;
    let y = after ? after.y + after.height + branchGap : parent.y + (parent.height - object.height) / 2;
    // Keep manual placements intact and find the first gap in the new node's column.
    const obstacles = model.visibleObjects(board).filter(item => item.type !== 'group'
      && item.x < x + object.width + 12 && item.x + item.width + 12 > x)
      .sort((first, second) => first.y - second.y);
    for (const item of obstacles) {
      if (y + object.height + branchGap <= item.y) break;
      if (item.y + item.height + branchGap > y) y = item.y + item.height + branchGap;
    }
    return { ...object, x, y };
  }

  function addBranch(board, referenceId, { kind = 'child', side } = {}) {
    if (kind !== 'child' && kind !== 'sibling') throw new Error('Choose a child or sibling branch.');
    checkSide(side);
    const reference = branchObject(board, referenceId);
    const incoming = board.branches.find(edge => edge.childId === referenceId);
    const sibling = kind === 'sibling' && incoming;
    const parent = sibling ? branchObject(board, incoming.parentId) : reference;
    if (reference.locked || parent.locked) throw new Error('Unlock this branch before adding to it.');
    const peers = siblings(board, parent.id);
    const parentEdge = board.branches.find(edge => edge.childId === parent.id);
    const branchSide = parentEdge?.side || side || (sibling ? incoming.side : nextSide(peers));
    const id = availableID(board);
    const object = model.createObject('branch', [parent.x, parent.y], { id: id(), groupId: parent.groupId });
    const lastOnSide = [...peers].reverse().find(edge => edge.side === branchSide);
    const after = sibling && incoming.side === branchSide ? reference
      : board.objects.find(item => item.id === lastOnSide?.childId);
    const edge = { id: id(), parentId: parent.id, childId: object.id,
      side: branchSide, order: 0, label: '', style: { route: 'curve', arrow: 'none', dashed: false, color: '' } };
    const insertion = sibling ? peers.findIndex(item => item.id === incoming.id) + 1 : peers.length;
    peers.splice(insertion, 0, edge);
    const order = new Map(peers.map((item, index) => [item.id, index]));
    const branches = [...board.branches, edge].map(item => order.has(item.id) ? { ...item, order: order.get(item.id) } : item);
    const objects = unfoldPath(board.objects, branches, [parent.id]);
    const positioned = placeBranch({ ...board, objects, branches }, object, parent, after, branchSide);
    replaceBoardParts(board, [...objects, positioned], branches);
    return object.id;
  }

  function reparent(board, childId, parentId, side) {
    checkSide(side);
    const child = branchObject(board, childId);
    const parent = branchObject(board, parentId);
    const subtree = new Set([child.id, ...model.descendants(board, child.id)]);
    if (subtree.has(parent.id)) throw new Error('A branch cannot be moved under itself or one of its descendants.');
    if (parent.locked || board.objects.some(item => subtree.has(item.id) && item.locked)) {
      throw new Error('Unlock these branches before moving the subtree.');
    }
    const oldEdge = board.branches.find(edge => edge.childId === child.id);
    const parentEdge = board.branches.find(edge => edge.childId === parent.id);
    const sameParent = oldEdge?.parentId === parent.id;
    const branchSide = parentEdge?.side || side || oldEdge?.side
      || (child.x + child.width / 2 < parent.x + parent.width / 2 ? 'left' : 'right');
    const targetPeers = siblings(board, parent.id, child.id);
    const previousPeers = oldEdge && !sameParent ? siblings(board, oldEdge.parentId, child.id) : [];
    const next = { ...(oldEdge || { id: availableID(board)(), label: '',
      style: { route: 'curve', arrow: 'none', dashed: false, color: '' } }),
    parentId: parent.id, childId: child.id, side: branchSide, order: targetPeers.length };
    if (sameParent) {
      const currentOrder = siblings(board, parent.id).findIndex(edge => edge.id === oldEdge.id);
      targetPeers.splice(currentOrder, 0, next);
    } else targetPeers.push(next);
    const order = new Map([targetPeers, previousPeers].flatMap(edges => edges.map((edge, index) => [edge.id, index])));
    const source = oldEdge ? board.branches.map(edge => edge.id === oldEdge.id ? next : edge) : [...board.branches, next];
    const branches = source.map(edge => {
      const edgeSide = subtree.has(edge.childId) ? branchSide : edge.side;
      const edgeOrder = order.get(edge.id) ?? edge.order;
      return edgeSide === edge.side && edgeOrder === edge.order ? edge : { ...edge, side: edgeSide, order: edgeOrder };
    });
    return replaceBoardParts(board, unfoldPath(board.objects, branches, [parent.id]), branches);
  }

  function traverse(board, id, direction) {
    const visible = new Set(model.visibleObjects(board).filter(item => item.type === 'branch').map(item => item.id));
    if (!visible.has(id)) return null;
    const incoming = board.branches.find(edge => edge.childId === id);
    if (direction === 'parent') return visible.has(incoming?.parentId) ? incoming.parentId : null;
    if (direction === 'child') return siblings(board, id).find(edge => visible.has(edge.childId))?.childId || null;
    if (direction !== 'previous' && direction !== 'next') return null;
    const childIDs = new Set(board.branches.map(edge => edge.childId));
    const row = incoming ? siblings(board, incoming.parentId).map(edge => edge.childId)
      : board.objects.map(item => item.id).filter(key => !childIDs.has(key));
    const options = row.filter(key => visible.has(key));
    return options[options.indexOf(id) + (direction === 'next' ? 1 : -1)] || null;
  }

  function flowLevels(board, ordered) {
    const pending = new Set(ordered.map(item => item.id));
    const children = new Map(ordered.map(item => [item.id, new Map()]));
    const incoming = new Map(ordered.map(item => [item.id, 0]));
    const solidIncoming = new Map(incoming);
    let relationships = 0;
    for (const link of board.links) {
      const from = (link.style.arrow === 'start' ? link.to : link.from).objectId;
      const to = (link.style.arrow === 'start' ? link.from : link.to).objectId;
      if (from === to || !pending.has(from) || !pending.has(to)) continue;
      const row = children.get(from);
      if (!row.has(to)) {
        incoming.set(to, incoming.get(to) + 1);
        relationships++;
      }
      if (!link.style.dashed && !row.get(to)) solidIncoming.set(to, solidIncoming.get(to) + 1);
      row.set(to, row.get(to) || !link.style.dashed);
    }
    if (!relationships) return ordered.map(item => [item]);
    const rank = new Map(ordered.map(item => [item.id, 0]));
    const ready = ordered.filter(item => incoming.get(item.id) === 0).map(item => item.id);
    const ids = ordered.map(item => item.id);
    let nextReady = 0;
    let nextUnscheduled = 0;
    while (pending.size) {
      // Prefer breaking a dashed feedback loop before a solid connection. A
      // solid cycle starts at its visually leading object. Back links stay
      // attached without moving objects that are already placed.
      if (nextReady === ready.length) {
        while (!pending.has(ids[nextUnscheduled])) nextUnscheduled++;
        const feedback = ids.find(id => pending.has(id) && solidIncoming.get(id) === 0);
        ready.push(feedback || ids[nextUnscheduled]);
      }
      const from = ready[nextReady++];
      pending.delete(from);
      for (const [to, solid] of children.get(from)) {
        if (!pending.has(to)) continue;
        rank.set(to, Math.max(rank.get(to), rank.get(from) + 1));
        incoming.set(to, incoming.get(to) - 1);
        if (solid) solidIncoming.set(to, solidIncoming.get(to) - 1);
        if (incoming.get(to) === 0) ready.push(to);
      }
    }
    const levels = [];
    for (const item of ordered) (levels[rank.get(item.id)] ||= []).push(item);
    return levels;
  }

  function arrangeFlow(board, ids, direction, boxes) {
    if (direction !== 'horizontal' && direction !== 'vertical') throw new Error('Choose a flow direction.');
    const selected = new Set(ids);
    const items = model.visibleObjects(board).filter(item => selected.has(item.id) && ['text', 'note', 'shape'].includes(item.type));
    if (items.length < 2) throw new Error('Select at least two visible flow objects to arrange.');
    if (items.some(item => item.locked)) throw new Error('Unlock the selected flow objects before arranging them.');
    const horizontal = direction === 'horizontal';
    const primary = horizontal ? 'x' : 'y';
    const cross = horizontal ? 'y' : 'x';
    const size = horizontal ? 'width' : 'height';
    const crossSize = horizontal ? 'height' : 'width';
    const rect = item => boxes?.get(item.id) || item;
    const ordered = items.sort((first, second) => first[primary] - second[primary] || first[cross] - second[cross]);
    const levels = flowLevels(board, ordered);
    const positions = new Map();
    let first = Math.min(...items.map(item => item[primary]));
    const start = Math.min(...items.map(item => item[cross]));
    for (const level of levels) {
      const lane = [...level].sort((first, second) => first[cross] - second[cross]);
      const breadth = Math.max(...lane.map(item => rect(item)[size]));
      let before = start;
      for (const item of lane) {
        positions.set(item.id, { [primary]: first + (breadth - rect(item)[size]) / 2, [cross]: before });
        before += rect(item)[crossSize] + laneGap;
      }
      first += breadth + flowGap;
    }
    const objects = board.objects.map(item => positions.has(item.id) ? { ...item, ...positions.get(item.id) } : item);
    model.validateBoard({ ...board, objects });
    board.objects = objects;
    return board;
  }

  const api = { addBranch, reparent, traverse, arrangeFlow };
  if (typeof module !== 'undefined') module.exports = api;
  scope.BoardStructure = api;
})(globalThis);
