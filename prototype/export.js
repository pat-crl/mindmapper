'use strict';

const BoardExport = (() => {
  const geometry = BoardGeometry;
  const previewSide = 1600;
  const rasterSide = 8192;
  const rasterPixels = 16 * 1024 * 1024;

  const listFrames = board => board.objects.filter(object => object.type === 'group');

  function intersect(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  function paddedRect({ x, y, width, height }, padding) {
    const left = Math.floor(x - padding);
    const top = Math.floor(y - padding);
    return { x: left, y: top, width: Math.ceil(x + width + padding) - left, height: Math.ceil(y + height + padding) - top };
  }

  function plan(board, { scope = 'board', ids = [], edgeId, frameId, includeFolded = false,
    padding = 24, background = 'transparent' } = {}) {
    if (!['board', 'selection', 'frame'].includes(scope)) throw new Error('Choose an export area.');
    if (!['transparent', 'white', 'board'].includes(background)) throw new Error('Choose an export background.');
    if (!Number.isFinite(padding) || padding < 0 || padding > 500) throw new Error('Padding must be between 0 and 500 px.');
    // Keep the full scene's routes when exporting a subset. An outside obstacle or parallel link can influence a route.
    const scene = geometry.scene(board, { all: includeFolded });
    const colors = background === 'board' ? geometry.palette() : geometry.palette(false);
    let title = board.title;
    let { objects, edges } = scene;
    let clip;
    if (scope === 'selection') {
      const selected = BoardArrangement.selectionIds(board, ids);
      objects = objects.filter(object => selected.has(object.id));
      edges = edges.filter(edge => edge.id === edgeId || (selected.has(edge.fromId) && selected.has(edge.toId)));
      if (!objects.length && !edges.length) throw new Error('Select objects or a connector to export.');
      title += ' — Selection';
    } else if (scope === 'frame') {
      const frame = scene.byId.get(frameId);
      if (frame?.type !== 'group') throw new Error('Choose a visible frame to export.');
      // Keep the frame stroke inside the crop, with output padding outside the crop.
      clip = paddedRect(frame, 1);
      objects = objects.filter(object => intersect(clip, geometry.bounds({ objects: [object], edges: [] }, 0)));
      edges = edges.filter(edge => intersect(clip, geometry.bounds({ objects: [], edges: [edge] }, 0)));
      title = frame.text.trim() || 'Untitled frame';
    }
    if (!objects.length && !edges.length) return null;
    const drawing = { objects, edges };
    const area = paddedRect(clip || geometry.bounds(drawing, 0), padding);
    return { title, drawing, area, clip, colors, background: background === 'transparent' ? null : colors.paper };
  }

  function dimensions({ area }, scale = 1) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Choose a positive image scale.');
    const width = Math.ceil(area.width * scale);
    const height = Math.ceil(area.height * scale);
    if (width > rasterSide || height > rasterSide || width * height > rasterPixels) {
      throw new Error('This image exceeds 8,192 px per side or 16.8 megapixels. Choose a smaller scale, a frame or SVG.');
    }
    return { width, height };
  }

  function svg(figure, { preview = false, size = figure.area, background = figure.background } = {}) {
    if (preview) {
      const scale = Math.min(1, previewSide / Math.max(figure.area.width, figure.area.height));
      size = { width: Math.max(1, Math.round(figure.area.width * scale)), height: Math.max(1, Math.round(figure.area.height * scale)) };
    }
    return geometry.svg(figure.drawing, figure.title, figure.colors, { ...figure, background, size });
  }

  async function raster(figure, format, scale = 1) {
    if (!['png', 'jpeg'].includes(format)) throw new Error('Choose PNG or JPEG for a raster image.');
    const mime = 'image/' + format;
    const size = dimensions(figure, scale);
    const background = figure.background || (format === 'jpeg' ? '#ffffff' : null);
    const url = URL.createObjectURL(new Blob([svg(figure, { size, background })], { type: 'image/svg+xml' }));
    const canvas = document.createElement('canvas');
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('The figure could not be rendered as an image.'));
        image.src = url;
      });
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('There is insufficient memory to render this image. Choose a smaller scale.');
      // Paint the complete canvas so JPEG stays opaque even if fractional scaling leaves a thin border.
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, size.width, size.height);
      }
      context.drawImage(image, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob?.size && blob.type === mime) resolve(blob);
        else reject(new Error('The image could not be encoded. Choose a smaller scale or another format.'));
      }, mime, .94));
    } finally {
      URL.revokeObjectURL(url);
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  return { plan, listFrames, svg, dimensions, raster };
})();
