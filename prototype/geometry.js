'use strict';

const BoardGeometry = (() => {
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const context = document.createElement('canvas').getContext('2d');
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
  const measure = (text, size) => {
    context.font = size + 'px ' + fontFamily;
    return context.measureText(text).width;
  };

  function linesFor(text, width, size) {
    const graphemes = value => segmenter
      ? Array.from(segmenter.segment(value), item => item.segment)
      : Array.from(value);
    return text.replace(/\r\n?/g, '\n').split('\n').flatMap(paragraph => {
      if (measure(paragraph, size) <= width) return [paragraph];
      const lines = [];
      let line = '';
      for (const token of paragraph.match(/\s+|\S+/gu) || []) {
        if (line && measure(line + token, size) > width) {
          lines.push(line);
          line = '';
        }
        if (measure(token, size) <= width) line += token;
        else {
          for (const letter of graphemes(token)) {
            if (line && measure(line + letter, size) > width) {
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
    const lines = object.type === 'stroke' ? [] : linesFor(object.text, Math.max(8, object.width - 22), size);
    const textHeight = lines.length * lineHeight;
    const height = Math.max(object.height, textHeight + 16);
    return { ...object, height, size, lineHeight, lines, textHeight };
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
    const ports = {
      left: [rect.x, cy, -1, 0],
      right: [rect.x + rect.width, cy, 1, 0],
      top: [cx, rect.y, 0, -1],
      bottom: [cx, rect.y + rect.height, 0, 1],
    };
    return ports[side === 'auto' ? facing : side] || ports[facing];
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

  function connection(record, from, to) {
    const self = from.id === to.id;
    const a = endpoint(from, self && record.from.port === 'auto' ? 'right' : record.from.port, to);
    const b = endpoint(to, self && record.to.port === 'auto' ? 'top' : record.to.port, from);
    const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const point = value => value.slice(0, 2).join(' ');
    const label = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8];
    const style = record.style;
    let path = 'M' + point(a) + ' L' + point(b);
    let turns = [];
    if (self || style.route === 'curve') {
      const lead = self ? Math.max(from.width, from.height) * .75 + 24 : Math.max(18, distance * .42);
      turns = [pointOn(a, lead), pointOn(b, lead)];
      path = 'M' + point(a) + ' C' + turns.map(point).join(' ') + ' ' + point(b);
      label[0] = (a[0] + 3 * turns[0][0] + 3 * turns[1][0] + b[0]) / 8;
      label[1] = (a[1] + 3 * turns[0][1] + 3 * turns[1][1] + b[1]) / 8 - 8;
    } else if (style.route === 'elbow') {
      const lead = Math.max(5, Math.min(14, distance / 4));
      const first = pointOn(a, lead);
      const last = pointOn(b, lead);
      if (a[2] && b[2]) {
        const middle = (first[0] + last[0]) / 2;
        turns = [first, [middle, first[1]], [middle, last[1]], last];
      } else if (a[3] && b[3]) {
        const middle = (first[1] + last[1]) / 2;
        turns = [first, [first[0], middle], [last[0], middle], last];
      } else {
        turns = [first, a[2] ? [last[0], first[1]] : [first[0], last[1]], last];
      }
      path = 'M' + [a, ...turns, b].map(point).join(' L');
    }
    const arrows = [];
    if (style.arrow === 'end' || style.arrow === 'both') arrows.push(arrowAt(b, turns.at(-1) || a));
    if (style.arrow === 'start' || style.arrow === 'both') arrows.push(arrowAt(a, turns[0] || b));
    return { id: record.id, path, label, text: record.label, style, points: [a, ...turns, b], arrows };
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
    const edges = [...branches, ...board.links].flatMap(record => {
      const from = byId.get(record.from.objectId);
      const to = byId.get(record.to.objectId);
      return from && to ? [connection(record, from, to)] : [];
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
      ? { paper: '#1e1e1e', panel: '#29292d', ink: '#e8e8ed', line: '#48484e', wire: '#aaaab4', blue: '#82b9ff' }
      : { paper: '#ffffff', panel: '#f5f5f7', ink: '#242426', line: '#dedee4', wire: '#71717a', blue: '#005fc4' };
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

  function svg(drawing, title, colors = palette()) {
    const area = bounds(drawing);
    const viewBox = [area.x, area.y, area.width, area.height].join(' ');
    const background = '<rect x="' + area.x + '" y="' + area.y + '" width="' + area.width
      + '" height="' + area.height + '" fill="' + colors.paper + '"/>';
    const objects = drawing.objects.map(object => {
      const group = '<g data-object-id="' + encode(object.id) + '">';
      if (object.type === 'stroke') return group + strokeMarkup(object, colors) + '</g>';
      const fill = safeColor(object.style.fill, object.type === 'text' || object.type === 'group' ? 'none' : colors.paper);
      const stroke = safeColor(object.style.stroke, object.type === 'text' ? 'none' : colors.line);
      const shape = '<rect x="' + object.x + '" y="' + object.y + '" width="' + object.width
        + '" height="' + object.height + '" rx="7" fill="' + fill + '" stroke="' + stroke + '"/>';
      const textY = object.y + (object.type === 'group' ? 7 : (object.height - object.textHeight) / 2);
      const words = object.lines.map((line, i) => '<text x="' + (object.x + 11) + '" y="'
        + (textY + object.size + i * object.lineHeight) + '" xml:space="preserve" font-size="' + object.size
        + '" fill="' + safeColor(object.style.textColor, colors.ink) + '">' + encode(line) + '</text>').join('');
      return group + shape + words + '</g>';
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" width="' + area.width
      + '" height="' + area.height + '" font-family="system-ui, sans-serif"><title>' + encode(title) + '</title>'
      + background + drawing.edges.map(edge => edgeMarkup(edge, colors, false, false)).join('')
      + objects.join('') + '</svg>';
  }

  return { measure, box, scene, bounds, palette, edgeMarkup, strokeMarkup, svg };
})();
