'use strict';

const BoardGeometry = (() => {
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const context = document.createElement('canvas').getContext('2d');
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
  const measure = (text, size, style = {}) => {
    const weight = style.fontWeight === 'bold' ? 'bold' : 'normal';
    const slant = style.italic ? 'italic' : 'normal';
    context.font = slant + ' ' + weight + ' ' + size + 'px ' + fontFamily;
    return context.measureText(text).width;
  };

  function linesFor(text, width, size, style) {
    const graphemes = value => segmenter
      ? Array.from(segmenter.segment(value), item => item.segment)
      : Array.from(value);
    const fits = value => measure(value, size, style) <= width;
    return text.replace(/\r\n?/g, '\n').split('\n').flatMap(paragraph => {
      if (fits(paragraph)) return [paragraph];
      const lines = [];
      let line = '';
      for (const token of paragraph.match(/\s+|\S+/gu) || []) {
        if (line && !fits(line + token)) {
          lines.push(line);
          line = '';
        }
        if (fits(token)) line += token;
        else {
          for (const letter of graphemes(token)) {
            if (line && !fits(line + letter)) {
              lines.push(line);
              line = '';
            }
            line += letter;
          }
        }
      }
      lines.push(line);
      return lines;
    });
  }

  function box(object) {
    const size = object.style.fontSize || 13;
    const lineHeight = size * 1.25;
    const shape = object.type === 'shape' ? (object.shape || 'rounded') : null;
    const insetRatio = shape === 'decision' ? .5 : shape === 'circle' ? .68 : 1;
    const circular = shape === 'circle' || shape === 'junction';
    const nominalWidth = circular ? Math.max(object.width, object.height) : object.width;
    const padding = insetRatio < 1 ? 8 : 22;
    const textWidth = Math.max(8, nominalWidth * insetRatio - padding);
    const lines = object.type === 'stroke' || shape === 'line' || shape === 'junction'
      ? [] : linesFor(object.text, textWidth, size, object.style);
    const textHeight = lines.length * lineHeight;
    const minimumHeight = lines.length ? textHeight / insetRatio + 16 : 0;
    const height = Math.max(object.height, minimumHeight, circular ? nominalWidth : 0);
    const width = circular ? height : object.width;
    const textAlign = insetRatio === 1 ? 'left' : 'center';
    const textInset = textAlign === 'center' ? Math.max(0, (width - textWidth) / 2) : 11;
    const textPosition = object.type === 'group' || object.type === 'note' ? 'start' : 'center';
    return { ...object, width, height, size, lineHeight, lines, textHeight, textAlign, textInset, textPosition };
  }

  function textStyle(object) {
    const layout = object.lines ? object : box(object);
    return {
      fontSize: layout.size + 'px', fontWeight: layout.style.fontWeight || 'normal',
      fontStyle: layout.style.italic ? 'italic' : 'normal', lineHeight: layout.lineHeight + 'px',
      textAlign: layout.textAlign, paddingInline: Math.max(0, layout.textInset - 1) + 'px',
      alignContent: layout.textPosition,
    };
  }

  function center(rect) {
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
  }

  function endpoint(rect, side, other) {
    const [cx, cy] = center(rect);
    const [ox, oy] = center(other);
    const dx = ox - cx;
    const dy = oy - cy;
    const facing = Math.abs(dx) / rect.width >= Math.abs(dy) / rect.height
      ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
    const port = side && side !== 'auto' ? side : facing;
    if (rect.shape === 'junction') {
      const vectors = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
      return [cx, cy, ...(vectors[port] || vectors[facing])];
    }
    if (rect.type === 'shape' && rect.shape === 'line') {
      const [start, finish] = lineEnds(rect);
      const startsHere = port === 'left' || port === (rect.lineDirection === 'up' ? 'bottom' : 'top');
      const [x, y] = startsHere ? start : finish;
      const vx = finish[0] - start[0], vy = finish[1] - start[1];
      const distance = Math.hypot(vx, vy);
      const direction = startsHere ? -1 : 1;
      return [x, y, direction * vx / distance, direction * vy / distance];
    }
    const ports = {
      left: [rect.x, cy, -1, 0],
      right: [rect.x + rect.width, cy, 1, 0],
      top: [cx, rect.y, 0, -1],
      bottom: [cx, rect.y + rect.height, 0, 1],
    };
    return ports[port] || ports[facing];
  }

  function portPoint(rect, side, other = rect) {
    return endpoint(rect, side, other).slice(0, 2);
  }

  function pointOn(a, amount) {
    return [a[0] + a[2] * amount, a[1] + a[3] * amount];
  }

  function arrowAt(end, previous) {
    const dx = end[0] - previous[0];
    const dy = end[1] - previous[1];
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return [];
    const ux = dx / distance;
    const uy = dy / distance;
    const x = end[0] - ux * 8;
    const y = end[1] - uy * 8;
    return [end.slice(0, 2), [x - uy * 4, y + ux * 4], [x + uy * 4, y - ux * 4]];
  }

  const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
  const segmentLength = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  function simplify(points) {
    const result = [];
    for (const point of points) {
      const b = result.at(-1);
      if (b && samePoint(point, b)) continue;
      const a = result.at(-2);
      // Collapse only a continuous straight run, keeping deliberate reversals.
      if (a && [0, 1].some(axis => a[axis] === b[axis] && b[axis] === point[axis]
          && (b[1 - axis] - a[1 - axis]) * (point[1 - axis] - b[1 - axis]) > 0)) {
        result.pop();
      }
      result.push(point);
    }
    return result;
  }

  function halfWay(points) {
    const lengths = points.slice(1).map((point, i) => segmentLength(points[i], point));
    let remaining = lengths.reduce((total, length) => total + length, 0) / 2;
    for (const [i, length] of lengths.entries()) {
      if (length && remaining <= length) {
        return points[i].map((value, axis) => value + (points[i + 1][axis] - value) * remaining / length);
      }
      remaining -= length;
    }
    return points[0];
  }

  function obstacleLookup(objects) {
    const cell = 224;
    const boxes = [];
    const large = [];
    const cells = new Map();
    function range({ left, right, top, bottom }) {
      return [Math.floor(left / cell), Math.floor(right / cell), Math.floor(top / cell), Math.floor(bottom / cell)];
    }
    function visit([left, right, top, bottom], callback) {
      for (let x = left; x <= right; x++) {
        for (let y = top; y <= bottom; y++) callback(x + ':' + y);
      }
    }
    const covered = ([left, right, top, bottom]) => (right - left + 1) * (bottom - top + 1);
    for (const object of objects) {
      if (object.type === 'group' || object.type === 'stroke' || ['line', 'junction'].includes(object.shape)) continue;
      const bounds = {
        left: object.x - 7, right: object.x + object.width + 7,
        top: object.y - 7, bottom: object.y + object.height + 7,
      };
      boxes.push(bounds);
      const tiles = range(bounds);
      if (covered(tiles) > 100) large.push(bounds);
      else visit(tiles, key => {
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(bounds);
      });
    }
    return (a, b) => {
      const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
      const top = Math.min(a[1], b[1]), bottom = Math.max(a[1], b[1]);
      const tiles = range({ left, right, top, bottom });
      let possible = boxes;
      if (covered(tiles) <= 100) {
        const candidates = new Set(large);
        visit(tiles, key => {
          for (const item of cells.get(key) || []) candidates.add(item);
        });
        possible = [...candidates];
      }
      return possible.filter(box => left < box.right && right > box.left && top < box.bottom && bottom > box.top);
    };
  }

  function axisLead(endpoint, amount) {
    const [x, y, dx, dy] = endpoint;
    return Math.abs(dx) >= Math.abs(dy) ? [x + Math.sign(dx) * amount, y] : [x, y + Math.sign(dy) * amount];
  }

  function orthogonal(a, b, horizontalFirst) {
    return horizontalFirst ? [b[0], a[1]] : [a[0], b[1]];
  }

  function pointRoute(a, b, waypoints) {
    const leadA = axisLead(a, 14);
    const leadB = axisLead(b, 14);
    const points = [a.slice(0, 2), leadA];
    let previous = leadA;
    let horizontal = Math.abs(a[2]) >= Math.abs(a[3]);
    for (const point of [...waypoints, leadB]) {
      const corner = orthogonal(previous, point, horizontal);
      points.push(corner, point);
      if (!samePoint(previous, point)) {
        const last = samePoint(point, corner) ? previous : corner;
        horizontal = last[1] === point[1];
      }
      previous = point;
    }
    points.push(b.slice(0, 2));
    return simplify(points);
  }

  function elbowRoute(a, b, lane, blockers) {
    const first = axisLead(a, 14);
    const last = axisLead(b, 14);
    if (samePoint(a, b) && samePoint(first, last)) {
      const straight = axisLead(a, 44 + Math.abs(lane));
      const dx = first[0] - a[0], dy = first[1] - a[1];
      const side = lane < 0 ? -2 : 2;
      const corner = ([x, y]) => [x - dy * side, y + dx * side];
      return simplify([a.slice(0, 2), first, straight, corner(straight), corner(first), first, b.slice(0, 2)]);
    }
    const horizontalA = first[1] === a[1];
    const horizontalB = last[1] === b[1];
    const midX = (first[0] + last[0]) / 2;
    const midY = (first[1] + last[1]) / 2;
    const across = x => simplify([first, [x, first[1]], [x, last[1]], last]);
    const down = y => simplify([first, [first[0], y], [last[0], y], last]);
    let preferred;
    if (lane && first[1] === last[1]) preferred = down(midY + lane);
    else if (lane && first[0] === last[0]) preferred = across(midX + lane);
    else if (horizontalA && horizontalB) preferred = across(midX + lane);
    else if (!horizontalA && !horizontalB) preferred = down(midY + lane);
    else if (lane) preferred = horizontalA ? down(midY + lane) : across(midX + lane);
    else preferred = simplify([first, orthogonal(first, last, horizontalA), last]);

    if (blockers) {
      function hits(route) {
        const found = new Set();
        for (let i = 1; i < route.length; i++) {
          for (const box of blockers(route[i - 1], route[i])) found.add(box);
        }
        return found;
      }
      const initialHits = hits(preferred);
      if (initialHits.size) {
        const bounds = [...initialHits].reduce((area, item) => ({
          left: Math.min(area.left, item.left), right: Math.max(area.right, item.right),
          top: Math.min(area.top, item.top), bottom: Math.max(area.bottom, item.bottom),
        }));
        // A negative and positive lane can both choose the same side of a blocker.
        // Keep their clearances distinct so detouring does not merge those wires.
        const gap = 6 + Math.abs(lane) + (lane < 0 ? 7 : 0);
        const candidates = [
          across(bounds.left - gap), across(bounds.right + gap),
          down(bounds.top - gap), down(bounds.bottom + gap),
        ];
        if (!lane) candidates.push(across(midX), down(midY));
        function cost(route, count) {
          return count * 1e8 + route.slice(1).reduce((distance, point, i) => distance + segmentLength(route[i], point), 0);
        }
        let best = cost(preferred, initialHits.size);
        for (const route of candidates) {
          const score = cost(route, hits(route).size);
          if (score < best) {
            preferred = route;
            best = score;
          }
        }
      }
    }
    return simplify([a.slice(0, 2), ...preferred, b.slice(0, 2)]);
  }

  function connection(record, from, to, lane, blockers) {
    const self = from.id === to.id;
    const a = endpoint(from, self && record.from.port === 'auto' ? 'right' : record.from.port, to);
    const b = endpoint(to, self && record.to.port === 'auto' ? 'top' : record.to.port, from);
    const fromPoint = a.slice(0, 2);
    const toPoint = b.slice(0, 2);
    const distance = segmentLength(a, b);
    const directedLane = record.from.objectId > record.to.objectId ? -lane : lane;
    const offset = [distance ? (a[1] - b[1]) * directedLane / distance : lane, distance ? (b[0] - a[0]) * directedLane / distance : -lane];
    const style = record.style;
    const waypoints = record.waypoints || [];
    let points = [fromPoint, toPoint];
    let label;
    let bends = [];
    let path;
    if (style.route === 'elbow') {
      points = waypoints.length ? pointRoute(a, b, waypoints) : elbowRoute(a, b, lane, blockers);
      bends = waypoints.length ? waypoints : points.slice(1, -1).filter(point => !samePoint(point, fromPoint) && !samePoint(point, toPoint));
      label = halfWay(points);
    } else if (self || style.route === 'curve') {
      const lead = self ? Math.max(from.width, from.height) * .75 + 24 : Math.max(18, distance * .42);
      const first = pointOn(a, lead).map((value, i) => value + offset[i]);
      const last = pointOn(b, lead).map((value, i) => value + offset[i]);
      if (samePoint(first, last) && samePoint(a, b)) {
        first[0] -= a[3] * lead;
        first[1] += a[2] * lead;
        last[0] += b[3] * lead;
        last[1] -= b[2] * lead;
      }
      points = [fromPoint, first, last, toPoint];
      path = 'M' + fromPoint.join(' ') + ' C' + [first, last, toPoint].map(point => point.join(' ')).join(' ');
      label = [0, 1].map(i => (a[i] + 3 * first[i] + 3 * last[i] + b[i]) / 8);
    } else if (lane) {
      // Shared fixed ports fan short end runs out to distinct parallel straight runs.
      const at = ratio => [0, 1].map(i => a[i] + (b[i] - a[i]) * ratio + offset[i]);
      points = simplify([fromPoint, at(.24), at(.76), toPoint]);
      label = halfWay(points);
    }
    path ||= 'M' + points.map(point => point.join(' ')).join(' L');
    label ||= halfWay(points);
    const arrows = [];
    if (style.arrow === 'end' || style.arrow === 'both') arrows.push(arrowAt(b, points.at(-2) || a));
    if (style.arrow === 'start' || style.arrow === 'both') arrows.push(arrowAt(a, points[1] || b));
    return { id: record.id, path, label: [label[0], label[1] - 8], text: record.label, style, points,
      fromPoint, toPoint, waypoints, bends, arrows };
  }

  function strokePath(object) {
    const points = object.points || [];
    if (points.length === 0) return '';
    const at = ([x, y]) => [object.x + x, object.y + y].join(' ');
    return 'M' + points.map(at).join(' L') + (points.length === 1 ? ' l0.1 0' : '');
  }

  function scene(board, { all = false } = {}) {
    const objects = (all ? board.objects : BoardModel.visibleObjects(board)).map(box);
    const byId = new Map(objects.map(object => [object.id, object]));
    const branches = board.branches.map(branch => ({
      ...branch,
      from: { objectId: branch.parentId, port: branch.side === 'right' ? 'right' : 'left' },
      to: { objectId: branch.childId, port: branch.side === 'right' ? 'left' : 'right' },
    }));
    const counters = new Map();
    const lanes = new Map();
    for (const link of board.links) {
      if (!byId.has(link.from.objectId) || !byId.has(link.to.objectId)) continue;
      const key = [link.from.objectId, link.to.objectId].sort().join(':');
      const side = counters.get(key) || 0;
      counters.set(key, side + 1);
      lanes.set(link.id, Math.ceil(side / 2) * (side % 2 ? 1 : -1) * 14);
    }
    const blockers = board.links.some(link => link.style.route === 'elbow' && !link.waypoints?.length)
      ? obstacleLookup(objects) : null;
    const edges = [...branches, ...board.links].flatMap(record => {
      const from = byId.get(record.from.objectId);
      const to = byId.get(record.to.objectId);
      return from && to ? [connection(record, from, to, lanes.get(record.id) || 0, record.parentId ? null : blockers)] : [];
    });
    return { objects, byId, edges };
  }

  function bounds(drawing, padding = 30) {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    function include(x, y) {
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
    for (const object of drawing.objects) {
      include(object.x, object.y);
      include(object.x + object.width, object.y + object.height);
      for (const [x, y] of object.points || []) include(object.x + x, object.y + y);
    }
    for (const edge of drawing.edges) {
      for (const [x, y] of [...edge.points, ...edge.arrows.flat()]) include(x, y);
      if (edge.text) {
        const textWidth = measure(edge.text, 12);
        include(edge.label[0] - textWidth / 2, edge.label[1] - 13);
        include(edge.label[0] + textWidth / 2, edge.label[1] + 4);
      }
    }
    if (!Number.isFinite(box.left)) return { x: -100, y: -75, width: 200, height: 150 };
    return { x: box.left - padding, y: box.top - padding,
      width: box.right - box.left + 2 * padding, height: box.bottom - box.top + 2 * padding };
  }

  function palette() {
    return matchMedia('(prefers-color-scheme: dark)').matches
      ? { paper: '#1e1e1e', panel: '#29292d', note: '#343126', ink: '#e8e8ed', line: '#48484e', wire: '#aaaab4', blue: '#82b9ff' }
      : { paper: '#ffffff', panel: '#f5f5f7', note: '#fff9e7', ink: '#242426', line: '#dedee4', wire: '#71717a', blue: '#005fc4' };
  }

  const encode = value => String(value)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  const safeColor = (value, fallback) => /^#[0-9a-f]{3,8}$/i.test(value) || value === 'none' || value === 'transparent' ? value : fallback;

  function edgeMarkup(edge, colors, interactive, selected) {
    // Paths and coordinates originate in geometry, never user markup.
    const color = selected ? colors.blue : safeColor(edge.style.color, colors.wire);
    const hit = interactive ? '<path class="edge-target" data-edge="' + encode(edge.id) + '" d="' + edge.path + '" fill="none" stroke="transparent" stroke-width="13"/>' : '';
    const path = '<path d="' + edge.path + '" fill="none" stroke="' + color
      + '" stroke-width="' + (selected ? 2.5 : 1.5) + '"' + (edge.style.dashed ? ' stroke-dasharray="5 5"' : '') + '/>';
    const arrows = edge.arrows.filter(points => points.length).map(points =>
      '<polygon points="' + points.map(p => p.join(',')).join(' ') + '" fill="' + color + '"/>').join('');
    const label = edge.text ? '<text x="' + edge.label[0] + '" y="' + edge.label[1]
      + '" text-anchor="middle" font-size="12" fill="' + colors.ink + '" stroke="' + colors.paper
      + '" stroke-width="5" paint-order="stroke" stroke-linejoin="round">' + encode(edge.text) + '</text>' : '';
    return path + arrows + label + hit;
  }

  function strokeMarkup(object, colors) {
    return '<path d="' + strokePath(object) + '" fill="none" stroke="' + safeColor(object.style.stroke, colors.wire)
      + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function lineEnds({ x, y, width, height, lineDirection }) {
    const bottom = y + height;
    return lineDirection === 'up'
      ? [[x, bottom], [x + width, y]] : [[x, y], [x + width, bottom]];
  }

  function shapeMarkup(object, colors) {
    const { x, y, width, height, style, type } = object;
    const shape = type === 'shape' ? (object.shape || 'rounded') : null;
    const empty = type === 'text' || type === 'group';
    const fill = safeColor(style.fill, empty ? 'none' : type === 'note' ? (colors.note || colors.panel) : colors.paper);
    const stroke = safeColor(style.stroke, type === 'text' ? 'none' : colors.line);
    const paint = ' fill="' + fill + '" stroke="' + stroke + '"';
    if (shape === 'line') {
      const [[x1, y1], [x2, y2]] = lineEnds(object);
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="'
        + safeColor(style.stroke, colors.wire) + '" stroke-width="1.5" stroke-linecap="round"/>';
    }
    if (shape === 'decision') {
      const points = [[x + width / 2, y], [x + width, y + height / 2],
        [x + width / 2, y + height], [x, y + height / 2]];
      return '<polygon points="' + points.map(point => point.join(',')).join(' ') + '"' + paint + '/>';
    }
    if (shape === 'junction') {
      return '<circle cx="' + (x + width / 2) + '" cy="' + (y + height / 2) + '" r="'
        + Math.min(width, height) / 2 + '" fill="' + safeColor(style.fill, colors.wire) + '"/>';
    }
    if (shape === 'circle') {
      return '<circle cx="' + (x + width / 2) + '" cy="' + (y + height / 2)
        + '" r="' + Math.min(width, height) / 2 + '"' + paint + '/>';
    }
    if (fill === 'none' && stroke === 'none') return '';
    const radius = shape === 'rectangle' ? 0 : type === 'branch' ? 10 : 7;
    const dash = type === 'group' ? ' stroke-dasharray="5 5"' : '';
    return '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height
      + '" rx="' + radius + '"' + paint + dash + '/>';
  }

  function svg(drawing, title, colors = palette()) {
    const area = bounds(drawing);
    const viewBox = [area.x, area.y, area.width, area.height].join(' ');
    const background = '<rect x="' + area.x + '" y="' + area.y + '" width="' + area.width
      + '" height="' + area.height + '" fill="' + colors.paper + '"/>';
    const frames = drawing.objects.filter(object => object.type === 'group').map(object => shapeMarkup(object, colors)).join('');
    const objects = drawing.objects.map(object => {
      const group = '<g data-object-id="' + encode(object.id) + '">';
      if (object.type === 'stroke') return group + strokeMarkup(object, colors) + '</g>';
      const shape = object.type === 'group' ? '' : shapeMarkup(object, colors);
      const textY = object.y + (object.textPosition === 'start' ? 8 : (object.height - object.textHeight) / 2);
      const centered = object.textAlign === 'center';
      const textX = object.x + (centered ? object.width / 2 : object.textInset);
      const weight = object.style.fontWeight === 'bold' ? ' font-weight="bold"' : '';
      const italic = object.style.italic ? ' font-style="italic"' : '';
      const anchor = centered ? ' text-anchor="middle"' : '';
      const words = object.lines.map((line, i) => '<text x="' + textX + '" y="'
        + (textY + object.size + i * object.lineHeight) + '" xml:space="preserve" font-size="' + object.size
        + '" fill="' + safeColor(object.style.textColor, colors.ink) + '"' + weight + italic + anchor + '>' + encode(line) + '</text>').join('');
      return group + shape + words + '</g>';
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" width="' + area.width
      + '" height="' + area.height + '" font-family="system-ui, sans-serif"><title>' + encode(title) + '</title>'
      + background + frames + drawing.edges.map(edge => edgeMarkup(edge, colors, false, false)).join('')
      + objects.join('') + '</svg>';
  }

  return { measure, box, textStyle, portPoint, scene, bounds, palette, edgeMarkup, strokeMarkup, shapeMarkup, svg };
})();
