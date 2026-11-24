'use strict';

const BoardWireControls = (() => {
  const geometry = BoardGeometry;
  const sides = ['left', 'right', 'top', 'bottom'];
  const svgNamespace = 'http://www.w3.org/2000/svg';

  const eligible = item => item && item.type !== 'group' && item.type !== 'stroke';
  const endpoint = (objectId, port = 'auto') => ({ objectId, port });
  const same = (a, b) => a?.objectId === b?.objectId && a?.port === b?.port;

  function reference(element, scene) {
    const port = element?.closest('[data-port-object]');
    if (port && eligible(scene.byId.get(port.dataset.portObject))) {
      return endpoint(port.dataset.portObject, port.dataset.port);
    }
    const object = element?.closest('[data-object]');
    if (object && eligible(scene.byId.get(object.dataset.object))) return endpoint(object.dataset.object);
    return null;
  }

  function target(event, scene, viewport) {
    const rect = viewport.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    const hit = document.elementsFromPoint(event.clientX, event.clientY).filter(element => viewport.contains(element));
    for (const element of hit) {
      const ref = reference(element, scene);
      if (ref) return ref;
    }
    return null;
  }

  function control(point, label, attributes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = attributes.portObject ? 'port' : 'wire-handle';
    button.setAttribute('aria-label', label);
    button.title = label;
    Object.assign(button.dataset, attributes);
    button.style.left = point[0] + 'px';
    button.style.top = point[1] + 'px';
    return button;
  }

  function renderPorts(layer, scene, ids, selectedTarget) {
    const focused = reference(document.activeElement, scene);
    const nodes = [...new Set(ids)].flatMap(id => {
      const item = scene.byId.get(id);
      if (!eligible(item)) return [];
      const name = item.text.split('\n')[0] || (item.shape === 'junction' ? 'junction' : item.type);
      return (item.shape === 'junction' ? ['auto'] : sides).map(side =>
        control(geometry.portPoint(item, side), side === 'auto' ? 'Connect to ' + name : name + ' · ' + side + ' port', {
          portObject: id, port: side, target: String(same(endpoint(id, side), selectedTarget)),
        }));
    });
    const active = layer.contains(document.activeElement);
    layer.replaceChildren(...nodes);
    if (active && focused) {
      nodes.find(node => same(reference(node, scene), focused))?.focus({ preventScroll: true });
    }
  }

  function renderHandles(layer, edge) {
    const active = layer.contains(document.activeElement);
    const focus = active ? document.activeElement.dataset : {};
    const handles = edge ? [
      control(edge.fromPoint, 'Reconnect start', { wireEnd: 'from' }),
      control(edge.toPoint, 'Reconnect end', { wireEnd: 'to' }),
      ...edge.bends.map((point, index) => control(point, 'Move bend ' + (index + 1), { bend: String(index) })),
    ] : [];
    layer.replaceChildren(...handles);
    if (active) {
      handles.find(node => node.dataset.wireEnd === focus.wireEnd && node.dataset.bend === focus.bend)?.focus({ preventScroll: true });
    }
  }

  function preview(layer, scene, gesture) {
    if (!gesture?.pointer) {
      layer.replaceChildren();
      return;
    }
    const fromRect = scene.byId.get(gesture.fixed.objectId);
    const toRect = scene.byId.get(gesture.target?.objectId);
    if (!fromRect) return;
    const [x, y] = gesture.pointer;
    const a = geometry.portPoint(fromRect, gesture.fixed.port, toRect || { x, y, width: 1, height: 1 });
    const b = toRect ? geometry.portPoint(toRect, gesture.target.port, fromRect) : [x, y];
    const middle = (a[0] + b[0]) / 2;
    const line = document.createElementNS(svgNamespace, 'path');
    line.setAttribute('class', 'live-wire');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('d', 'M' + a.join(' ') + ' H' + middle + ' V' + b[1] + ' H' + b[0]);
    layer.replaceChildren(line);
  }

  return { eligible, endpoint, same, reference, target, renderPorts, renderHandles, preview };
})();
