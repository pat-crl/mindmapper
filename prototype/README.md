# Mind Mapper Mac prototype

## Run it on Mac

Run `prototype/mac/build.sh` from the project. Double-click the resulting `builds/mindmapper-prototype/Mind Mapper Prototype.app`. The build targets macOS 14.5 or later and is ad-hoc signed for local development.

The prototype opens on a blank board. **Start from template** adds a mind map, flowchart or signal flow. **Example board** combines a signal chain, a mind map, a note and a stroke. The previous 0.1.0 workspace reopens in the 0.1.1 build with its existing rounded blocks.

## Everyday canvas

- Add text, notes, blocks, decisions, circles, lines and frames. Double-click to edit text, use the corner handles to resize, and use Inspector for size, style, notes and sources. In branch text, Tab adds a child, Return adds a sibling and Shift-Tab returns to the parent.
- Shift-click or drag a marquee to select several objects. Use the arrow keys to nudge a selection or Shift-arrow for a larger step. Arrange in Inspector or the Mac menu to align, distribute, move forward or backward, and group in a frame. Drag a frame by its title to move its contents. The Inspector lock keeps an object in place during movement.
- Copy and paste selections within or across boards. The Mac clipboard carries fresh copies of objects and their internal connections on paste, and also provides readable text to other apps. Use Paste Outline to create branches from indented text. Copy Markdown and Copy Rich Text work with mind map branches.
- Use **Connect** to choose two objects, then edit the label and ports in Inspector. Drawing, resizing, moving a selection and arranging a branch each commit a single undoable change.
- Pan with two-finger scroll or Space-drag. Pinch or use modifier-scroll to zoom around the pointer. Fit, Fit selection and Centre work independently of undo. Grid and object snapping are separate toggles. Hold Option to move freely during a drag.
- Find a board from the sidebar or search within a board for text, connector labels, notes and sources. Choosing a result can reveal a folded branch. Rename in the title bar, duplicate from the library, or delete with the confirmation and undo in the editing session.
- Import adds separate boards. Export writes an editable board or a scalable SVG.

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

The Mac checks use a scratch store, a named scratch clipboard, and a copy of the legacy file. To test a different legacy export, pass the app bundle and that file as the two arguments to `check.sh`.

The Chrome smoke check uses the same pinned Playwright dependency as the 0.1.6 test suite. It starts a scratch profile and runs the normal local HTML entry point. An optional argument adds a legacy restore check.

```sh
test_deps="$(mktemp -d)"
npm install --prefix "$test_deps" --no-save @playwright/test@1.58.2
NODE_PATH="$test_deps/node_modules" node prototype/tests/browser.cjs /path/to/legacy-copy.json
```

The native checks run on the installed macOS and WebKit. Test the earliest supported system and document-app SVG import during release verification. Image and external file attachments remain future work.

The 250-object Phase 1 fixture with 24 extra links opened and fit in Chrome. Across 24 drag events at 1440 × 900, the synchronous handler took a median of 7.3 ms and a maximum of 11.6 ms on this Mac. The measurement excludes browser paint and display time. This is enough evidence to continue with DOM text and SVG geometry and measure full frame timing as the canvas grows.

The everyday canvas check used Fit, Find and Fit selection on the same fixture and verified that cursor-centred zoom held its world position. Keep those navigation controls for now and revisit a minimap when a larger working board makes orientation difficult.
