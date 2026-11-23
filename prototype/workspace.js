'use strict';

(() => {
  const model = BoardModel;
  const geometry = BoardGeometry;
  const $ = selector => document.querySelector(selector);
  const viewport = $('#viewport');
  const world = $('#world');
  const diagram = $('#diagram');
  const objectLayer = $('#objects');
  const editor = $('#object-editor');
  const bridge = window.webkit?.messageHandlers?.mindmapper;
  const storageKey = 'mindmapper-mac-prototype-workspace-v1';
  const ports = ['auto', 'left', 'right', 'top', 'bottom'];
  const historyLimit = 8 * 1024 * 1024;
  const state = {
    workspace: null, ids: new Set(), edge: null, tool: 'select', connect: null,
    edit: null, gesture: null, space: false, prior: [], next: [],
    revision: 0, saved: 0, saving: null, timer: null, baseline: null,
  };
  let currentScene;
  let filePicker;

  const board = (workspace = state.workspace) => workspace.boards.find(item => item.id === workspace.activeBoardId);
  const send = (action, values = {}) => bridge.postMessage({ action, ...values });
  const copy = value => structuredClone(value);
  const shown = (selector, value) => { $(selector).hidden = !value; };
  const setPressed = (button, value) => button.setAttribute('aria-pressed', String(value));

  function notice(message, retry = false) {
    $('#notice-text').textContent = message;
    shown('#notice', Boolean(message));
    shown('#retry', retry);
  }

  function status(text, failed = false) {
    const label = $('#status');
    label.textContent = text;
    label.dataset.failed = String(failed);
  }

  function schedule() {
    state.revision += 1;
    status('Saving…');
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 180);
  }

  async function flush() {
    clearTimeout(state.timer);
    if (!state.workspace) return false;
    if (state.saving) return state.saving;
    const writeBrowser = text => {
      if (localStorage.getItem(storageKey) !== state.baseline) {
        throw new Error('The workspace changed in another tab. Export an editable copy before reopening it.');
      }
      localStorage.setItem(storageKey, text);
      state.baseline = text;
    };
    state.saving = (async () => {
      try {
        while (state.saved < state.revision) {
          const revision = state.revision;
          const text = JSON.stringify(state.workspace);
          if (bridge) await send('save', { text });
          else if (navigator.locks) await navigator.locks.request(storageKey, () => writeBrowser(text));
          else writeBrowser(text);
          state.saved = revision;
        }
        status(state.revision ? 'Saved' : 'Ready');
        if (!$('#retry').hidden) notice('');
        return true;
      } catch (error) {
        status('Couldn’t save', true);
        notice(error.message || String(error), true);
        return false;
      }
    })();
    try { return await state.saving; } finally { state.saving = null; }
  }

  function historyEntry() {
    const json = JSON.stringify(state.workspace);
    return { json, bytes: json.length * 2, ids: [...state.ids], edge: state.edge };
  }

  function remember(stack, entry, other) {
    stack.push(entry);
    let bytes = [...state.prior, ...state.next].reduce((total, item) => total + item.bytes, 0);
    while (bytes > historyLimit || state.prior.length + state.next.length > 48) {
      if (other.length) bytes -= other.shift().bytes;
      else if (stack.length > 1) bytes -= stack.shift().bytes;
      else break;
    }
  }

  function change(mutate, select) {
    if (!state.workspace) return false;
    const previous = historyEntry();
    try {
      const draft = copy(state.workspace);
      const suggested = mutate(board(draft), draft);
      const next = model.validateWorkspace(suggested?.format === model.WORKSPACE ? suggested : draft);
      if (JSON.stringify(next) === previous.json) return true;
      state.next.length = 0;
      remember(state.prior, previous, state.next);
      state.workspace = next;
      if (select) select();
      repairSelection();
      schedule();
      render();
      return true;
    } catch (error) {
      notice(error.message || String(error));
      return false;
    }
  }

  function undo(redo = false) {
    finishEdit();
    const from = redo ? state.next : state.prior;
    const to = redo ? state.prior : state.next;
    const previous = from.pop();
    if (!previous) return;
    const current = historyEntry();
    const views = new Map(state.workspace.boards.map(item => [item.id, item.view]));
    const restored = JSON.parse(previous.json);
    for (const item of restored.boards) item.view = views.get(item.id) || item.view;
    try {
      state.workspace = model.validateWorkspace(restored);
    } catch (error) {
      from.push(previous);
      notice(error.message);
      return;
    }
    remember(to, current, from);
    state.ids = new Set(previous.ids);
    state.edge = previous.edge;
    repairSelection();
    schedule();
    render();
  }

  function repairSelection() {
    const active = board();
    const visible = new Set(model.visibleObjects(active).map(item => item.id));
    state.ids = new Set([...state.ids].filter(id => visible.has(id)));
    if (![...active.links, ...active.branches].some(link => link.id === state.edge)) state.edge = null;
    if (!visible.has(state.connect)) state.connect = null;
  }

  function choose(ids = [], edge = null) {
    state.ids = new Set(ids);
    state.edge = edge;
  }

  function updateSelection() {
    for (const button of objectLayer.children) {
      setPressed(button, state.ids.has(button.dataset.object));
      button.dataset.linkSource = String(state.connect === button.dataset.object);
    }
    renderDiagram();
    renderInspector();
  }

  function xy(event) {
    const bounds = viewport.getBoundingClientRect();
    const view = board().view;
    return [(event.clientX - bounds.left - bounds.width / 2 - view.x) / view.zoom,
      (event.clientY - bounds.top - bounds.height / 2 - view.y) / view.zoom];
  }

  function viewTransform() {
    if (!state.workspace) return;
    const view = board().view;
    const pan = state.gesture?.kind === 'pan' ? state.gesture : null;
    const x = viewport.clientWidth / 2 + view.x + (pan?.dx || 0);
    const y = viewport.clientHeight / 2 + view.y + (pan?.dy || 0);
    world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + view.zoom + ')';
    $('#zoom').textContent = Math.round(view.zoom * 100) + '%';
  }

  function withView(next) {
    if (!state.workspace) return;
    const old = board();
    const view = { x: Math.max(-4e6, Math.min(4e6, next.x)),
      y: Math.max(-4e6, Math.min(4e6, next.y)), zoom: Math.max(.1, Math.min(4, next.zoom)) };
    state.workspace = { ...state.workspace, boards: state.workspace.boards.map(item => item.id === old.id ? { ...old, view } : item) };
    viewTransform();
    schedule();
  }

  function fit() {
    const area = geometry.bounds(currentScene);
    const zoom = Math.min(1.5, (viewport.clientWidth - 20) / area.width, (viewport.clientHeight - 60) / area.height);
    const value = Math.max(.1, zoom);
    withView({ zoom: value, x: -(area.x + area.width / 2) * value, y: -(area.y + area.height / 2) * value });
  }

  function zoomAt(factor, point = [0, 0]) {
    const view = board().view;
    const zoom = Math.max(.1, Math.min(4, view.zoom * factor));
    const scale = zoom / view.zoom;
    withView({ zoom, x: point[0] - (point[0] - view.x) * scale, y: point[1] - (point[1] - view.y) * scale });
  }

  function displayBoard() {
    const active = board();
    const drag = state.gesture;
    if (drag?.kind !== 'move' || (!drag.dx && !drag.dy)) return active;
    const draft = { ...active, objects: active.objects.map(object => ({ ...object })) };
    model.moveObjects(draft, drag.ids, drag.dx, drag.dy);
    return draft;
  }

  function renderDiagram() {
    const colors = geometry.palette();
    const drawing = currentScene;
    let markup = drawing.objects.filter(object => object.type === 'stroke').map(object => geometry.strokeMarkup(object, colors)).join('');
    markup += drawing.edges.map(edge => geometry.edgeMarkup(edge, colors, true, edge.id === state.edge)).join('');
    if (state.gesture?.kind === 'stroke') {
      markup += geometry.strokeMarkup({ x: 0, y: 0, points: state.gesture.points, style: { stroke: colors.blue } }, colors);
    }
    diagram.innerHTML = markup;
  }

  function setBounds(element, object) {
    element.style.left = object.x + 'px';
    element.style.top = object.y + 'px';
    element.style.width = object.width + 'px';
    element.style.height = object.height + 'px';
    element.style.fontSize = object.size + 'px';
  }

  function renderWorld() {
    currentScene = geometry.scene(displayBoard());
    const focused = document.activeElement?.dataset.object;
    const nodes = currentScene.objects.map(object => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'object';
      button.dataset.object = object.id;
      button.dataset.type = object.type;
      button.dataset.locked = String(object.locked);
      button.dataset.linkSource = String(state.connect === object.id);
      button.setAttribute('aria-label', [object.text || object.type, object.locked && 'locked', object.folded && 'folded'].filter(Boolean).join(', '));
      setPressed(button, state.ids.has(object.id));
      setBounds(button, object);
      if (object.style.fill && object.type !== 'stroke') button.style.backgroundColor = object.style.fill;
      if (object.style.stroke && object.type !== 'stroke') button.style.borderColor = object.style.stroke;
      if (object.style.textColor) button.style.color = object.style.textColor;
      for (const line of object.lines) {
        const span = document.createElement('span');
        span.textContent = line || '\u00a0';
        span.style.lineHeight = object.lineHeight + 'px';
        button.append(span);
      }
      if (state.edit?.id === object.id) button.hidden = true;
      return button;
    });
    objectLayer.replaceChildren(...nodes);
    if (focused && !state.edit) nodes.find(button => button.dataset.object === focused)?.focus({ preventScroll: true });
    renderDiagram();
    viewTransform();
    shown('#empty', board().objects.length === 0 && state.tool === 'select');
    if (state.edit && currentScene.byId.has(state.edit.id)) setBounds(editor, currentScene.byId.get(state.edit.id));
  }

  function render() {
    const active = board();
    const focus = document.activeElement?.dataset.board;
    const nav = $('#board-list');
    const entries = state.workspace.boards.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.board = item.id;
      button.textContent = item.title || 'Untitled board';
      button.setAttribute('aria-current', String(item.id === active.id));
      return button;
    });
    nav.replaceChildren(...entries);
    if (focus) entries.find(button => button.dataset.board === focus)?.focus();
    if (document.activeElement !== $('#board-title')) $('#board-title').value = active.title;
    $('button[data-command="undo"]').disabled = state.prior.length === 0;
    $('button[data-command="redo"]').disabled = state.next.length === 0;
    renderWorld();
    renderInspector();
  }

  function makeField(label, value, onChange, options = {}) {
    const group = document.createElement('label');
    group.textContent = label;
    const control = document.createElement(options.values ? 'select' : options.multiline ? 'textarea' : 'input');
    if (options.values) {
      for (const item of options.values) control.add(new Option(item, item));
    } else if (!options.multiline) control.type = options.type || 'text';
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
    if (options.maxLength) control.maxLength = options.maxLength;
    control.addEventListener('change', () => onChange(control.type === 'checkbox' ? control.checked : control.value));
    group.append(control);
    return group;
  }

  function button(label, command) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', command);
    return element;
  }

  function renderInspector() {
    const props = $('#properties');
    if ($('#inspector').hidden || !state.workspace) return;
    const selected = currentScene.objects.find(item => state.ids.has(item.id));
    const edge = [...board().links, ...board().branches].find(record => record.id === state.edge);
    const description = document.createElement('p');
    props.replaceChildren(description);
    if (edge) {
      description.textContent = edge.parentId ? 'Branch connection' : 'Board connection';
      const update = (key, value, section) => change(active => {
        const record = [...active.links, ...active.branches].find(item => item.id === edge.id);
        if (section) record[section][key] = value;
        else record[key] = value;
      });
      props.append(
        makeField('Label', edge.label, value => update('label', value), { maxLength: 120 }),
        makeField('Route', edge.style.route, value => update('route', value, 'style'), { values: ['straight', 'curve', 'elbow'] }),
        makeField('Arrow', edge.style.arrow, value => update('arrow', value, 'style'), { values: ['none', 'start', 'end', 'both'] }),
        makeField('Dashed', edge.style.dashed, value => update('dashed', value, 'style'), { type: 'checkbox' }));
      if (edge.from) props.append(
        makeField('Start port', edge.from.port, value => update('port', value, 'from'), { values: ports }),
        makeField('End port', edge.to.port, value => update('port', value, 'to'), { values: ports }));
      props.append(button(edge.parentId ? 'Detach branch' : 'Delete connector', deleteSelection));
      return;
    }
    if (!selected || state.ids.size !== 1) {
      description.textContent = state.ids.size ? state.ids.size + ' objects selected' : 'Select an object or connector.';
      return;
    }
    description.textContent = selected.type === 'branch' ? 'Mind map node' : selected.type[0].toUpperCase() + selected.type.slice(1);
    const update = (key, value) => change(active => { active.objects.find(item => item.id === selected.id)[key] = value; });
    props.append(makeField('Locked', selected.locked, value => update('locked', value), { type: 'checkbox' }),
      makeField('Notes', selected.notes, value => update('notes', value), { multiline: true, maxLength: 20000 }),
      makeField('Source', selected.source, value => update('source', value), { maxLength: 2000 }));
    const candidates = currentScene.objects.filter(item => item.id !== selected.id && item.type !== 'group');
    if (candidates.length && selected.type !== 'group') {
      const target = document.createElement('select');
      target.setAttribute('aria-label', 'Connect to');
      target.add(new Option('Connect to…', ''));
      for (const object of candidates) target.add(new Option(object.text.split('\n')[0] || object.type, object.id));
      target.addEventListener('change', () => { if (target.value) addLink(selected.id, target.value); });
      props.append(target);
    }
    if (selected.type === 'branch') props.append(
      button(selected.folded ? 'Unfold branch' : 'Fold branch', () => update('folded', !selected.folded)),
      button('Arrange branch', arrange),
      button('Duplicate branch', duplicate),
      button('Detach branch', () => change(active => model.detachBranch(active, selected.id))));
  }

  function setTool(tool) {
    state.tool = tool;
    state.connect = null;
    viewport.dataset.tool = tool;
    for (const control of document.querySelectorAll('button[data-tool]')) setPressed(control, control.dataset.tool === tool);
    if (state.workspace) {
      updateSelection();
      shown('#empty', board().objects.length === 0 && tool === 'select');
    }
  }

  function objectID(id) {
    return [...objectLayer.children].find(button => button.dataset.object === id);
  }

  function beginEdit(id) {
    if (state.edit?.id === id) return;
    finishEdit();
    const object = currentScene.byId.get(id);
    if (!object || object.type === 'stroke' || object.locked) return;
    state.edit = { id, text: object.text };
    editor.value = object.text;
    editor.hidden = false;
    setBounds(editor, object);
    editor.style.height = Math.max(object.height, 55) + 'px';
    objectID(id).hidden = true;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function finishEdit(cancel = false) {
    const editing = state.edit;
    if (!editing) return true;
    const value = editor.value;
    state.edit = null;
    editor.hidden = true;
    const node = objectID(editing.id);
    if (node) node.hidden = false;
    if (cancel || value === editing.text) return true;
    const changed = change(active => {
      const object = active.objects.find(item => item.id === editing.id);
      object.text = value;
      object.height = geometry.box(object).height;
    });
    if (!changed) {
      state.edit = editing;
      editor.hidden = false;
      if (node) node.hidden = true;
    }
    return changed;
  }

  function freshObject(type, point, text = '') {
    return { id: model.uid(), type, x: point[0], y: point[1], width: type === 'text' ? 200 : 150,
      height: 46, text, style: {}, groupId: null, locked: false, folded: false };
  }

  function addObject(type, point) {
    if (!finishEdit()) return;
    const object = freshObject(type, point);
    if (change(active => active.objects.push(object), () => choose([object.id]))) {
      setTool('select');
      beginEdit(object.id);
    }
  }

  function addBranch(from, sibling) {
    const edge = board().branches.find(record => record.childId === from);
    const parentId = sibling && edge ? edge.parentId : from;
    const parent = currentScene.byId.get(parentId);
    if (!parent || !finishEdit()) return;
    const object = freshObject('branch', [parent.x + parent.width + 45, parent.y]);
    const side = sibling && edge ? edge.side : 'right';
    if (change(active => {
      const peers = active.branches.filter(record => record.parentId === parentId);
      const order = sibling && edge ? edge.order + 1 : Math.max(-1, ...peers.map(record => record.order)) + 1;
      for (const peer of peers) if (peer.order >= order) peer.order += 1;
      active.objects.push(object);
      active.objects.find(node => node.id === parentId).folded = false;
      active.branches.push({ id: model.uid(), parentId, childId: object.id, side, order, label: '',
        style: { arrow: 'none', route: 'curve' } });
      model.relayoutBranch(active, parentId);
    }, () => choose([object.id]))) beginEdit(object.id);
  }

  function addLink(from, to) {
    const record = { id: model.uid(), from: { objectId: from, port: 'auto' }, to: { objectId: to, port: 'auto' },
      label: '', style: { route: 'elbow', arrow: 'end', dashed: false } };
    setTool('select');
    if (change(active => active.links.push(record), () => choose([], record.id))) {
      shown('#inspector', true);
      setPressed($('button[data-command="inspector"]'), true);
      viewTransform();
      renderInspector();
    }
  }

  function deleteSelection() {
    if (!finishEdit()) return;
    change(active => {
      if (!state.edge) {
        const unlocked = [...state.ids].filter(id => !active.objects.find(object => object.id === id)?.locked);
        model.deleteObjects(active, unlocked);
      } else {
        const branch = active.branches.find(edge => edge.id === state.edge);
        if (branch) model.detachBranch(active, branch.childId);
        else active.links = active.links.filter(edge => edge.id !== state.edge);
      }
    }, () => choose());
  }

  function arrange() {
    const id = [...state.ids][0];
    if (id) change(active => model.relayoutBranch(active, id));
  }

  function duplicate() {
    const id = [...state.ids][0];
    if (!id) return;
    let newId;
    change(active => { newId = model.duplicateBranch(active, id); }, () => choose(newId ? [newId] : []));
  }

  async function download(name, data, mime) {
    if (bridge) return send('export', { name, text: data, mime });
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function fileName() {
    return board().title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 70) || 'Board';
  }

  async function loadImport() {
    if (bridge) return send('import');
    const input = $('#import-file');
    input.value = '';
    return new Promise(resolve => {
      filePicker = resolve;
      input.click();
    });
  }

  async function addImport() {
    if (filePicker) return false;
    const text = await loadImport();
    if (text == null) return false;
    if (new TextEncoder().encode(text).length > model.MAX_BYTES) throw new Error('The import exceeds the workspace size limit.');
    const imported = model.importDocument(JSON.parse(text), geometry.measure);
    if (!change((active, workspace) => model.addImportedBoards(workspace, imported.boards), () => choose())) return false;
    if (imported.warnings.length) notice(imported.warnings.join(' '));
    return flush();
  }

  function switchBoard(id) {
    if (!finishEdit() || board().id === id) return;
    state.workspace = { ...state.workspace, activeBoardId: id };
    choose();
    setTool('select');
    schedule();
    render();
  }

  function addBoard(next) {
    return change((active, workspace) => model.addImportedBoards(workspace, [next]), () => choose());
  }

  function togglePanel(selector, name) {
    const panel = $(selector);
    panel.hidden = !panel.hidden;
    setPressed($('button[data-command="' + name + '"]'), !panel.hidden);
    viewTransform();
    if (name === 'inspector') renderInspector();
  }

  const commands = {
    new: () => addBoard(model.emptyBoard()),
    example: () => addBoard(model.exampleBoard()),
    save: flush,
    open: addImport,
    undo: () => undo(),
    redo: () => undo(true),
    exportSVG: () => download(fileName() + '.svg', geometry.svg(geometry.scene(board(), { all: true }), board().title), 'image/svg+xml'),
    exportBoard: () => download(fileName() + '.mindmap', JSON.stringify(board(), null, 2), 'application/json'),
    boards: () => togglePanel('#library', 'boards'),
    inspector: () => togglePanel('#inspector', 'inspector'),
    fit,
    zoomIn: () => zoomAt(1.2),
    zoomOut: () => zoomAt(1 / 1.2),
    dismiss: () => notice(''),
  };

  async function perform(name) {
    if (!state.workspace || !commands[name]) return false;
    if (!finishEdit()) return false;
    try {
      const result = await commands[name]();
      return result !== false;
    } catch (error) {
      notice(error.message || String(error));
      return false;
    }
  }

  function startGesture(event, kind, values = {}) {
    if (kind !== 'move') viewport.setPointerCapture(event.pointerId);
    const start = [event.clientX, event.clientY];
    state.gesture = { id: event.pointerId, kind, start, dx: 0, dy: 0, ...values };
  }

  viewport.addEventListener('pointerdown', event => {
    if (!state.workspace || event.target === editor || event.button > 1) return;
    if (event.button === 1 || state.space) {
      if (!finishEdit()) return;
      event.preventDefault();
      viewport.dataset.panning = 'true';
      startGesture(event, 'pan');
      return;
    }
    const edge = event.target.closest('[data-edge]')?.dataset.edge;
    const object = event.target.closest('[data-object]')?.dataset.object;
    if (state.tool === 'draw') {
      event.preventDefault();
      startGesture(event, 'stroke', { points: [xy(event)] });
    } else if (state.tool === 'link' && object) {
      if (state.connect) addLink(state.connect, object);
      else {
        state.connect = object;
        choose([object]);
        updateSelection();
      }
    } else if (['text', 'shape', 'branch'].includes(state.tool)) {
      event.preventDefault();
      addObject(state.tool, xy(event));
    } else if (state.tool === 'select') {
      if (edge) choose([], edge);
      else if (!object) choose();
      else if (event.shiftKey) {
        if (state.ids.has(object)) state.ids.delete(object);
        else state.ids.add(object);
        state.edge = null;
      } else if (!state.ids.has(object)) choose([object]);
      updateSelection();
      if (object && state.ids.has(object) && !currentScene.byId.get(object).locked) {
        startGesture(event, 'move', { ids: new Set(state.ids) });
      }
    }
  });

  viewport.addEventListener('pointermove', event => {
    const drag = state.gesture;
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.kind === 'stroke') {
      const next = xy(event);
      const previous = drag.points.at(-1);
      if (drag.points.length < 25000 && Math.hypot(next[0] - previous[0], next[1] - previous[1]) >= 1) drag.points.push(next);
      renderDiagram();
    } else {
      const scale = drag.kind === 'move' ? board().view.zoom : 1;
      const dx = (event.clientX - drag.start[0]) / scale;
      const dy = (event.clientY - drag.start[1]) / scale;
      if (drag.kind === 'move' && !drag.dx && !drag.dy && Math.hypot(dx, dy) < 2) return;
      if (drag.kind === 'move' && !viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId);
      drag.dx = dx;
      drag.dy = dy;
      if (drag.kind === 'move') renderWorld();
      else viewTransform();
    }
  });

  function finishGesture(commit) {
    const drag = state.gesture;
    if (!drag) return;
    state.gesture = null;
    viewport.dataset.panning = 'false';
    if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
    if (drag.kind === 'move' && !drag.dx && !drag.dy) return;
    if (commit && drag.kind === 'move' && (drag.dx || drag.dy)) {
      if (change(active => model.moveObjects(active, drag.ids, drag.dx, drag.dy))) return;
    } else if (commit && drag.kind === 'pan' && (drag.dx || drag.dy)) {
      const view = board().view;
      withView({ ...view, x: view.x + drag.dx, y: view.y + drag.dy });
      return;
    } else if (commit && drag.kind === 'stroke') {
      const xs = drag.points.map(point => point[0]);
      const ys = drag.points.map(point => point[1]);
      const x = Math.min(...xs) - 3, y = Math.min(...ys) - 3;
      const object = { ...freshObject('stroke', [x, y]), width: Math.max(...xs) - x + 3,
        height: Math.max(...ys) - y + 3, points: drag.points.map(point => [point[0] - x, point[1] - y]) };
      if (change(active => active.objects.push(object), () => choose([object.id]))) return;
    }
    renderWorld();
  }

  viewport.addEventListener('pointerup', event => { if (event.pointerId === state.gesture?.id) finishGesture(true); });
  viewport.addEventListener('pointercancel', () => finishGesture(false));
  viewport.addEventListener('lostpointercapture', () => finishGesture(false));
  viewport.addEventListener('dblclick', event => {
    const object = event.target.closest('[data-object]')?.dataset.object;
    if (object && state.tool === 'select') beginEdit(object);
  });
  viewport.addEventListener('wheel', event => {
    if (!state.workspace || event.target === editor) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * .004), [event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2]);
      return;
    }
    const view = board().view;
    withView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
  }, { passive: false });

  editor.addEventListener('blur', () => finishEdit());
  editor.addEventListener('input', () => {
    editor.style.height = '0px';
    editor.style.height = Math.min(360, Math.max(55, editor.scrollHeight + 2)) + 'px';
  });
  editor.addEventListener('keydown', event => {
    if (event.isComposing || !state.edit) return;
    const id = state.edit.id;
    const object = currentScene.byId.get(id);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (finishEdit()) objectID(id)?.focus();
    } else if (object.type === 'branch' && (event.key === 'Tab' || event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      if (!finishEdit()) return;
      if (event.key === 'Tab' && event.shiftKey) {
        const parent = board().branches.find(edge => edge.childId === id)?.parentId;
        if (parent) {
          choose([parent]);
          updateSelection();
          beginEdit(parent);
        } else objectID(id)?.focus();
      } else addBranch(id, event.key === 'Enter');
    } else if (object.type === 'branch' && event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input'));
    }
  });

  document.addEventListener('keydown', event => {
    if (!state.workspace || event.isComposing) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void perform('save');
    } else if (command && event.key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      undo(event.shiftKey);
    } else if (event.key === 'Escape' && (state.gesture || state.tool !== 'select')) {
      finishGesture(false);
      setTool('select');
    } else if (!typing && viewport.contains(event.target)) {
      if (event.code === 'Space' && event.target === viewport) {
        state.space = true;
        event.preventDefault();
      } else if (event.key === 'F2' && state.ids.size === 1) {
        event.preventDefault();
        beginEdit([...state.ids][0]);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelection();
      } else if (event.key.startsWith('Arrow') && state.ids.size) {
        const step = event.shiftKey ? 10 : 1;
        const movement = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (movement[event.key]) {
          event.preventDefault();
          change(active => model.moveObjects(active, state.ids, ...movement[event.key]));
        }
      }
    }
  });
  document.addEventListener('keyup', event => { if (event.code === 'Space') state.space = false; });
  window.addEventListener('blur', () => { state.space = false; finishGesture(false); });
  window.addEventListener('pagehide', () => { if (state.workspace) void flush(); });
  document.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (!state.workspace || !control) return;
    if (control.dataset.command) {
      const menu = $('#export-menu');
      if (menu.contains(control)) menu.hidePopover();
      void perform(control.dataset.command);
    } else if (control.dataset.board) switchBoard(control.dataset.board);
    else if (control.dataset.start) addObject(control.dataset.start, [-85, -28]);
    else if (control.dataset.tool && finishEdit()) setTool(control.dataset.tool);
    else if (event.detail === 0 && control.dataset.object) {
      if (state.tool === 'link' && state.connect) addLink(state.connect, control.dataset.object);
      else {
        if (state.tool === 'link') state.connect = control.dataset.object;
        choose([control.dataset.object]);
        updateSelection();
      }
    }
  });
  $('#board-title').addEventListener('change', event => {
    change(active => { active.title = event.target.value.trim() || 'Untitled board'; });
  });
  $('#import-file').addEventListener('change', async event => {
    const resolve = filePicker;
    filePicker = null;
    try {
      const file = event.target.files[0];
      if (file?.size > model.MAX_BYTES) throw new Error('The import exceeds the workspace size limit.');
      resolve?.(file ? await file.text() : null);
    } catch (error) {
      notice(error.message);
      resolve?.(null);
    }
  });
  $('#import-file').addEventListener('cancel', () => { filePicker?.(null); filePicker = null; });
  new ResizeObserver(viewTransform).observe(viewport);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.workspace) renderDiagram(); });

  async function initialize() {
    try {
      const stored = bridge ? await send('load') : localStorage.getItem(storageKey);
      state.baseline = stored;
      state.workspace = stored == null ? model.createWorkspace() : model.validateWorkspace(JSON.parse(stored));
      $('#board-title').disabled = false;
      status(stored == null ? 'Ready' : 'Saved');
      render();
      return true;
    } catch (error) {
      status('Couldn’t open workspace', true);
      notice(error.message || String(error));
      return false;
    }
  }

  window.MindMapperPrototype = { perform, ready: initialize() };
})();
