'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const model = require('../board.js');

const url = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const key = 'mindmapper-mac-prototype-workspace-v1';

async function workspace(page) {
  assert.equal(await page.evaluate(() => window.MindMapperPrototype.perform('save')), true);
  const raw = await page.evaluate(name => localStorage.getItem(name), key);
  return model.validateWorkspace(JSON.parse(raw));
}

const active = value => value.boards.find(board => board.id === value.activeBoardId);
const object = (value, id) => value.objects.find(item => item.id === id);
const dom = (page, id) => page.locator('[data-object="' + id + '"]');

async function centerOf(locator) {
  const rect = await locator.boundingBox();
  assert.ok(rect, 'Expected a visible canvas object or handle');
  return [rect.x + rect.width / 2, rect.y + rect.height / 2];
}

async function mappingAndDiagramming(page) {
  const run = name => page.evaluate(command => window.MindMapperPrototype.perform(command), name);
  await run('example');
  await run('fit');
  await dom(page, 'takes').click();
  await page.getByRole('button', { name: 'Left child', exact: true }).click();
  await page.locator('#object-editor').fill('Microphone placement');
  await page.keyboard.press('Escape');
  const mapped = active(await workspace(page));
  const child = mapped.objects.find(item => item.text === 'Microphone placement');
  assert.ok(mapped.branches.some(edge => edge.childId === child.id && edge.parentId === 'takes' && edge.side === 'left'));
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(dom(page, 'takes')).toBeFocused();
  await run('fit');

  const port = (id, side) => page.locator('[data-port-object="' + id + '"][data-port="' + side + '"]');
  const dragToPort = async (handle, id, side) => {
    await page.mouse.move(...await centerOf(handle));
    await page.mouse.down();
    await page.mouse.move(...await centerOf(dom(page, id)), { steps: 8 });
    await expect(dom(page, id)).toHaveAttribute('data-target', 'true');
    await expect(page.locator('#wire-preview path')).toHaveCount(1);
    await page.mouse.move(...await centerOf(port(id, side)));
    await page.mouse.up();
  };
  await dom(page, 'mic').hover();
  await dragToPort(port('mic', 'bottom'), 'note', 'left');
  const wired = active(await workspace(page));
  const connector = wired.links.find(link => !mapped.links.some(previous => previous.id === link.id));
  assert.deepEqual(connector.from, { objectId: 'mic', port: 'bottom' });
  assert.deepEqual(connector.to, { objectId: 'note', port: 'left' });
  assert.deepEqual(wired.branches, mapped.branches);

  await run('fit');
  await dragToPort(page.locator('[data-wire-end="from"]'), 'takes', 'top');
  await dragToPort(page.locator('[data-wire-end="to"]'), 'monitor', 'bottom');
  const reconnected = active(await workspace(page)).links.find(link => link.id === connector.id);
  assert.deepEqual(reconnected.from, { objectId: 'takes', port: 'top' });
  assert.deepEqual(reconnected.to, { objectId: 'monitor', port: 'bottom' });
  await run('fit');
  const bend = page.locator('[data-bend]').first();
  const [bx, by] = await centerOf(bend);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx + 52, by - 43, { steps: 8 });
  await page.mouse.up();
  const pinned = active(await workspace(page)).links.find(link => link.id === connector.id);
  assert.ok(pinned.waypoints?.length);
  const movedBend = await centerOf(bend);
  await page.mouse.move(...movedBend);
  await page.mouse.down();
  await page.mouse.move(movedBend[0] - 20, movedBend[1] + 30, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(active(await workspace(page)).links.find(link => link.id === connector.id), pinned);

  await dom(page, 'monitor').click();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(active(await workspace(page)).links.find(link => link.id === connector.id).waypoints, pinned.waypoints);
  await run('new');
  if (await page.locator('#inspector').isVisible()) await run('inspector');
  const canvas = await page.locator('#viewport').boundingBox();
  const x = canvas.x + 260, y = canvas.y + 280;
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.mouse.move(x - 90, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y, { steps: 18 });
  await page.mouse.up();
  const drawn = active(await workspace(page));
  assert.equal(drawn.objects.length, 1);
  const stroke = drawn.objects[0];
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.mouse.move(x, y - 30);
  await page.mouse.down();
  await page.mouse.move(x, y + 30, { steps: 6 });
  await page.mouse.up();
  const erased = active(await workspace(page));
  assert.equal(erased.objects.length, 2);
  assert.equal(erased.objects[0].id, stroke.id);
  await run('undo');
  assert.deepEqual(active(await workspace(page)).objects, [stroke]);
  await page.mouse.move(x, y - 30);
  await page.mouse.down();
  await page.mouse.move(x, y + 30, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(active(await workspace(page)).objects, [stroke]);
  await page.mouse.click(x, y);
  await expect(dom(page, stroke.id)).toHaveAttribute('aria-pressed', 'true');
}

async function dailyCanvas(page) {
  const run = name => page.evaluate(command => window.MindMapperPrototype.perform(command), name);
  await run('new');
  const title = page.getByRole('textbox', { name: 'Board title' });
  await title.fill('Studio planning');
  await title.press('Tab');
  if (await page.locator('#inspector').isVisible()) await run('inspector');
  const canvas = await page.locator('#viewport').boundingBox();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.mouse.click(canvas.x + 140, canvas.y + 166);
  await page.locator('#object-editor').fill('Production notes\nRecord a dry take.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Shape options', exact: true }).click();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.mouse.click(canvas.x + 400, canvas.y + 176);
  await page.locator('#object-editor').fill('Review');
  await page.keyboard.press('Escape');
  let stage = active(await workspace(page));
  const [note, circle] = stage.objects;
  assert.equal(note.type, 'note');
  assert.equal(circle.shape, 'circle');
  const handle = await page.locator('[data-corner="se"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y + 26, { steps: 6 });
  await page.mouse.up();
  stage = active(await workspace(page));
  const expanded = object(stage, circle.id);
  assert.ok(expanded.width > circle.width);
  assert.equal(expanded.width, expanded.height);

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await dom(page, note.id).click();
  await dom(page, circle.id).click();
  const connectorLabel = page.getByRole('textbox', { name: 'Label', exact: true });
  await connectorLabel.fill('Draft ready');
  await connectorLabel.press('Tab');
  await run('inspector');
  const rectangles = await Promise.all([note.id, circle.id].map(id => dom(page, id).boundingBox()));
  const left = Math.min(...rectangles.map(box => box.x)) - 9;
  const top = Math.min(...rectangles.map(box => box.y)) - 9;
  const right = Math.max(...rectangles.map(box => box.x + box.width)) + 9;
  const bottom = Math.max(...rectangles.map(box => box.y + box.height)) + 9;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.object[aria-pressed="true"]')).toHaveCount(2);
  await run('inspector');
  const align = page.getByRole('combobox', { name: 'Align and distribute', exact: true });
  await align.selectOption('top');
  const aligned = active(await workspace(page));
  assert.equal(object(aligned, note.id).y, object(aligned, circle.id).y);
  await page.getByRole('button', { name: 'Group in frame', exact: true }).click();
  const grouped = active(await workspace(page));
  const frame = grouped.objects.find(item => item.type === 'group');
  assert.equal(object(grouped, note.id).groupId, frame.id);
  assert.equal(object(grouped, circle.id).groupId, frame.id);
  await run('inspector');

  const beforeView = grouped.view;
  await run('fitSelection');
  assert.notDeepEqual(active(await workspace(page)).view, beforeView);
  await run('centre');
  const centred = active(await workspace(page));
  assert.deepEqual([centred.view.x, centred.view.y], [0, 0]);
  const clipboard = await page.evaluate(() => {
    document.querySelector('#viewport').focus();
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
    document.querySelector('#viewport').dispatchEvent(event);
    return { cancelled: event.defaultPrevented,
      selection: data.getData('application/x-mindmapper-selection+json'), text: data.getData('text/plain') };
  });
  assert.ok(clipboard.cancelled && clipboard.text.includes('Production notes'));
  await run('new');
  await page.evaluate(payload => {
    const target = document.querySelector('#viewport');
    target.focus();
    const data = new DataTransfer();
    data.setData('application/x-mindmapper-selection+json', payload.selection);
    data.setData('text/plain', payload.text);
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, clipboard);
  const pasted = active(await workspace(page));
  const originalIds = new Set(grouped.objects.map(item => item.id));
  assert.equal(pasted.objects.length, 3);
  assert.ok(pasted.objects.every(item => !originalIds.has(item.id)));
  assert.equal(pasted.links[0].label, 'Draft ready');
  assert.ok(pasted.objects.some(item => item.id === pasted.links[0].to.objectId && item.shape === 'circle'));
  await page.getByRole('button', { name: 'Previous board', exact: true }).click();
  assert.equal(active(await workspace(page)).id, grouped.id);

  await run('new');
  await run('outline');
  await page.getByRole('textbox', { name: 'Indented text', exact: true }).fill('Project\n  - Find these details\n  - Approval');
  await page.getByRole('button', { name: 'Add branches', exact: true }).click();
  const outlined = active(await workspace(page));
  assert.equal(outlined.branches.length, 2);
  const root = outlined.objects.find(item => item.text === 'Project');
  await run('inspector');
  await dom(page, root.id).click();
  await page.getByRole('button', { name: 'Fold branch', exact: true }).click();
  await expect(page.locator('.object')).toHaveCount(1);
  await run('find');
  await page.getByRole('searchbox', { name: 'Find on this board' }).fill('Find these');
  await page.getByRole('button', { name: 'Find these details', exact: true }).click();
  await expect(page.locator('.object')).toHaveCount(3);
  assert.equal(object(active(await workspace(page)), root.id).folded, false);
  await run('duplicateBoard');
  assert.notEqual(active(await workspace(page)).id, outlined.id);
  await page.getByRole('searchbox', { name: 'Find boards' }).fill('Studio planning');
  await expect(page.locator('#board-list button')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Find boards' }).fill('');
  const beforeDeletion = await workspace(page);
  await run('removeBoard');
  await page.getByRole('button', { name: 'Delete board', exact: true }).click();
  await expect(page.locator('#board-list button')).toHaveCount(beforeDeletion.boards.length - 1);
  assert.equal((await workspace(page)).boards.length, beforeDeletion.boards.length - 1);
  await run('undo');
  assert.equal((await workspace(page)).boards.length, beforeDeletion.boards.length);
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mindmapper-browser-'));
  const browserErrors = [];
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chrome', viewport: { width: 1440, height: 900 }, acceptDownloads: true,
  });
  let context;
  try {
    context = await launch();
    const page = context.pages()[0];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(url);
    assert.equal(await page.evaluate(() => window.MindMapperPrototype.ready), true);
    await expect(page.getByRole('heading', { name: 'Blank board' })).toBeVisible();
    await expect(page.locator('.object')).toHaveCount(0);
    await page.getByRole('button', { name: 'Example board', exact: true }).click();
    await page.getByRole('button', { name: 'Snap objects', exact: true }).click();
    const example = active(await workspace(page));
    assert.ok(example.objects.some(entry => entry.type === 'stroke'));
    assert.ok(example.objects.some(entry => entry.type === 'text'));
    const wirePoint = await page.locator('[data-edge="to-preamp"]').evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(wirePoint.x, wirePoint.y);
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Route', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    const rect = await dom(page, 'preamp').boundingBox();
    await page.mouse.move(rect.x + 20, rect.y + 14);
    await page.mouse.down();
    await page.mouse.move(rect.x + 57, rect.y + 39, { steps: 5 });
    await page.mouse.up();
    const moved = object(active(await workspace(page)), 'preamp');
    assert.equal(moved.x, object(example, 'preamp').x + 37);
    assert.equal(moved.y, object(example, 'preamp').y + 25);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual(object(active(await workspace(page)), 'preamp'), object(example, 'preamp'));
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.deepEqual(object(active(await workspace(page)), 'preamp'), moved);

    const multiline = 'Trim gain\nCafé & <headroom> 🧑🏽‍💻';
    await dom(page, 'preamp').dblclick();
    await expect(page.locator('#object-editor')).toBeFocused();
    await page.locator('#object-editor').fill(multiline);
    await page.keyboard.press('Escape');
    assert.equal(object(active(await workspace(page)), 'preamp').text, multiline);

    await dom(page, 'takes').dblclick();
    await page.keyboard.press('Tab');
    await expect(page.locator('#object-editor')).toBeFocused();
    await page.locator('#object-editor').fill('Room reflections');
    await page.keyboard.press('Escape');
    const branched = active(await workspace(page));
    const child = branched.objects.find(item => item.text === 'Room reflections');
    assert.ok(branched.branches.some(edge => edge.parentId === 'takes' && edge.childId === child.id));
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(active(await workspace(page)).branches.length, example.branches.length);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();

    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await dom(page, 'mic').click();
    await dom(page, 'note').click();
    await page.getByLabel('Label', { exact: true }).fill('Watch & listen');
    await page.getByLabel('Label', { exact: true }).press('Tab');
    await page.getByRole('combobox', { name: 'Start port', exact: true }).selectOption('bottom');
    let edited = active(await workspace(page));
    const link = edited.links.find(record => record.label === 'Watch & listen');
    assert.equal(link.from.port, 'bottom');
    assert.equal(link.from.objectId, 'mic');
    assert.equal(link.to.objectId, 'note');
    assert.equal(edited.branches.length, branched.branches.length);

    const canvas = await page.locator('#viewport').boundingBox();
    await page.getByRole('button', { name: 'Draw', exact: true }).click();
    await page.mouse.move(canvas.x + 30, canvas.y + canvas.height - 90);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 80, canvas.y + canvas.height - 120, { steps: 12 });
    await page.mouse.up();
    edited = active(await workspace(page));
    assert.equal(edited.objects.filter(item => item.type === 'stroke').length, 2);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const zoomed = active(await workspace(page)).view.zoom;
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const undrawn = active(await workspace(page));
    assert.equal(undrawn.view.zoom, zoomed);
    assert.equal(undrawn.objects.filter(item => item.type === 'stroke').length, 1);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'SVG figure' }).click();
    const svg = await fs.readFile(await (await pending).path(), 'utf8');
    const parsed = await page.evaluate(content => {
      const xml = new DOMParser().parseFromString(content, 'image/svg+xml');
      return {
        bad: Boolean(xml.querySelector('parsererror')),
        images: xml.querySelectorAll('image').length,
        paths: xml.querySelectorAll('path').length,
        texts: [...xml.querySelectorAll('text')].map(node => node.textContent),
        preamp: [...xml.querySelectorAll('[data-object-id="preamp"] text')].map(node => node.textContent).join(''),
        bounds: xml.documentElement.getAttribute('viewBox').split(/\s+/).map(Number),
      };
    }, svg);
    assert.equal(parsed.bad, false);
    assert.equal(parsed.images, 0);
    assert.ok(parsed.paths > 4);
    assert.ok(parsed.bounds[2] > 100 && parsed.bounds[3] > 100);
    assert.equal(parsed.preamp, multiline.replace('\n', ''));
    assert.ok(parsed.texts.includes('Watch & listen'));

    // Use a supplied copy of a legacy map when checking the real migration.
    const legacyPath = process.argv[2];
    if (legacyPath) {
      const before = await fs.readFile(legacyPath, 'utf8');
      const expected = model.importDocument(JSON.parse(before)).boards;
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await (await chooser).setFiles(legacyPath);
      const options = page.locator('#board-list button');
      await expect(options).toHaveCount(2 + expected.length);
      const imported = active(await workspace(page));
      assert.equal(imported.objects.length, expected[0].objects.length);
      assert.deepEqual(imported.objects.map(item => [item.id, item.text, item.notes, item.source]),
        expected[0].objects.map(item => [item.id, item.text, item.notes, item.source]));
      assert.deepEqual(imported.branches, expected[0].branches);
      assert.equal(await fs.readFile(legacyPath, 'utf8'), before);
    }
    await dailyCanvas(page);
    await mappingAndDiagramming(page);

    const final = await workspace(page);
    await context.close();
    context = await launch();
    const reopened = context.pages()[0];
    await reopened.goto(url);
    assert.equal(await reopened.evaluate(() => window.MindMapperPrototype.ready), true);
    assert.deepEqual(await workspace(reopened), final);
    assert.deepEqual(browserErrors, []);
    console.log('Browser canvas passed: everyday editing, two-sided branches, port drag and preview, reconnection, pinned and cancelled bends, drawn and split strokes, SVG and save/reopen.'
      + (legacyPath ? ' Legacy map copy imported without changes to the original.' : ''));
  } finally {
    if (context) await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
