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

    const final = await workspace(page);
    await context.close();
    context = await launch();
    const reopened = context.pages()[0];
    await reopened.goto(url);
    assert.equal(await reopened.evaluate(() => window.MindMapperPrototype.ready), true);
    assert.deepEqual(await workspace(reopened), final);
    assert.deepEqual(browserErrors, []);
    console.log('Browser prototype passed: empty board, edit, drag/undo/redo, branches, port links, strokes, SVG, and saved workspace across Chrome restart.'
      + (legacyPath ? ' Legacy map copy imported without changes to the original.' : ''));
  } finally {
    if (context) await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
