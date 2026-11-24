/* Freehand samples and swept erasing use world coordinates independently of the view. */
(function (scope) {
  'use strict';

  const model = typeof module !== 'undefined' ? require('./board.js') : scope.BoardModel;
  const maxPoints = 25000;
  const safeExtent = 1e8;
  const padding = 3;
  const epsilon = 1e-9;
  const maxChecks = 2000000;

  function same(a, b) {
    return a[0] === b[0] && a[1] === b[1];
  }

  function validPoint(point) {
    return Array.isArray(point) && point.length === 2
      && Math.abs(point[0]) <= safeExtent && Math.abs(point[1]) <= safeExtent
      && point.every(Number.isFinite);
  }

  function deduplicate(points) {
    return points.filter((point, index) => !index || !same(point, points[index - 1]));
  }

  function checkedPoints(points) {
    if (!Array.isArray(points) || points.length > maxPoints || !Array.from(points).every(validPoint)) {
      throw new Error('The ink gesture has invalid points or exceeds 25,000 samples.');
    }
    return deduplicate(points);
  }

  function worldPoints(object) {
    return deduplicate(object.points.map(([x, y]) => [object.x + x, object.y + y]));
  }

  function pointBounds(points, margin = 0) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const [x, y] of points) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return { left: left - margin, right: right + margin, top: top - margin, bottom: bottom + margin };
  }

  function pack(points, original, id) {
    const bounds = pointBounds(points, padding);
    let x = Math.max(-2e6, Math.min(2e6, bounds.left));
    let y = Math.max(-2e6, Math.min(2e6, bounds.top));
    let width = Math.max(1, bounds.right - x);
    let height = Math.max(1, bounds.bottom - y);
    if (original && (width > 1e6 || height > 1e6 || bounds.left + padding < x - 1e6 || bounds.top + padding < y - 1e6)) {
      // Older strokes may use signed local coordinates spanning more than
      // one frame. Reuse that valid frame rather than clipping the saved ink.
      ({ x, y, width, height } = original);
    }
    return model.createObject('stroke', [x, y], {
      ...original, ...(id ? { id } : {}), width, height,
      points: points.map(([px, py]) => [px - x, py - y]),
    });
  }

  function createStroke(points) {
    const world = checkedPoints(points);
    if (!world.length) throw new Error('A stroke needs at least one point.');
    return pack(world);
  }

  function distanceSquared(point, a, b) {
    const x = b[0] - a[0], y = b[1] - a[1];
    const dx = point[0] - a[0], dy = point[1] - a[1];
    const lengthSquared = x * x + y * y;
    const amount = lengthSquared ? Math.max(0, Math.min(1, (dx * x + dy * y) / lengthSquared)) : 0;
    return (dx - x * amount) ** 2 + (dy - y * amount) ** 2;
  }

  function hitStroke(object, point, radius) {
    if (object?.type !== 'stroke' || !validPoint(point) || !Number.isFinite(radius) || radius < 0) return false;
    const local = [point[0] - object.x, point[1] - object.y];
    const threshold = radius ** 2;
    return object.points.some((p, index, points) =>
      distanceSquared(local, points[Math.max(0, index - 1)], p) <= threshold);
  }

  function intersects(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function indexCapsules(items) {
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const { bounds: item } of items) {
      bounds.left = Math.min(bounds.left, item.left);
      bounds.right = Math.max(bounds.right, item.right);
      bounds.top = Math.min(bounds.top, item.top);
      bounds.bottom = Math.max(bounds.bottom, item.bottom);
    }
    if (items.length <= 12) return { bounds, items };
    const axis = bounds.right - bounds.left >= bounds.bottom - bounds.top ? 0 : 1;
    items.sort((a, b) => (a.a[axis] + a.b[axis]) - (b.a[axis] + b.b[axis]));
    const middle = items.length >> 1;
    return { bounds, left: indexCapsules(items.slice(0, middle)), right: indexCapsules(items.slice(middle)) };
  }

  function* capsulesAt(index, bounds) {
    if (!intersects(index.bounds, bounds)) return;
    if (index.items) {
      for (const item of index.items) if (intersects(item.bounds, bounds)) yield item;
    } else {
      yield* capsulesAt(index.left, bounds);
      yield* capsulesAt(index.right, bounds);
    }
  }

  function capsule(a, b, radius) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    return { a, b, length, u: length ? [dx / length, dy / length] : [0, 0],
      bounds: pointBounds([a, b], radius) };
  }

  function vector(a, b) {
    return [b[0] - a[0], b[1] - a[1]];
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

  function clipInterval(start, end) {
    const a = Math.max(0, start), b = Math.min(1, end);
    return b - a > epsilon ? [a, b] : null;
  }

  function circleInterval(segment, center, radius) {
    const delta = vector(segment.a, center);
    const perpendicular = cross(segment.u, delta);
    const extentSquared = radius ** 2 - perpendicular ** 2;
    if (extentSquared <= 0) return null;
    const distance = dot(segment.u, delta);
    const extent = Math.sqrt(extentSquared);
    return clipInterval((distance - extent) / segment.length, (distance + extent) / segment.length);
  }

  function scalarInterval(value, change, minimum, maximum) {
    if (change === 0) return value >= minimum && value <= maximum ? [0, 1] : null;
    const a = (minimum - value) / change, b = (maximum - value) / change;
    return clipInterval(Math.min(a, b), Math.max(a, b));
  }

  function capsuleInterval(segment, eraser, radius) {
    const start = circleInterval(segment, eraser.a, radius);
    if (!eraser.length) return start;
    const end = circleInterval(segment, eraser.b, radius);
    const origin = vector(eraser.a, segment.a);
    const direction = vector(segment.a, segment.b);
    const along = scalarInterval(dot(eraser.u, origin), dot(eraser.u, direction), 0, eraser.length);
    const across = scalarInterval(cross(eraser.u, origin), cross(eraser.u, direction), -radius, radius);
    const strip = along && across && clipInterval(Math.max(along[0], across[0]), Math.min(along[1], across[1]));
    // End disks and the centre rectangle form one convex capsule.
    const intervals = [start, end, strip].filter(Boolean);
    return intervals.length ? [Math.min(...intervals.map(x => x[0])), Math.max(...intervals.map(x => x[1]))] : null;
  }

  function clippedStroke(points, index, radius, checkBudget) {
    if (points.length === 1) {
      for (const item of capsulesAt(index, pointBounds(points))) {
        checkBudget();
        if (distanceSquared(points[0], item.a, item.b) <= radius ** 2) return [];
      }
      return null;
    }
    const pieces = [];
    let piece = [];
    let erased = false;
    function append(point) {
      if (!piece.length || !same(piece.at(-1), point)) piece.push(point);
    }
    function finish() {
      if (piece.length) pieces.push(piece);
      piece = [];
    }
    for (let i = 1; i < points.length; i++) {
      const segment = capsule(points[i - 1], points[i], 0);
      const removed = [];
      for (const item of capsulesAt(index, segment.bounds)) {
        checkBudget();
        const interval = capsuleInterval(segment, item, radius);
        if (!interval) continue;
        removed.push(interval);
        if (interval[0] === 0 && interval[1] === 1) break;
      }
      if (removed.length) erased = true;
      let cursor = 0;
      function at(t) {
        if (t === 0) return segment.a;
        if (t === 1) return segment.b;
        return segment.a.map((coordinate, axis) => coordinate + (segment.b[axis] - coordinate) * t);
      }
      for (const [start, end] of removed.sort((a, b) => a[0] - b[0])) {
        if (end <= cursor) continue;
        if (start > cursor + epsilon) {
          append(at(cursor));
          append(at(start));
        }
        finish();
        cursor = end;
      }
      if (cursor < 1 - epsilon) {
        append(at(cursor));
        append(segment.b);
      }
    }
    finish();
    return erased ? pieces : null;
  }

  function erase(board, path, radius) {
    const points = checkedPoints(path);
    if (!Number.isFinite(radius) || radius <= 0 || radius > safeExtent) throw new Error('The eraser radius is out of range.');
    const result = { changed: false, removedIds: [], addedIds: [] };
    if (!points.length) return result;
    const capsules = points.map((point, index) => capsule(points[Math.max(0, index - 1)], point, radius));
    if (capsules.length > 1) capsules.shift();
    const index = indexCapsules(capsules);
    const visible = new Set(model.visibleObjects(board));
    const ids = new Set([...board.objects, ...board.links, ...board.branches].map(item => item.id));
    let checks = 0;
    function checkBudget() {
      if (++checks > maxChecks) throw new Error('This gesture crosses too many strokes. Shorten the erase gesture.');
    }
    const objects = board.objects.flatMap(object => {
      if (object.type !== 'stroke' || object.locked || !visible.has(object)) return [object];
      const original = worldPoints(object);
      if (!intersects(index.bounds, pointBounds(original))) return [object];
      const pieces = clippedStroke(original, index, radius, checkBudget);
      if (!pieces) return [object];
      result.changed = true;
      if (!pieces.length) result.removedIds.push(object.id);
      return pieces.map((points, index) => {
        let id = object.id;
        if (index) {
          do { id = model.uid(); } while (ids.has(id));
          ids.add(id);
          result.addedIds.push(id);
        }
        return pack(points, object, id);
      });
    });
    if (objects.length > 4000) throw new Error('This erase would exceed 4,000 objects. Try a smaller gesture.');
    if (result.changed) {
      const removed = new Set(result.removedIds);
      board.objects = objects;
      if (removed.size) board.links = board.links.filter(link => !removed.has(link.from.objectId) && !removed.has(link.to.objectId));
    }
    return result;
  }

  const api = { createStroke, erase, hitStroke };
  if (typeof module !== 'undefined') module.exports = api;
  scope.BoardInk = api;
})(globalThis);
