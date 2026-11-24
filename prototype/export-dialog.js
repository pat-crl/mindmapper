'use strict';

(() => {
  const element = id => document.getElementById('export-' + id);
  const dialog = element('dialog');
  const image = element('image');
  const scope = element('scope');
  const frame = element('frame');
  const format = element('format');
  const background = element('background');
  const scale = element('scale');
  const save = element('save');
  const share = element('share');
  const reveal = element('reveal');
  const formats = {
    svg: { extension: 'svg', mime: 'image/svg+xml' },
    pdf: { extension: 'pdf', mime: 'application/pdf' },
    png: { extension: 'png', mime: 'image/png' },
    jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  };
  const pdfLimit = 14_400;
  const number = new Intl.NumberFormat();
  let source, plan, previewURL, savedId, busy = false;

  function fileName(title) {
    return title.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/ {2,}/g, ' ').trim().slice(0, 70) || 'Board';
  }

  function download(name, data, mime, send) {
    if (send) return send('export', { name, text: data, mime });
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function setStatus(message = '', error = false, id = null) {
    const label = element('status');
    label.textContent = message;
    label.dataset.error = String(error);
    label.dataset.saved = String(Boolean(id));
    savedId = id;
    reveal.hidden = !id;
  }

  function clearPreview() {
    image.removeAttribute('src');
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = null;
  }

  function rasterFormat() {
    return format.value === 'jpeg' || format.value === 'png';
  }

  function updateSize() {
    const raster = rasterFormat();
    element('scale-field').hidden = !raster;
    let size = '';
    let error = '';
    if (plan) {
      try {
        const { width, height } = raster ? BoardExport.dimensions(plan, Number(scale.value)) : plan.area;
        if (format.value === 'pdf' && Math.max(width, height) > pdfLimit) {
          throw new Error('A PDF page can be up to 14,400 pt on either side. Choose a smaller area or use SVG.');
        }
        const units = format.value === 'pdf' ? 'pt · one page' : 'px';
        size = `${number.format(width)} × ${number.format(height)} ${units}`;
        if (format.value === 'jpeg' && background.value === 'transparent') size += ' · white background for JPEG';
      } catch (cause) {
        error = cause.message;
      }
    }
    element('size').textContent = size;
    save.disabled = share.disabled = busy || !plan || Boolean(error);
    return error;
  }

  function refresh() {
    clearPreview();
    plan = null;
    let error = '';
    element('frame-field').hidden = scope.value !== 'frame';
    try {
      plan = BoardExport.plan(source.board, {
        scope: scope.value, ids: source.ids, edgeId: source.edgeId, frameId: frame.value,
        includeFolded: element('folds').checked, padding: Number(element('padding').value),
        background: format.value === 'jpeg' && background.value === 'transparent' ? 'white' : background.value,
      });
      if (plan) {
        previewURL = URL.createObjectURL(new Blob([BoardExport.svg(plan, { preview: true })], { type: 'image/svg+xml' }));
        image.src = previewURL;
      }
    } catch (cause) {
      error = cause.message;
      plan = null;
    }
    image.hidden = !plan;
    element('preview').dataset.transparent = String(Boolean(plan && !plan.background));
    element('empty').hidden = Boolean(plan);
    const sizeError = updateSize();
    setStatus(error || sizeError, Boolean(error || sizeError));
  }

  function open(board, ids, edgeId, send) {
    if (dialog.open) return false;
    source = { board, ids: [...ids], edgeId, send, returnFocus: document.activeElement };
    const frames = BoardExport.listFrames(board);
    frame.replaceChildren(...frames.map((item, index) => new Option(item.text.trim() || `Untitled frame ${index + 1}`, item.id)));
    scope.querySelector('[value="selection"]').disabled = !source.ids.length && !edgeId;
    scope.querySelector('[value="frame"]').disabled = !frames.length;
    scope.value = 'board';
    const pdf = format.querySelector('[value="pdf"]');
    pdf.disabled = pdf.hidden = !send;
    share.hidden = !send;
    save.textContent = send ? 'Save…' : 'Download';
    dialog.showModal();
    refresh();
    return true;
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',', 2)[1]);
      reader.onerror = () => reject(new Error('Couldn’t read the image for export.'));
      reader.readAsDataURL(blob);
    });
  }

  async function write(action) {
    if (busy || !plan || save.disabled) return;
    busy = true;
    dialog.querySelector('fieldset').disabled = element('close').disabled = true;
    updateSize();
    setStatus('Preparing figure…');
    try {
      const { extension, mime } = formats[format.value];
      const name = fileName(plan.title) + '.' + extension;
      const send = source.send;
      let result;
      if (rasterFormat()) {
        const blob = await BoardExport.raster(plan, format.value, Number(scale.value));
        result = send ? await send(action, { name, mime, base64: await base64(blob) }) : download(name, blob, mime);
      } else {
        const svg = BoardExport.svg(plan);
        const { width, height } = plan.area;
        const content = format.value === 'pdf' ? { svg, width, height } : { text: svg };
        result = send ? await send(action, { name, mime, ...content }) : download(name, svg, mime);
      }
      if (action === 'share') setStatus('');
      else if (result == null) setStatus('Save cancelled.');
      else if (send) setStatus(`Saved to ${result.folder} · ${result.name}`, false, result.id);
      else setStatus('Download started.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      busy = false;
      dialog.querySelector('fieldset').disabled = element('close').disabled = false;
      updateSize();
    }
  }

  dialog.addEventListener('change', event => {
    if (event.target === scale) {
      const error = updateSize();
      setStatus(error, Boolean(error));
    } else refresh();
  });
  dialog.addEventListener('submit', event => { event.preventDefault(); void write('export'); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    clearPreview();
    if (source?.returnFocus && source.returnFocus !== document.body && source.returnFocus.offsetParent) {
      source.returnFocus.focus({ preventScroll: true });
    } else element('trigger').focus();
    plan = source = null;
  });
  element('close').addEventListener('click', () => dialog.close());
  share.addEventListener('click', () => void write('share'));
  reveal.addEventListener('click', async () => {
    if (!savedId) return;
    const id = savedId;
    try { await source.send('revealExport', { id }); }
    catch (error) { if (savedId === id && dialog.open) setStatus(error.message || String(error), true); }
  });

  window.BoardExportDialog = { open, download, fileName };
})();
