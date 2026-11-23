# Mind Mapper Mac prototype

## Run it on Mac

Run `prototype/mac/build.sh` from the project. Double-click the resulting `builds/mindmapper-prototype/Mind Mapper Prototype.app`. The build targets macOS 14.5 or later and is ad-hoc signed for local development.

The prototype opens on a blank board. **Example board** adds a signal chain, a mind map, a note and a stroke. Double-click a block to edit it. Tab adds a child in branch text, Return adds a sibling and Shift-Tab returns to the parent. Use **Connect** to choose two objects, then edit the label and ports in Inspector. Drawing, moving a selection and arranging a branch each commit a single undoable change. Import adds separate boards, and Export can write an editable board or a scalable SVG.

The app uses its own `~/Library/Application Support/Mind Mapper Prototype` folder. The previous workspace sits beside the current one. For an isolated run, set `MINDMAPPER_PROTOTYPE_DATA_DIR` to a scratch directory before launching the executable. The same editor can be opened from `prototype/index.html` in a local browser, where it uses a separate prototype storage key.

## Architecture

- `board.js` validates a versioned workspace that can hold empty and populated boards. Object array order is drawing order. Position, size, style, group, lock and fold state belong to objects. Pan and zoom belong to the view.
- Ordered tree relationships and arbitrary connectors are separate records. A feedback link can cycle without changing tree traversal. Connectors can attach to explicit object ports. Move carries descendants, and Arrange branch repositions descendants around the selected branch. Fold hides them without changing saved positions. Copy gives the copied branch and its internal links new IDs. Detach preserves positions. Group membership carries objects when the group itself moves.
- `workspace.js` owns the command history. Text has a separate DOM editor so gestures and canvas redraws can leave input focus intact. View changes persist without creating undo steps. Dragging and sketching use a transient preview before committing.
- `geometry.js` feeds the DOM boxes, SVG connectors, Fit and SVG export from one geometry and text wrapping pass. SVG export includes folded content so the whole board remains available. SVG text uses a system fallback family and remains text.
- The native shell supplies file pickers, save and recovery, Mac menus and the bundled offline WKWebView. It acknowledges a save only after the coordinated store writes it. A stale store rejects a replacement if the on-disk copy has changed.

## Legacy files

Import uses the unchanged 0.1.6 model to read legacy schema versions 1–4. It converts nodes into branch objects, preserves their content, order, positions, styles and links, and reports the old auto-zoom preference when present. The original file remains available for 0.1.6. The new editable export uses the prototype format.

## Verification

```sh
node --test prototype/tests/model.test.cjs
prototype/mac/build.sh
prototype/mac/check.sh
```

The Mac checks use a scratch store and a copy of the legacy file. To test a different legacy export, pass the app bundle and that file as the two arguments to `check.sh`.

The Chrome smoke check uses the same pinned Playwright dependency as the 0.1.6 test suite. It starts a scratch profile and runs the normal local HTML entry point. An optional argument adds a legacy restore check.

```sh
test_deps="$(mktemp -d)"
npm install --prefix "$test_deps" --no-save @playwright/test@1.58.2
NODE_PATH="$test_deps/node_modules" node prototype/tests/browser.cjs /path/to/legacy-copy.json
```

This prototype establishes the model, editing, export and native save path before the broader everyday canvas work. The native checks run on the installed macOS and WebKit. Test the earliest supported system and document-app SVG import during release verification.

The 250-object Phase 1 fixture with 24 extra links opened and fit in Chrome. Across 24 drag events at 1440 × 900, the synchronous handler took a median of 7.3 ms and a maximum of 11.6 ms on this Mac. The measurement excludes browser paint and display time. This is enough evidence to continue with DOM text and SVG geometry and measure full frame timing as the canvas grows.
