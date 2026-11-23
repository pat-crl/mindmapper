/* Board library and outline operations are shared by the browser and Mac editor. */
(function (scope) {
  'use strict';

  const model = typeof module !== 'undefined' ? require('./board.js') : scope.BoardModel;
  const limit = 200000;

  function duplicateBoard(workspace, currentId) {
    const index = workspace.boards.findIndex(board => board.id === currentId);
    if (index < 0) throw new Error('This board no longer exists.');
    const original = workspace.boards[index];
    const names = new Set(workspace.boards.map(board => board.title));
    const ids = new Set(workspace.boards.map(board => board.id));
    let id;
    do { id = model.uid(); } while (ids.has(id));
    const base = original.title.trim() || 'Untitled board';
    const copyName = suffix => base.slice(0, 500 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + suffix;
    let title = copyName(' copy');
    for (let number = 2; names.has(title); number++) title = copyName(' copy ' + number);
    const duplicate = { ...original, id, title };
    const boards = [...workspace.boards];
    boards.splice(index + 1, 0, duplicate);
    return model.validateWorkspace({ ...workspace, activeBoardId: id, boards });
  }

  function removeBoard(workspace, id) {
    const index = workspace.boards.findIndex(board => board.id === id);
    if (index < 0) throw new Error('This board no longer exists.');
    const boards = workspace.boards.filter(board => board.id !== id);
    if (boards.length === 0) return model.createWorkspace();
    const activeBoardId = workspace.activeBoardId === id
      ? boards[Math.min(index, boards.length - 1)].id
      : workspace.activeBoardId;
    return model.validateWorkspace({ ...workspace, activeBoardId, boards });
  }

  function excerpt(value, position) {
    const from = Math.max(0, position - 36);
    const to = Math.min(value.length, position + 92);
    return (from ? '…' : '') + value.slice(from, to).replace(/\s+/g, ' ').trim() + (to < value.length ? '…' : '');
  }

  function searchBoard(board, query) {
    const text = String(query ?? '').trim();
    if (!text) return [];
    const literal = new RegExp(text.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'), 'iu');
    const objects = [];
    for (const object of board.objects) {
      for (const field of ['text', 'notes', 'source']) {
        const value = object[field] || '';
        const index = value.search(literal);
        if (index < 0) continue;
        const title = (object.text || '').trim().split(/\r?\n/, 1)[0] || 'Untitled ' + object.type;
        objects.push({ kind: 'object', id: object.id, title, field, excerpt: excerpt(value, index) });
        break;
      }
    }
    const edges = [...board.branches, ...board.links].flatMap(edge => {
      const label = edge.label || '';
      const index = label.search(literal);
      return index < 0 ? [] : [{ kind: 'edge', id: edge.id, title: label, field: 'label', excerpt: excerpt(label, index) }];
    });
    return [...objects, ...edges];
  }

  function revealMatch(board, match) {
    const items = new Map(board.objects.map(object => [object.id, object]));
    const parents = new Map(board.branches.map(edge => [edge.childId, edge.parentId]));
    const edge = match.kind === 'edge' && [...board.branches, ...board.links].find(item => item.id === match.id);
    if (match.kind === 'edge' && !edge) return board;
    const queue = edge
      ? [edge.parentId || edge.from.objectId, edge.childId || edge.to.objectId]
      : [match.id];
    const visited = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const ancestor of [parents.get(id), items.get(id)?.groupId]) {
        if (!ancestor) continue;
        const object = items.get(ancestor);
        if (object) object.folded = false;
        if (!visited.has(ancestor)) {
          visited.add(ancestor);
          queue.push(ancestor);
        }
      }
    }
    return board;
  }

  function indentation(value) {
    let columns = 0;
    for (const character of value) columns += character === '\t' ? 4 - columns % 4 : 1;
    return columns;
  }

  function parseOutline(outline, remaining) {
    if (typeof outline !== 'string' || outline.length > limit) throw new Error('Paste an outline under 200,000 characters.');
    const entries = [];
    const ancestors = [];
    for (const raw of outline.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u)) {
      if (!raw.trim()) continue;
      const indent = indentation(raw.match(/^[ \t]*/u)[0]);
      const title = raw.trim().replace(/^(?:[-+*•]|\d+[.)])(?:\s+|$)/u, '')
        .replace(/^\[[ xX]\]\s+/u, '').trim();
      if (!title) continue;
      if (title.length > 20000) throw new Error('One idea exceeds 20,000 characters.');
      if (entries.length >= remaining) throw new Error('This outline would exceed 4,000 board objects.');
      while (ancestors.length && indent <= ancestors.at(-1).indent) ancestors.pop();
      if (ancestors.length > 100) throw new Error('The outline is too deeply nested.');
      const parent = ancestors.at(-1);
      const entry = { title, indent, parent, children: [] };
      if (parent) parent.children.push(entry);
      entries.push(entry);
      ancestors.push(entry);
    }
    if (!entries.length) throw new Error('Paste at least one idea.');
    return entries;
  }

  function pasteOutline(board, outline, selectedBranchId, point = [0, 0]) {
    const entries = parseOutline(outline, 4000 - board.objects.length);
    const anchor = board.objects.find(object => object.id === selectedBranchId && object.type === 'branch');
    const side = board.branches.find(edge => edge.childId === anchor?.id)?.side || 'right';
    const direction = side === 'left' ? -1 : 1;
    const existingChildren = anchor
      ? board.branches.filter(edge => edge.parentId === anchor.id).sort((a, b) => a.order - b.order)
      : [];
    const roots = entries.filter(entry => !entry.parent);
    const ids = new Set([...board.objects, ...board.branches, ...board.links].map(item => item.id));
    function freshId() {
      let id;
      do { id = model.uid(); } while (ids.has(id));
      ids.add(id);
      return id;
    }
    const width = 150;
    const height = 46;
    const gap = 22;
    const childStep = width + 58;
    for (const item of entries.toReversed()) {
      // Estimate multiline text height conservatively because callers may use different fonts.
      item.height = Math.max(height, Math.ceil(item.title.length / 15) * 17 + 18);
      item.span = Math.max(item.height, item.children.reduce((sum, child) => sum + child.span + gap, -gap));
    }
    const occupied = new Set(anchor ? model.descendants(board, anchor.id) : []);
    const firstX = anchor ? (direction > 0 ? anchor.x + anchor.width + 58 : anchor.x - childStep) : point[0];
    const firstY = anchor
      ? board.objects.reduce((bottom, object) => occupied.has(object.id) ? Math.max(bottom, object.y + object.height + gap) : bottom, anchor.y)
      : point[1];

    let firstOrder = (existingChildren.at(-1)?.order ?? -1) + 1;
    let priorEdges = board.branches;
    if (firstOrder + roots.length - 1 > 4000) {
      const order = new Map(existingChildren.map((edge, index) => [edge.id, index]));
      priorEdges = board.branches.map(edge => order.has(edge.id) ? { ...edge, order: order.get(edge.id) } : edge);
      firstOrder = existingChildren.length;
    }
    const objects = [];
    const edges = [];
    function place(siblings, parentId, x, y, from = 0) {
      for (const [index, item] of siblings.entries()) {
        item.id = freshId();
        objects.push({
          id: item.id, type: 'branch', x, y: y + (item.span - item.height) / 2,
          width, height: item.height, text: item.title, style: {},
        });
        if (parentId) edges.push({
          id: freshId(), parentId, childId: item.id, side, order: from + index, style: { arrow: 'none', route: 'curve' },
        });
        place(item.children, item.id, x + direction * childStep, y);
        y += item.span + gap;
      }
    }
    place(roots, anchor?.id, firstX, firstY, firstOrder);
    const originals = board.objects.map(object => object.id === anchor?.id && object.folded ? { ...object, folded: false } : object);
    const checked = model.validateBoard({ ...board, objects: [...originals, ...objects], branches: [...priorEdges, ...edges] });
    board.objects = checked.objects;
    board.branches = checked.branches;
    return roots.map(item => item.id);
  }

  function sourceURL(value) {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url.href : null;
    } catch {
      return null;
    }
  }

  const htmlEscape = value => value.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const htmlLines = value => htmlEscape(value).replace(/\r\n?|\n/g, '<br>');
  const markdown = value => value.replace(/[\\\x60*_{}\[\]()#+\-.!<>|~]/g, '\\$&');
  const markdownLines = (value, indent) => markdown(value).replace(/\r\n?|\n/g, '  \n' + indent);

  function outline(board, ids) {
    const byId = new Map(board.objects.filter(object => object.type === 'branch').map(object => [object.id, object]));
    const parents = new Map(board.branches.map(edge => [edge.childId, edge.parentId]));
    const children = new Map();
    for (const edge of [...board.branches].sort((a, b) => a.order - b.order)) {
      if (!children.has(edge.parentId)) children.set(edge.parentId, []);
      children.get(edge.parentId).push(edge.childId);
    }
    const requested = new Set(ids || []);
    const roots = [...byId.keys()].filter(id => {
      if (!requested.size) return !parents.has(id);
      if (!requested.has(id)) return false;
      for (let parent = parents.get(id); parent; parent = parents.get(parent)) {
        if (requested.has(parent)) return false;
      }
      return true;
    });
    if (!roots.length) return { text: '', html: '' };
    const lines = [];
    function render(items, depth) {
      const indent = '  '.repeat(depth);
      const detailIndent = indent + '  ';
      const branches = items.map(id => {
        const object = byId.get(id);
        const title = object.text || 'Untitled idea';
        lines.push(indent + '- ' + markdownLines(title, detailIndent));
        const href = object.source && sourceURL(object.source);
        if (object.notes) lines.push('', detailIndent + 'Notes: ' + markdownLines(object.notes, detailIndent));
        if (object.source) lines.push('', detailIndent + 'Source: ' + (href ? '<' + href + '>' : markdownLines(object.source, detailIndent)));
        let html = '<li>' + htmlLines(title);
        if (object.notes) html += '<p>Notes: ' + htmlLines(object.notes) + '</p>';
        if (object.source) {
          const display = htmlLines(object.source);
          html += '<p>Source: ' + (href ? '<a href="' + htmlEscape(href) + '">' + display + '</a>' : display) + '</p>';
        }
        return html + render(children.get(id) || [], depth + 1) + '</li>';
      });
      return branches.length ? '<ul>' + branches.join('') + '</ul>' : '';
    }
    const html = render(roots, 0);
    return { text: lines.join('\n') + '\n', html };
  }

  const api = { duplicateBoard, removeBoard, searchBoard, revealMatch, pasteOutline, outline, sourceURL };
  if (typeof module !== 'undefined') module.exports = api;
  scope.BoardWorkflows = api;
})(globalThis);
