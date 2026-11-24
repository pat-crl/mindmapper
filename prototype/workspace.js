'use strict';

(() => {
  const model = BoardModel;
  const geometry = BoardGeometry;
  const layout = BoardArrangement;
  const workflows = BoardWorkflows;
  const structure = BoardStructure;
  const ink = BoardInk;
  const wires = BoardWireControls;
  const exportDialog = BoardExportDialog;
  const $ = selector => document.querySelector(selector);
  const viewport = $('#viewport');
  const world = $('#world');
  const diagram = $('#diagram');
  const objectLayer = $('#objects');
  const editor = $('#object-editor');
  const bridge = window.webkit?.messageHandlers?.mindmapper;
  const storageKey = 'mindmapper-mac-prototype-workspace-v1';
  const ports = ['auto', 'left', 'right', 'top', 'bottom'];
  const selectionType = 'application/x-mindmapper-selection+json';
  const gridSize = 18;
  const historyLimit = 8 * 1024 * 1024;
  const state = {
    workspace: null, ids: new Set(), edge: null, tool: 'select', connect: null,
    edit: null, gesture: null, space: false, prior: [], next: [], previousBoard: null,
    shape: 'rounded', grid: true, snapGrid: false, snapObjects: true, findMatches: [], hoverPort: null,
    revision: 0, saved: 0, saving: null, timer: null, baseline: null,
  };
  let currentScene;
  let filePicker;

  const board = (workspace = state.workspace) => workspace.boards.find(item => item.id === workspace.activeBoardId);
  const send = (action, values = {}) => bridge.postMessage({ action, ...values });
  const copy = value => structuredClone(value);
  const shown = (selector, value) => { $(selector).hidden = !value; };
  const setPressed = (button, value) => button.setAttribute('aria-pressed', String(value));
  const isTyping = element => Boolean(element?.closest('input, textarea, select, [contenteditable=true]'));

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
    if (!finishEdit()) return;
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
    if (!visible.has(state.connect?.objectId)) state.connect = null;
  }

  function choose(ids = [], edge = null) {
    state.ids = new Set(ids);
    state.edge = edge;
  }

  function updateSelection() {
    for (const button of objectLayer.children) {
      setPressed(button, state.ids.has(button.dataset.object));
      button.dataset.linkSource = String(state.connect?.objectId === button.dataset.object);
    }
    renderHandles();
    renderWireControls();
    renderBranchTools();
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
    world.style.setProperty('--inverse-zoom', 1 / view.zoom);
    const spacing = gridSize * view.zoom;
    viewport.style.setProperty('--grid-dot', Math.min(.85, Math.max(.42, .75 * view.zoom)) + 'px');
    viewport.style.backgroundSize = spacing + 'px ' + spacing + 'px';
    viewport.style.backgroundPosition = (x - spacing / 2) + 'px ' + (y - spacing / 2) + 'px';
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

  function selectionArea() {
    const objects = currentScene.objects.filter(item => state.ids.has(item.id));
    const edges = currentScene.edges.filter(edge => edge.id === state.edge);
    return objects.length || edges.length ? geometry.bounds({ objects, edges }) : null;
  }

  function fit(area = geometry.bounds(currentScene)) {
    const branchTools = $('#branch-tools');
    const inset = Math.max(58, $('.tools').offsetHeight + 16,
      branchTools.hidden ? 0 : branchTools.offsetTop + branchTools.offsetHeight + 10);
    const zoom = Math.min(1.5, (viewport.clientWidth - 20) / area.width, (viewport.clientHeight - 2 * inset) / area.height);
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
    if (drag?.kind === 'resize') {
      return { ...active, objects: active.objects.map(object => object.id === drag.object.id
        ? resizeObject(object, drag) : object) };
    }
    if (drag?.kind === 'bend' && drag.moving) {
      return { ...active, links: active.links.map(edge => edge.id === drag.edgeId ? { ...edge, waypoints: drag.points } : edge) };
    }
    if (drag?.kind !== 'move' || (!drag.dx && !drag.dy)) return active;
    const draft = { ...active, objects: active.objects.map(object => ({ ...object })) };
    layout.move(draft, drag.ids, drag.dx, drag.dy);
    return draft;
  }

  function resizeObject(object, drag) {
    const { rect, corner, dx, dy } = drag;
    const left = corner.endsWith('w');
    const top = corner.startsWith('n');
    const line = object.shape === 'line';
    let width = Math.min(1e6, Math.max(line ? 6 : 36, rect.width + (left ? -dx : dx)));
    let height = Math.min(1e6, Math.max(line ? 1 : 24, rect.height + (top ? -dy : dy)));
    if (object.shape === 'circle' || drag.keepRatio) {
      const scaleX = width / rect.width, scaleY = height / rect.height;
      const scale = Math.abs(scaleX - 1) > Math.abs(scaleY - 1) ? scaleX : scaleY;
      width = rect.width * scale;
      height = rect.height * scale;
    }
    const box = geometry.box({ ...object, width, height });
    const updated = { ...object, width: box.width, height: box.height,
      x: left ? rect.x + rect.width - box.width : rect.x,
      y: top ? rect.y + rect.height - box.height : rect.y };
    if (object.points) updated.points = object.points.map(([x, y]) => [x * box.width / rect.width, y * box.height / rect.height]);
    return updated;
  }

  function renderHandles() {
    const layer = $('#handles');
    const selected = state.ids.size === 1 && currentScene.objects.find(object => state.ids.has(object.id));
    const focus = document.activeElement?.dataset.corner;
    if (!selected || selected.shape === 'junction' || selected.locked || state.edit || state.tool !== 'select') {
      layer.replaceChildren();
      return;
    }
    const corners = selected.shape === 'line'
      ? (selected.lineDirection === 'up' ? { sw: [0, 1], ne: [1, 0] } : { nw: [0, 0], se: [1, 1] })
      : { nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] };
    const handles = Object.entries(corners).map(([corner, [x, y]]) => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'handle';
      handle.dataset.corner = corner;
      handle.setAttribute('aria-label', 'Resize ' + corner.toUpperCase() + ' corner');
      handle.style.left = selected.x + x * selected.width + 'px';
      handle.style.top = selected.y + y * selected.height + 'px';
      return handle;
    });
    layer.replaceChildren(...handles);
    if (focus) handles.find(handle => handle.dataset.corner === focus)?.focus({ preventScroll: true });
  }

  function selectedBranch() {
    const id = state.ids.size === 1 ? [...state.ids][0] : null;
    const item = currentScene?.byId.get(id);
    return item?.type === 'branch' ? item : null;
  }

  function renderBranchTools() {
    const branch = selectedBranch();
    shown('#branch-tools', Boolean(branch && state.tool === 'select'));
    if (!branch) return;
    const incoming = board().branches.find(edge => edge.childId === branch.id);
    shown('#branch-tools [data-command="branchLeft"]', !incoming || incoming.side === 'left');
    shown('#branch-tools [data-command="branchRight"]', !incoming || incoming.side === 'right');
    shown('#branch-tools [data-command="branchSibling"]', Boolean(incoming));
    shown('#branch-tools [data-command="branchFold"]', board().branches.some(edge => edge.parentId === branch.id));
    $('#branch-tools [data-command="branchFold"]').textContent = branch.folded ? 'Unfold' : 'Fold';
  }

  function renderWireControls() {
    const gesture = state.gesture;
    const connecting = gesture?.kind === 'wire';
    const portLayer = $('#ports');
    const edgeLayer = $('#wire-handles');
    const showPorts = !state.edit && (state.tool === 'select' || state.tool === 'link') && (!gesture || connecting);
    const selected = !state.edge && state.ids.size === 1 ? [...state.ids][0] : null;
    const ids = showPorts ? [selected, state.hoverPort, gesture?.target?.objectId] : [];
    wires.renderPorts(portLayer, currentScene, ids, gesture?.target);
    const freeEdge = !connecting && state.tool === 'select' && board().links.some(link => link.id === state.edge);
    wires.renderHandles(edgeLayer, freeEdge ? currentScene.edges.find(edge => edge.id === state.edge) : null);
    wires.preview($('#wire-preview'), currentScene, connecting ? gesture : null);
    for (const node of objectLayer.children) node.dataset.target = String(connecting && node.dataset.object === gesture.target?.objectId);
  }

  function renderGuides() {
    const drag = state.gesture;
    const lines = [];
    if (drag?.kind === 'move' && drag.guides) {
      const view = board().view;
      const left = -(viewport.clientWidth / 2 + view.x) / view.zoom;
      const top = -(viewport.clientHeight / 2 + view.y) / view.zoom;
      for (const axis of ['x', 'y']) {
        const value = drag.guides[axis + 'Guide'];
        if (!Number.isFinite(value)) continue;
        const line = document.createElement('div');
        line.className = 'guide';
        line.dataset.axis = axis;
        line.style.left = (axis === 'x' ? value : left) + 'px';
        line.style.top = (axis === 'y' ? value : top) + 'px';
        line.style.width = (axis === 'x' ? 1 : viewport.clientWidth / view.zoom) + 'px';
        line.style.height = (axis === 'y' ? 1 : viewport.clientHeight / view.zoom) + 'px';
        lines.push(line);
      }
    }
    $('#guides').replaceChildren(...lines);
  }

  function renderDiagram() {
    const colors = geometry.palette();
    const drawing = currentScene;
    let markup = drawing.objects.filter(object => object.type === 'group').map(object => geometry.shapeMarkup(object, colors)).join('');
    markup += drawing.edges.map(edge => geometry.edgeMarkup(edge, colors, true, edge.id === state.edge)).join('');
    diagram.innerHTML = markup;
    const preview = $('#stroke-preview');
    const gesture = state.gesture;
    if (gesture?.kind === 'stroke') {
      preview.innerHTML = geometry.strokeMarkup({ x: 0, y: 0, points: gesture.points, style: { stroke: colors.blue } }, colors);
    } else if (gesture?.kind === 'erase') {
      const [x, y] = gesture.points.at(-1);
      const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      cursor.setAttribute('cx', x);
      cursor.setAttribute('cy', y);
      cursor.setAttribute('r', gesture.radius);
      cursor.setAttribute('fill', colors.paper);
      cursor.setAttribute('fill-opacity', '.5');
      cursor.setAttribute('stroke', colors.blue);
      cursor.setAttribute('vector-effect', 'non-scaling-stroke');
      preview.replaceChildren(cursor);
    } else preview.replaceChildren();
  }

  function setBounds(element, object) {
    element.style.left = object.x + 'px';
    element.style.top = object.y + 'px';
    element.style.width = object.width + 'px';
    element.style.height = object.height + 'px';
    Object.assign(element.style, geometry.textStyle(object));
  }

  function renderWorld() {
    currentScene = geometry.scene(displayBoard());
    const focused = document.activeElement?.dataset.object;
    const palette = geometry.palette();
    const nodes = currentScene.objects.map(object => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'object';
      button.dataset.object = object.id;
      button.dataset.type = object.type;
      button.dataset.locked = String(object.locked);
      button.dataset.linkSource = String(state.connect?.objectId === object.id);
      button.setAttribute('aria-label', [object.text || object.shape || object.type,
        object.locked && 'locked', object.folded && 'folded'].filter(Boolean).join(', '));
      setPressed(button, state.ids.has(object.id));
      setBounds(button, object);
      if (object.type === 'shape' || object.type === 'note' || object.type === 'stroke') {
        const figure = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        figure.setAttribute('class', 'figure');
        figure.setAttribute('aria-hidden', 'true');
        figure.setAttribute('viewBox', [object.x, object.y, object.width, object.height].join(' '));
        figure.innerHTML = object.type === 'stroke'
          ? geometry.strokeMarkup(object, palette) : geometry.shapeMarkup(object, palette);
        if (object.type === 'stroke' && figure.firstElementChild) {
          const hit = figure.firstElementChild.cloneNode();
          hit.setAttribute('class', 'stroke-hit');
          hit.setAttribute('stroke', 'transparent');
          hit.setAttribute('stroke-width', '13');
          hit.setAttribute('vector-effect', 'non-scaling-stroke');
          figure.append(hit);
        }
        button.append(figure);
        if (object.shape === 'line' || object.shape === 'junction') button.classList.add('line-object');
      } else if (object.type !== 'group') {
        if (object.style.fill) button.style.backgroundColor = object.style.fill;
        if (object.style.stroke) button.style.borderColor = object.style.stroke;
      }
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
    renderHandles();
    renderWireControls();
    renderBranchTools();
    renderGuides();
    renderDiagram();
    viewTransform();
    shown('#empty', board().objects.length === 0 && state.tool === 'select');
    if (state.edit && currentScene.byId.has(state.edit.id)) setBounds(editor, currentScene.byId.get(state.edit.id));
  }

  function render() {
    const active = board();
    const focus = document.activeElement?.dataset.board;
    const nav = $('#board-list');
    const query = $('#library-search').value.trim().toLocaleLowerCase();
    const entries = state.workspace.boards.filter(item => item.title.toLocaleLowerCase().includes(query)).map(item => {
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
    $('button[data-command="previousBoard"]').disabled = !state.previousBoard || !state.workspace.boards.some(item => item.id === state.previousBoard);
    renderWorld();
    renderInspector();
    if (!$('#find-panel').hidden) renderFind();
  }

  function makeField(label, value, onChange, options = {}) {
    const group = document.createElement('label');
    group.textContent = label;
    const control = document.createElement(options.values ? 'select' : options.multiline ? 'textarea' : 'input');
    if (options.values) {
      for (const item of options.values) {
        const [title, value] = Array.isArray(item) ? item : [item, item];
        control.add(new Option(title, value));
      }
    } else if (!options.multiline) control.type = options.type || 'text';
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
    if (options.maxLength) control.maxLength = options.maxLength;
    if (options.disabled) control.disabled = true;
    if (options.min !== undefined) control.min = options.min;
    if (options.max !== undefined) control.max = options.max;
    if (options.placeholder) control.placeholder = options.placeholder;
    control.dataset.field = label;
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
    const focus = props.contains(document.activeElement) ? document.activeElement.dataset.field : null;
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
        makeField('Label', edge.label, value => update('label', value), { maxLength: 500 }),
        makeField('Route', edge.style.route, value => update('route', value, 'style'), { values: ['straight', 'curve', 'elbow'] }),
        makeField('Arrow', edge.style.arrow, value => update('arrow', value, 'style'), { values: ['none', 'start', 'end', 'both'] }),
        makeField('Dashed', edge.style.dashed, value => update('dashed', value, 'style'), { type: 'checkbox' }));
      if (edge.from) {
        const candidates = currentScene.objects.filter(wires.eligible).map(item => [objectCaption(item), item.id]);
        props.append(
          makeField('Start object', edge.from.objectId, value => reconnect(edge.id, 'from', wires.endpoint(value, edge.from.port)), { values: candidates }),
          makeField('Start port', edge.from.port, value => update('port', value, 'from'), { values: ports }),
          makeField('End object', edge.to.objectId, value => reconnect(edge.id, 'to', wires.endpoint(value, edge.to.port)), { values: candidates }),
          makeField('End port', edge.to.port, value => update('port', value, 'to'), { values: ports }),
          makeField('Wire colour', edge.style.color, value => update('color', value.trim(), 'style'),
            { maxLength: 11, placeholder: 'Default or #hex' }),
          button('Reverse connector', () => reverse(edge.id)));
        if (edge.waypoints?.length) props.append(button('Reset automatic route', () => change(active => {
          active.links.find(record => record.id === edge.id).waypoints = [];
        })));
        else if (edge.style.route === 'elbow') {
          const geometry = currentScene.edges.find(record => record.id === edge.id);
          if (geometry && !geometry.bends.length) props.append(button('Add bend', () => change(active => {
            const [x, y] = geometry.label;
            active.links.find(record => record.id === edge.id).waypoints = [[x, y + 8]];
          })));
        }
      }
      props.append(button(edge.parentId ? 'Detach branch' : 'Delete connector', deleteSelection));
      restoreInspectorFocus(props, focus);
      return;
    }
    if (!selected) {
      description.textContent = 'Select an object or connector.';
      return;
    }
    if (state.ids.size > 1) {
      description.textContent = state.ids.size + ' objects selected';
      props.append(arrangementFields(true));
      restoreInspectorFocus(props, focus);
      return;
    }
    const typeNames = { branch: 'Mind map node', group: 'Frame', shape: 'Shape', text: 'Text', note: 'Note', stroke: 'Stroke' };
    description.textContent = selected.shape === 'junction' ? 'Junction' : typeNames[selected.type];
    const update = (key, value) => change(active => { active.objects.find(item => item.id === selected.id)[key] = value; });
    const setStyle = (key, value) => change(active => {
      active.objects.find(item => item.id === selected.id).style[key] = value;
    });
    if (selected.type === 'shape') props.append(makeField('Shape', selected.shape, value => change(active => {
      const item = active.objects.find(object => object.id === selected.id);
      const template = model.createObject('shape', [item.x, item.y], { shape: value });
      if ([value, item.shape].some(shape => shape === 'line' || shape === 'junction')) {
        item.width = template.width;
        item.height = template.height;
      }
      item.shape = template.shape;
      item.lineDirection = template.lineDirection;
    }), { values: model.SHAPES, disabled: selected.locked }));
    if (selected.shape === 'line') props.append(makeField('Slope', selected.lineDirection || 'down',
      value => update('lineDirection', value), { values: ['down', 'up'], disabled: selected.locked }));
    const geometryFields = { type: 'number', min: 1, max: 1000000, disabled: selected.locked };
    for (const dimension of selected.shape === 'junction' ? [] : ['width', 'height']) {
      props.append(makeField(dimension === 'width' ? 'Width' : 'Height', Math.round(selected[dimension]), value => {
        if (!value) return;
        const difference = Number(value) - selected[dimension];
        change(active => {
          const index = active.objects.findIndex(object => object.id === selected.id);
          active.objects[index] = resizeObject(active.objects[index], { rect: selected, corner: 'se',
            dx: dimension === 'width' ? difference : 0, dy: dimension === 'height' ? difference : 0 });
        });
      }, geometryFields));
    }
    props.append(makeField('Locked', selected.locked, value => update('locked', value), { type: 'checkbox' }),
      makeField('Notes', selected.notes, value => update('notes', value), { multiline: true, maxLength: 20000 }),
      makeField('Source', selected.source, value => update('source', value), { maxLength: 2000 }));
    if (workflows.sourceURL(selected.source)) props.append(button('Open source', () => {
      void perform('openSource');
    }));
    const stylePanel = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Style';
    stylePanel.append(legend);
    const colorField = (label, key) => makeField(label, selected.style[key], value => setStyle(key, value.trim()),
      { maxLength: 11, placeholder: 'Default or #hex' });
    if (selected.type !== 'stroke' && selected.shape !== 'line') stylePanel.append(colorField('Fill', 'fill'));
    stylePanel.append(colorField('Stroke', 'stroke'));
    if (selected.type !== 'stroke' && !['line', 'junction'].includes(selected.shape)) {
      stylePanel.append(colorField('Text colour', 'textColor'),
        makeField('Text size', selected.style.fontSize || 13, value => { if (value) setStyle('fontSize', Number(value)); },
          { type: 'number', min: 8, max: 96 }),
        makeField('Bold', selected.style.fontWeight === 'bold', value => setStyle('fontWeight', value ? 'bold' : 'normal'), { type: 'checkbox' }),
        makeField('Italic', Boolean(selected.style.italic), value => setStyle('italic', value), { type: 'checkbox' }));
    }
    props.append(stylePanel);
    const candidates = currentScene.objects.filter(item => item.id !== selected.id && wires.eligible(item));
    if (candidates.length && wires.eligible(selected)) {
      const target = document.createElement('select');
      target.setAttribute('aria-label', 'Connect to');
      target.add(new Option('Connect to…', ''));
      for (const object of candidates) target.add(new Option(objectCaption(object), object.id));
      target.addEventListener('change', () => { if (target.value) addLink(wires.endpoint(selected.id), wires.endpoint(target.value)); });
      props.append(target);
    }
    if (selected.type === 'branch') {
      const incoming = board().branches.find(record => record.childId === selected.id);
      const excluded = new Set([selected.id, ...model.descendants(board(), selected.id)]);
      const parents = currentScene.objects.filter(item => item.type === 'branch' && !excluded.has(item.id)
        && (!item.locked || item.id === incoming?.parentId));
      props.append(button(selected.folded ? 'Unfold branch' : 'Fold branch', () => update('folded', !selected.folded)),
        button('Arrange branch', arrange));
      if (parents.length) {
        props.append(makeField('Branch parent', incoming?.parentId || '', value => change(active => {
          if (value) structure.reparent(active, selected.id, value);
          else model.detachBranch(active, selected.id);
        }), { values: [['Independent branch', ''], ...parents.map(item => [objectCaption(item), item.id])], disabled: selected.locked }));
      }
      if (incoming && !board().branches.some(record => record.childId === incoming.parentId)) {
        props.append(makeField('Branch side', incoming.side, value => change(active =>
          structure.reparent(active, selected.id, incoming.parentId, value)), { values: ['left', 'right'], disabled: selected.locked }));
      }
    }
    props.append(arrangementFields(false, selected.type === 'group'));
    restoreInspectorFocus(props, focus);
  }

  function objectCaption(object) {
    return object.text.trim().split('\n')[0].slice(0, 80) || object.shape || object.type;
  }

  function restoreInspectorFocus(props, name) {
    if (name) [...props.querySelectorAll('[data-field]')].find(field => field.dataset.field === name)?.focus();
  }

  function arrangementFields(multiple, frame = false) {
    const group = document.createElement('fieldset');
    const title = document.createElement('legend');
    title.textContent = 'Arrange';
    group.append(title);
    if (multiple) {
      const alignment = document.createElement('select');
      alignment.setAttribute('aria-label', 'Align and distribute');
      alignment.add(new Option('Align and distribute…', ''));
      for (const [label, action] of [
        ['Align left', 'left'], ['Align horizontal centres', 'center'], ['Align right', 'right'],
        ['Align top', 'top'], ['Align vertical centres', 'middle'], ['Align bottom', 'bottom'],
        ['Distribute horizontally', 'distribute-x'], ['Distribute vertically', 'distribute-y'],
      ]) {
        const option = new Option(label, action);
        option.disabled = action.startsWith('distribute-') && state.ids.size < 3;
        alignment.add(option);
      }
      alignment.addEventListener('change', () => {
        if (alignment.value) change(active => layout.align(active, state.ids, alignment.value, currentScene.byId));
        alignment.value = '';
      });
      group.append(alignment);
    }
    if (multiple) group.append(button('Group in frame', () => void perform('group')),
      button('Arrange flow left to right', () => void perform('flowRight')),
      button('Arrange flow top to bottom', () => void perform('flowDown')));
    if (frame || (multiple && [...state.ids].some(id => currentScene.byId.get(id)?.type === 'group'))) {
      group.append(button('Ungroup frame', () => void perform('ungroup')));
    }
    group.append(button('Bring to front', () => void perform('front')),
      button('Send to back', () => void perform('back')),
      button('Duplicate selection', () => void perform('duplicate')));
    return group;
  }
  function setTool(tool) {
    state.tool = tool;
    state.connect = null;
    state.hoverPort = null;
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
    if (!finishEdit()) return;
    const object = currentScene.byId.get(id);
    if (!object || object.type === 'stroke' || ['line', 'junction'].includes(object.shape) || object.locked) return;
    state.edit = { id, text: object.text };
    editor.value = object.text;
    editor.hidden = false;
    setBounds(editor, object);
    editor.style.height = Math.max(object.height, 55) + 'px';
    objectID(id).hidden = true;
    renderHandles();
    renderWireControls();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function finishEdit(cancel = false, restoreFocus = true) {
    const editing = state.edit;
    if (!editing) return true;
    const value = editor.value;
    const hadFocus = restoreFocus && document.activeElement === editor;
    state.edit = null;
    if (hadFocus) viewport.focus({ preventScroll: true });
    editor.hidden = true;
    const node = objectID(editing.id);
    if (node) node.hidden = false;
    if (cancel || value === editing.text) {
      renderHandles();
      renderWireControls();
      return true;
    }
    const changed = change(active => {
      const object = active.objects.find(item => item.id === editing.id);
      object.text = value;
      object.height = geometry.box(object).height;
    });
    if (!changed) {
      state.edit = editing;
      editor.hidden = false;
      if (node) node.hidden = true;
      if (hadFocus) editor.focus({ preventScroll: true });
    }
    return changed;
  }

  function freshObject(type, point, text = '') {
    return model.createObject(type, point, { text, ...(type === 'shape' ? { shape: state.shape } : {}) });
  }

  function addObject(type, point) {
    if (!finishEdit()) return;
    const object = freshObject(type, point, type === 'group' ? 'Frame' : '');
    if (change(active => active.objects.push(object), () => choose([object.id]))) {
      setTool('select');
      if (['line', 'junction'].includes(object.shape)) objectID(object.id)?.focus();
      else beginEdit(object.id);
    }
  }

  function addBranch(from, sibling, side) {
    if (!from || !finishEdit()) return false;
    const incoming = board().branches.find(edge => edge.childId === from);
    if (side && incoming && incoming.side !== side) {
      notice('This branch grows to the ' + incoming.side + '.');
      return false;
    }
    let id;
    const added = change(active => { id = structure.addBranch(active, from, { kind: sibling ? 'sibling' : 'child', side }); },
      () => choose([id]));
    if (added && id) {
      revealObject(id);
      beginEdit(id);
    }
    return added;
  }

  function revealObject(id) {
    const rect = currentScene.byId.get(id);
    if (!rect) return;
    const view = board().view;
    const x = viewport.clientWidth / 2 + view.x + rect.x * view.zoom;
    const y = viewport.clientHeight / 2 + view.y + rect.y * view.zoom;
    const inset = Math.max(65, $('#branch-tools').offsetTop + $('#branch-tools').offsetHeight + 12);
    if (x >= 12 && x + rect.width * view.zoom <= viewport.clientWidth - 12
        && y >= inset && y + rect.height * view.zoom <= viewport.clientHeight - 56) return;
    withView({ ...view, x: -(rect.x + rect.width / 2) * view.zoom, y: -(rect.y + rect.height / 2) * view.zoom });
  }

  function addLink(from, to) {
    const record = { id: model.uid(), from, to,
      label: '', style: { route: 'elbow', arrow: 'end', dashed: false } };
    setTool('select');
    if (change(active => active.links.push(record), () => choose([], record.id))) {
      shown('#inspector', true);
      setPressed($('button[data-command="inspector"]'), true);
      viewTransform();
      renderInspector();
    }
  }

  function reconnect(id, side, target) {
    const link = board().links.find(item => item.id === id);
    if (!link || !target || wires.same(link[side], target)) return false;
    return change(active => { active.links.find(item => item.id === id)[side] = target; },
      () => choose([], id));
  }

  function reverse(id) {
    return change(active => {
      const link = active.links.find(item => item.id === id);
      [link.from, link.to] = [link.to, link.from];
      if (link.waypoints) link.waypoints.reverse();
    });
  }

  function choosePort(ref) {
    if (!ref) return;
    if (state.connect) addLink(state.connect, ref);
    else {
      setTool('link');
      state.connect = ref;
      choose([ref.objectId]);
      updateSelection();
    }
  }

  function deleteSelection() {
    if (!finishEdit()) return;
    change(active => {
      if (!state.edge) {
        removeObjects(active, state.ids);
      } else {
        const branch = active.branches.find(edge => edge.id === state.edge);
        if (branch) model.detachBranch(active, branch.childId);
        else active.links = active.links.filter(edge => edge.id !== state.edge);
      }
    }, () => choose());
  }

  function removeObjects(active, ids) {
    const removal = new Set([...ids].flatMap(id => [id, ...model.descendants(active, id)]));
    if (active.objects.some(object => removal.has(object.id) && object.locked)) {
      throw new Error('Unlock the selected objects or branches before deleting them.');
    }
    model.deleteObjects(active, ids);
  }

  function arrange() {
    const id = [...state.ids][0];
    if (id) change(active => model.relayoutBranch(active, id));
  }

  function duplicate() {
    if (!state.ids.size) return false;
    return insertSelection(layout.capture(board(), state.ids));
  }

  function insertSelection(selection, point) {
    let ids;
    return change(active => { ids = layout.insert(active, selection, point); }, () => choose(ids));
  }

  function groupSelection(ungroup = false) {
    let ids;
    return change(active => {
      ids = ungroup ? layout.ungroup(active, state.ids) : [layout.group(active, state.ids, currentScene.byId)];
    }, () => choose(ids));
  }

  function clipboardPayload() {
    if (!state.ids.size) return null;
    const payload = layout.capture(board(), state.ids);
    return {
      selection: JSON.stringify(payload),
      text: payload.objects.map(object => object.text).filter(Boolean).join('\n') || 'Mind Mapper objects',
    };
  }

  function writeClipboard(payload) {
    if (bridge) return send('writeClipboard', payload);
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
    if (!payload.html && !payload.selection) return navigator.clipboard.writeText(payload.text);
    const types = { 'text/plain': new Blob([payload.text], { type: 'text/plain' }) };
    if (payload.html) types['text/html'] = new Blob([payload.html], { type: 'text/html' });
    if (payload.selection) {
      const custom = { ...types, ['web ' + selectionType]: new Blob([payload.selection], { type: selectionType }) };
      return navigator.clipboard.write([new ClipboardItem(custom)]);
    }
    return navigator.clipboard.write([new ClipboardItem(types)]);
  }

  async function readClipboard() {
    if (bridge) return send('readClipboard');
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = 'web ' + selectionType;
        if (item.types.includes(type)) return { selection: await (await item.getType(type)).text() };
        if (item.types.includes('text/plain')) return { text: await (await item.getType('text/plain')).text() };
      }
      return {};
    }
    return { text: await navigator.clipboard.readText() };
  }

  const canvasPoint = () => ({ x: -board().view.x / board().view.zoom - 60, y: -board().view.y / board().view.zoom - 25 });

  function pastePayload(payload) {
    if (!payload) return false;
    const point = canvasPoint();
    if (payload.selection) {
      if (payload.selection.length > model.MAX_BYTES) throw new Error('The clipboard selection is too large.');
      return insertSelection(JSON.parse(payload.selection), point);
    }
    if (!payload.text) return false;
    const object = freshObject('text', [point.x, point.y], payload.text);
    return change(active => active.objects.push(object), () => choose([object.id]));
  }

  async function copySelection(cut = false) {
    const payload = clipboardPayload();
    if (!payload) return false;
    const ids = new Set(state.ids);
    const id = board().id;
    const revision = state.revision;
    const contents = cut ? JSON.parse(payload.selection).objects : [];
    if (contents.some(object => object.locked)) throw new Error('Unlock the selection before cutting it.');
    if (await writeClipboard(payload) === false) return false;
    if (!cut) return true;
    if (board().id !== id || state.revision !== revision) {
      notice('Selection copied. The board changed before it could be cut.');
      return true;
    }
    return change(active => removeObjects(active, contents.map(object => object.id)), () => {
      if ([...ids].every(key => state.ids.has(key))) choose();
    });
  }

  function copyOutline(rich) {
    const output = workflows.outline(board(), state.ids);
    if (!output.text) throw new Error('Select a mind map branch or open a board with a mind map.');
    return writeClipboard(rich ? output : { text: output.text });
  }

  function renderFind() {
    const results = $('#find-results');
    state.findMatches = workflows.searchBoard(board(), $('#board-find').value);
    if (!state.findMatches.length) {
      const msg = document.createElement('p');
      msg.textContent = $('#board-find').value.trim() ? 'No matches' : 'Find text, notes, sources or connector labels.';
      results.replaceChildren(msg);
      return;
    }
    results.replaceChildren(...state.findMatches.slice(0, 100).map(match => {
      const detail = match.field === 'text' || match.field === 'label' ? '' : ' · ' + match.field;
      const control = button(match.title + detail, () => showMatch(match));
      control.title = match.excerpt;
      return control;
    }));
  }

  function showMatch(match) {
    if (!change(active => workflows.revealMatch(active, match))) return;
    if (match.kind === 'edge') choose([], match.id);
    else choose([match.id]);
    updateSelection();
    const area = selectionArea();
    if (area) {
      const { zoom } = board().view;
      withView({ zoom, x: -(area.x + area.width / 2) * zoom, y: -(area.y + area.height / 2) * zoom });
    }
    closeFind(false);
    if (match.kind === 'edge') {
      shown('#inspector', true);
      setPressed($('button[data-command="inspector"]'), true);
      viewTransform();
      renderInspector();
      $('#properties input')?.focus();
    } else objectID(match.id)?.focus({ preventScroll: true });
  }

  function closeFind(restore = true) {
    shown('#find-panel', false);
    const trigger = $('button[data-command="find"]');
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus();
  }

  function openFind() {
    shown('#find-panel', true);
    $('button[data-command="find"]').setAttribute('aria-expanded', 'true');
    renderFind();
    $('#board-find').select();
  }

  const download = (name, data, mime) => exportDialog.download(name, data, mime, bridge ? send : null);
  const fileName = () => exportDialog.fileName(board().title);

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
    if (!finishEdit() || board().id === id || !state.workspace.boards.some(item => item.id === id)) return;
    state.previousBoard = board().id;
    state.workspace = { ...state.workspace, activeBoardId: id };
    choose();
    setTool('select');
    schedule();
    render();
  }

  function addBoard(next) {
    const old = board().id;
    return change((active, workspace) => model.addImportedBoards(workspace, [next]), () => {
      state.previousBoard = old;
      $('#library-search').value = '';
      choose();
    });
  }

  function duplicateBoard() {
    const id = board().id;
    return change((active, workspace) => workflows.duplicateBoard(workspace, id), () => {
      state.previousBoard = id;
      $('#library-search').value = '';
      choose();
    });
  }

  function togglePanel(selector, name) {
    const panel = $(selector);
    panel.hidden = !panel.hidden;
    setPressed($('button[data-command="' + name + '"]'), !panel.hidden);
    viewTransform();
    if (name === 'inspector') renderInspector();
  }

  function toggleViewOption(name) {
    state[name] = !state[name];
    const control = $('button[data-command="' + name + '"]');
    setPressed(control, state[name]);
    if (name === 'grid') viewport.dataset.grid = String(state.grid);
  }

  const commands = {
    new: () => addBoard(model.emptyBoard()),
    example: () => addBoard(model.exampleBoard()),
    renameBoard: () => $('#board-title').select(),
    duplicateBoard,
    previousBoard: () => switchBoard(state.previousBoard),
    removeBoard() {
      const dialog = $('#delete-dialog');
      dialog.returnValue = 'cancel';
      $('#delete-title').textContent = 'Delete “' + board().title + '”? You can undo in this session.';
      dialog.showModal();
    },
    save: flush,
    open: addImport,
    undo: () => undo(),
    redo: () => undo(true),
    exportFigure: () => exportDialog.open(board(), state.ids, state.edge, bridge ? send : null),
    exportSVG() {
      const figure = BoardExport.plan(board(), { includeFolded: true, padding: 30, background: 'board' });
      if (!figure) return false;
      return download(fileName() + '.svg', BoardExport.svg(figure), 'image/svg+xml');
    },
    exportBoard: () => download(fileName() + '.mindmap', JSON.stringify(board(), null, 2), 'application/json'),
    exportLibrary: () => download('Mind Mapper Library.json', JSON.stringify(state.workspace), 'application/json'),
    boards: () => togglePanel('#library', 'boards'),
    inspector: () => togglePanel('#inspector', 'inspector'),
    fit: () => fit(),
    fitSelection: () => { const area = selectionArea(); if (area) fit(area); },
    centre: () => withView({ ...board().view, x: 0, y: 0 }),
    find: openFind,
    closeFind,
    selectAll() { choose(currentScene.objects.map(object => object.id)); updateSelection(); },
    duplicate,
    branchLeft: () => addBranch(selectedBranch()?.id, false, 'left'),
    branchRight: () => addBranch(selectedBranch()?.id, false, 'right'),
    branchSibling: () => addBranch(selectedBranch()?.id, true),
    branchFold() {
      const branch = selectedBranch();
      if (!branch) return false;
      return change(active => { active.objects.find(item => item.id === branch.id).folded = !branch.folded; });
    },
    flowRight: () => change(active => structure.arrangeFlow(active, state.ids, 'horizontal', currentScene.byId)),
    flowDown: () => change(active => structure.arrangeFlow(active, state.ids, 'vertical', currentScene.byId)),
    group: () => groupSelection(),
    ungroup: () => groupSelection(true),
    front: () => change(active => layout.order(active, state.ids, 'front')),
    back: () => change(active => layout.order(active, state.ids, 'back')),
    cut: () => copySelection(true),
    copy: () => copySelection(),
    paste: async () => pastePayload(await readClipboard()),
    copyMarkdown: () => copyOutline(false),
    copyRich: () => copyOutline(true),
    outline() {
      const dialog = $('#outline-dialog');
      dialog.returnValue = 'cancel';
      $('#outline-text').value = '';
      dialog.showModal();
      $('#outline-text').focus();
    },
    openSource() {
      const id = [...state.ids][0];
      const href = workflows.sourceURL(board().objects.find(item => item.id === id)?.source);
      if (!href) return false;
      if (bridge) return send('openSource', { url: href });
      window.open(href, '_blank', 'noopener,noreferrer');
    },
    grid: () => toggleViewOption('grid'),
    snapGrid: () => toggleViewOption('snapGrid'),
    snapObjects: () => toggleViewOption('snapObjects'),
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
    if (state.tool === 'select' || state.tool === 'link') {
      const port = event.target.closest('[data-port-object]');
      const endpoint = event.target.closest('[data-wire-end]')?.dataset.wireEnd;
      const bend = event.target.closest('[data-bend]')?.dataset.bend;
      const link = board().links.find(item => item.id === state.edge);
      if (link && bend !== undefined) {
        const edge = currentScene.edges.find(item => item.id === link.id);
        if (!edge?.bends[Number(bend)] || !finishEdit()) return;
        event.preventDefault();
        viewport.focus({ preventScroll: true });
        startGesture(event, 'bend', { edgeId: edge.id, index: Number(bend), points: copy(edge.bends) });
        return;
      }
      const fixed = link && endpoint ? link[endpoint === 'from' ? 'to' : 'from'] : wires.reference(port, currentScene);
      if (fixed) {
        if (!finishEdit()) return;
        event.preventDefault();
        viewport.focus({ preventScroll: true });
        startGesture(event, 'wire', { fixed, endpoint, edgeId: endpoint && link?.id, pointer: xy(event) });
        renderWireControls();
        return;
      }
    }
    const corner = event.target.closest('[data-corner]')?.dataset.corner;
    if (corner && state.tool === 'select' && state.ids.size === 1) {
      const id = [...state.ids][0];
      const rect = currentScene.byId.get(id);
      if (!rect || rect.locked) return;
      event.preventDefault();
      startGesture(event, 'resize', { corner, object: { id }, rect });
      return;
    }
    const edge = event.target.closest('[data-edge]')?.dataset.edge;
    const object = event.target.closest('[data-object]')?.dataset.object;
    if (state.tool === 'draw' || state.tool === 'erase') {
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      startGesture(event, state.tool === 'draw' ? 'stroke' : 'erase',
        { points: [xy(event)], radius: 9 / board().view.zoom });
      renderDiagram();
    } else if (state.tool === 'link' && wires.eligible(currentScene.byId.get(object))) {
      choosePort(wires.endpoint(object));
    } else if (['text', 'note', 'shape', 'branch', 'group'].includes(state.tool)) {
      event.preventDefault();
      addObject(state.tool, xy(event));
    } else if (state.tool === 'select') {
      if (edge) choose([], edge);
      else if (!object) {
        const preserve = event.shiftKey ? new Set(state.ids) : new Set();
        choose(preserve);
        viewport.focus({ preventScroll: true });
        startGesture(event, 'marquee', { origin: xy(event), preserve, boxes: currentScene.byId });
      }
      else if (event.shiftKey) {
        if (state.ids.has(object)) state.ids.delete(object);
        else state.ids.add(object);
        state.edge = null;
      } else if (!state.ids.has(object)) choose([object]);
      updateSelection();
      if (object && state.ids.has(object) && !currentScene.byId.get(object).locked) {
        startGesture(event, 'move', { ids: new Set(state.ids), boxes: currentScene.byId,
          collapseTo: !event.shiftKey && state.ids.size > 1 ? object : null });
      } else if (object && !event.shiftKey && state.ids.size > 1) {
        choose([object]);
        updateSelection();
      }
    }
  });

  viewport.addEventListener('pointermove', event => {
    const drag = state.gesture;
    if (!drag) {
      if (!currentScene || state.edit || !['select', 'link'].includes(state.tool)) return;
      const hovered = wires.reference(event.target, currentScene)?.objectId || null;
      if (hovered !== state.hoverPort) {
        state.hoverPort = hovered;
        renderWireControls();
      }
      return;
    }
    if (event.pointerId !== drag.id) return;
    if (drag.kind === 'wire') {
      drag.pointer = xy(event);
      drag.moving ||= Math.hypot(event.clientX - drag.start[0], event.clientY - drag.start[1]) >= 4;
      drag.target = wires.target(event, currentScene, viewport);
      renderWireControls();
    } else if (drag.kind === 'bend') {
      drag.moving ||= Math.hypot(event.clientX - drag.start[0], event.clientY - drag.start[1]) >= 2;
      if (!drag.moving) return;
      drag.points[drag.index] = xy(event);
      currentScene = geometry.scene(displayBoard());
      renderDiagram();
      renderWireControls();
    } else if (drag.kind === 'stroke' || drag.kind === 'erase') {
      const next = xy(event);
      const previous = drag.points.at(-1);
      if (drag.points.length < 25000
          && Math.hypot(next[0] - previous[0], next[1] - previous[1]) >= .75 / board().view.zoom) drag.points.push(next);
      renderDiagram();
    } else if (drag.kind === 'marquee') {
      const point = xy(event);
      const [x, y] = drag.origin;
      drag.area = { x, y, width: point[0] - x, height: point[1] - y };
      const marker = $('#marquee');
      marker.hidden = false;
      marker.style.left = Math.min(x, point[0]) + 'px';
      marker.style.top = Math.min(y, point[1]) + 'px';
      marker.style.width = Math.abs(drag.area.width) + 'px';
      marker.style.height = Math.abs(drag.area.height) + 'px';
      choose([...drag.preserve, ...layout.marquee(drag.boxes, drag.area)]);
      for (const element of objectLayer.children) setPressed(element, state.ids.has(element.dataset.object));
    } else {
      const scale = drag.kind === 'pan' ? 1 : board().view.zoom;
      const dx = (event.clientX - drag.start[0]) / scale;
      const dy = (event.clientY - drag.start[1]) / scale;
      if (drag.kind === 'move' && !drag.moving && Math.hypot(dx, dy) < 2) return;
      if (drag.kind === 'move' && !viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId);
      drag.dx = dx;
      drag.dy = dy;
      if (drag.kind === 'move') {
        drag.moving = true;
        drag.guides = layout.snap(board(), drag.ids, dx, dy, { grid: state.snapGrid && !event.altKey, objects: state.snapObjects && !event.altKey,
          threshold: 6 / board().view.zoom, gridSize, boxes: drag.boxes });
        drag.dx = drag.guides.dx;
        drag.dy = drag.guides.dy;
        renderWorld();
      } else if (drag.kind === 'resize') {
        drag.keepRatio = event.shiftKey;
        renderWorld();
      }
      else viewTransform();
    }
  });

  function finishGesture(commit) {
    const drag = state.gesture;
    if (!drag) return;
    state.gesture = null;
    viewport.dataset.panning = 'false';
    if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
    if (drag.kind === 'wire') {
      state.hoverPort = null;
      renderWireControls();
      if (!commit) return;
      if (!drag.moving && !drag.edgeId) choosePort(drag.fixed);
      else if (drag.moving && drag.target) {
        if (drag.edgeId) reconnect(drag.edgeId, drag.endpoint, drag.target);
        else addLink(drag.fixed, drag.target);
      }
      return;
    }
    if (drag.kind === 'marquee') {
      shown('#marquee', false);
      if (!commit) choose(drag.preserve);
      updateSelection();
      return;
    }
    if (drag.kind === 'move' && !drag.moving) {
      if (commit && drag.collapseTo) {
        choose([drag.collapseTo]);
        updateSelection();
      }
      return;
    }
    renderGuides();
    if (commit && drag.kind === 'bend' && drag.moving) {
      if (change(active => { active.links.find(link => link.id === drag.edgeId).waypoints = drag.points; })) return;
    } else if (commit && drag.kind === 'move' && (drag.dx || drag.dy)) {
      if (change(active => layout.move(active, drag.ids, drag.dx, drag.dy))) return;
    } else if (commit && drag.kind === 'resize' && (drag.dx || drag.dy)) {
      if (change(active => {
        const index = active.objects.findIndex(object => object.id === drag.object.id);
        active.objects[index] = resizeObject(active.objects[index], drag);
      })) return;
    } else if (commit && drag.kind === 'pan' && (drag.dx || drag.dy)) {
      const view = board().view;
      withView({ ...view, x: view.x + drag.dx, y: view.y + drag.dy });
      return;
    } else if (commit && drag.kind === 'stroke') {
      let object;
      if (change(active => { object = ink.createStroke(drag.points); active.objects.push(object); },
        () => choose([object.id]))) return;
    } else if (commit && drag.kind === 'erase') {
      $('#stroke-preview').replaceChildren();
      if (change(active => { ink.erase(active, drag.points, drag.radius); })) return;
    }
    renderWorld();
  }

  viewport.addEventListener('pointerup', event => {
    if (event.pointerId !== state.gesture?.id) return;
    if (state.gesture.kind === 'wire') state.gesture.target = wires.target(event, currentScene, viewport);
    finishGesture(true);
  });
  viewport.addEventListener('pointerleave', () => {
    if (!state.gesture && state.hoverPort) {
      state.hoverPort = null;
      renderWireControls();
    }
  });
  viewport.addEventListener('pointercancel', () => finishGesture(false));
  viewport.addEventListener('lostpointercapture', () => finishGesture(false));
  viewport.addEventListener('dblclick', event => {
    const object = event.target.closest('[data-object]')?.dataset.object;
    if (object && state.tool === 'select') beginEdit(object);
  });
  viewport.addEventListener('wheel', event => {
    if (!state.workspace || event.target === editor) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * units * .004), [event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2]);
      return;
    }
    const view = board().view;
    withView({ ...view, x: view.x - event.deltaX * units, y: view.y - event.deltaY * units });
  }, { passive: false });

  editor.addEventListener('blur', () => finishEdit(false, false));
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
    if (!state.workspace || event.isComposing || event.target.closest?.('#export-dialog')) return;
    const typing = isTyping(event.target);
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === 's') {
      event.preventDefault();
      void perform('save');
    } else if (command && key === 'z' && !typing) {
      event.preventDefault();
      undo(event.shiftKey);
    } else if (command && key === 'f') {
      event.preventDefault();
      void perform('find');
    } else if (command && !typing && ['a', 'd', 'g'].includes(key)) {
      event.preventDefault();
      void perform({ a: 'selectAll', d: 'duplicate', g: event.shiftKey ? 'ungroup' : 'group' }[key]);
    } else if (event.key === 'Escape' && state.gesture) {
      finishGesture(false);
      setTool('select');
    } else if (event.key === 'Escape' && !$('#find-panel').hidden) {
      closeFind();
    } else if (event.key === 'Escape' && state.tool !== 'select') {
      setTool('select');
    } else if (!typing && viewport.contains(event.target)) {
      if (event.code === 'Space') {
        state.space = true;
        if (event.target === viewport) event.preventDefault();
      } else if (event.key === 'F2' && state.ids.size === 1) {
        event.preventDefault();
        beginEdit([...state.ids][0]);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelection();
      } else if (event.key.startsWith('Arrow') && event.target.dataset.bend !== undefined) {
        const step = event.shiftKey ? 10 : 1;
        const offsets = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        const edge = currentScene.edges.find(link => link.id === state.edge);
        const index = Number(event.target.dataset.bend);
        if (edge?.bends[index] && offsets[event.key]) {
          const points = copy(edge.bends);
          const [dx, dy] = offsets[event.key];
          points[index] = [points[index][0] + dx, points[index][1] + dy];
          event.preventDefault();
          change(active => { active.links.find(link => link.id === edge.id).waypoints = points; });
        }
      } else if (event.altKey && event.key.startsWith('Arrow') && selectedBranch()) {
        const directions = { ArrowLeft: 'parent', ArrowRight: 'child', ArrowUp: 'previous', ArrowDown: 'next' };
        const id = structure.traverse(board(), selectedBranch().id, directions[event.key]);
        event.preventDefault();
        if (id) {
          choose([id]);
          updateSelection();
          revealObject(id);
          objectID(id)?.focus({ preventScroll: true });
        }
      } else if (event.key.startsWith('Arrow') && state.ids.size) {
        const step = event.shiftKey ? 10 : 1;
        const movement = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (movement[event.key]) {
          event.preventDefault();
          const corner = event.target.dataset.corner;
          if (corner && state.ids.size === 1) {
            const id = [...state.ids][0], rect = currentScene.byId.get(id);
            const [dx, dy] = movement[event.key];
            change(active => {
              const index = active.objects.findIndex(object => object.id === id);
              if (index >= 0 && !active.objects[index].locked) {
                active.objects[index] = resizeObject(active.objects[index], { rect, corner, dx, dy });
              }
            });
          } else change(active => layout.move(active, state.ids, ...movement[event.key]));
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
      control.closest('[popover]')?.hidePopover();
      void perform(control.dataset.command);
    } else if (control.dataset.board) switchBoard(control.dataset.board);
    else if (control.dataset.start) addObject(control.dataset.start, [-85, -28]);
    else if (control.dataset.starter && finishEdit()) {
      control.closest('[popover]')?.hidePopover();
      addBoard(model.starterBoard(control.dataset.starter));
      fit();
    } else if (control.dataset.shape && finishEdit()) {
      control.closest('[popover]')?.hidePopover();
      state.shape = control.dataset.shape;
      $('button[data-tool="shape"]').title = 'Place ' + control.textContent.toLowerCase();
      setTool('shape');
    }
    else if (control.dataset.tool && finishEdit()) setTool(control.dataset.tool);
    else if (event.detail === 0 && control.dataset.portObject) choosePort(wires.reference(control, currentScene));
    else if (event.detail === 0 && control.dataset.object) {
      const ref = wires.reference(control, currentScene);
      if (state.tool === 'link' && ref) choosePort(ref);
      else {
        choose([control.dataset.object]);
        updateSelection();
      }
    }
  });

  function browserCopy(event, cut = false) {
    if (bridge || isTyping(event.target) || !state.workspace || !state.ids.size || !event.clipboardData) return;
    try {
      const payload = clipboardPayload();
      const contents = cut ? JSON.parse(payload.selection).objects : [];
      if (contents.some(object => object.locked)) throw new Error('Unlock the selection before cutting it.');
      event.clipboardData.setData(selectionType, payload.selection);
      event.clipboardData.setData('text/plain', payload.text);
      event.preventDefault();
      if (cut) change(active => removeObjects(active, contents.map(object => object.id)), () => choose());
    } catch (error) {
      event.preventDefault();
      notice(error.message || String(error));
    }
  }

  document.addEventListener('copy', event => browserCopy(event));
  document.addEventListener('cut', event => browserCopy(event, true));
  document.addEventListener('paste', event => {
    if (bridge || isTyping(event.target) || !state.workspace || !event.clipboardData) return;
    const selection = event.clipboardData.getData(selectionType);
    const text = event.clipboardData.getData('text/plain');
    if (!selection && !text) return;
    event.preventDefault();
    try { pastePayload({ selection, text }); } catch (error) { notice(error.message || String(error)); }
  });

  for (const menu of document.querySelectorAll('.popup[popover]')) {
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const trigger = $('[popovertarget="' + menu.id + '"]');
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      menu.style.top = Math.min(rect.bottom + 4, Math.max(8, innerHeight - 180)) + 'px';
      menu.style.left = Math.min(rect.left, Math.max(8, innerWidth - 185)) + 'px';
    });
  }

  $('#library-search').addEventListener('input', () => { if (state.workspace) render(); });
  $('#board-find').addEventListener('input', renderFind);
  $('#board-find').addEventListener('keydown', event => {
    if (event.key === 'Enter' && state.findMatches.length) {
      event.preventDefault();
      showMatch(state.findMatches[0]);
    }
    if (event.key === 'ArrowDown') $('#find-results button')?.focus();
  });
  $('#delete-dialog').addEventListener('close', event => {
    if (event.target.returnValue !== 'delete') return;
    const id = board().id;
    change((active, workspace) => workflows.removeBoard(workspace, id), () => choose());
  });
  $('#outline-dialog').addEventListener('close', event => {
    if (event.target.returnValue !== 'paste') return;
    const anchor = state.ids.size === 1 ? [...state.ids][0] : null;
    const { x, y } = canvasPoint();
    let roots;
    change(active => { roots = workflows.pasteOutline(active, $('#outline-text').value, anchor, [x, y]); },
      () => choose(roots));
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.workspace) renderWorld(); });

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
