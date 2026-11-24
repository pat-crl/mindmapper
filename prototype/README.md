# Mind Mapper for Mac

## Run it on Mac

Open the Mind Mapper disk image and drag **Mind Mapper** to Applications. The first release targets macOS 14.5 or later. For a local development build, run `prototype/mac/build.sh` and open `builds/mindmapper/Mind Mapper.app`.

Mind Mapper 0.2.0 reopens workspaces created by the Mac prototypes and works offline. **Start from template** adds a mind map, flowchart or signal flow. **Example board** combines a signal chain, a mind map, a note and a stroke.

Double-click a `.mindmap` in Finder, or use **File → Open Map or Library…** (⌘O). Opening a file adds its boards to the library. **File → Open Recent** lists successfully opened files. Use ⌘N to start a board, ⌘F to find an idea, ⌘S to save now and ⇧⌘E to export a figure.

## Everyday canvas

- Add text, notes, blocks, decisions, circles, lines and frames. Double-click to edit text, use the corner handles to resize, and use Inspector for size, style, notes and sources. In branch text, Tab adds a child, Return adds a sibling and Shift-Tab returns to the parent.
- Shift-click or drag a marquee to select several objects. Use the arrow keys to nudge a selection or Shift-arrow for a larger step. Arrange in Inspector or the Mac menu to align, distribute, move forward or backward, and group in a frame. Drag a frame by its title to move its contents. The Inspector lock keeps an object in place during movement.
- Copy and paste selections within or across boards. The Mac clipboard carries fresh copies of objects and their internal connections on paste, and also provides readable text to other apps. Use Paste Outline to create branches from indented text. Copy Markdown and Copy Rich Text work with mind map branches.
- Drawing, resizing, moving a selection, arranging a flow or branch and editing a connector each commit a single undoable change.
- Pan with two-finger scroll or Space-drag. Pinch or use modifier-scroll to zoom around the pointer. Fit, Fit selection and Centre work independently of undo. Grid and object snapping are separate toggles. Hold Option to move freely during a drag.
- Find a board from the sidebar or search within a board for text, connector labels, notes and sources. Choosing a result can reveal a folded branch. Rename in the title bar, duplicate from the library, or delete with the confirmation and undo in the editing session.
- Import adds separate boards. Export can save the active board as `.mindmap` or the library as `.json`. Both are editable and can be imported into another Mind Mapper workspace.

## Mind maps, flows and sketches

- Select a branch for **Left child**, **Right child**, **Sibling** and **Fold**. Option-arrow moves between parent, child and siblings. Change **Branch parent** in Inspector to attach a subtree elsewhere without changing its position. Use **Arrange branch** when you want to reflow that tree.
- Hover over a block or select it to see its ports. Drag from a port to another object or port, or choose **Connect to** in Inspector. Select a wire to move either end, reverse it, edit its labels and arrowheads, or set fixed ports.
- Drag an elbow handle to pin a bend in board coordinates. Arrow keys nudge a focused bend handle. **Reset automatic route** restores routing around nearby boxes. Parallel feedback wires separate automatically. A **Junction** joins wires that share its dot. Wires that simply cross keep their own endpoints.
- Select flow objects and use **Arrange Flow Left to Right** or **Arrange Flow Top to Bottom**. Both work through Undo and leave the rest of the board where it is.
- Draw with a pointer, select strokes on their line, or sweep **Erase** across part of a stroke. The remaining parts can still be moved and exported. Escape cancels a wire drag, bend edit or drawing gesture.

## Figure export

Choose **Export → Figure…** to preview the whole board, the selection or a named frame. Frame export crops to the frame on the canvas. Set padding and background, and turn on **Include folded branches** when the figure should show a whole tree. The preview uses the same geometry as the saved file, including text wrapping, ink and connections.

- **SVG** keeps shapes and connections scalable and labels as live text. The document app determines which local fonts and glyphs it can display.
- **PDF** fits the figure to one vector page at its content size. It's available in the Mac app.
- **PNG** supports a transparent background. **JPEG** uses white when Transparent is selected. Choose a scale and review the resulting pixel dimensions before saving.

Use **Save…** to choose a file and folder. The export window confirms the saved location and offers **Show in Finder**. **Share…** opens the Mac share picker. The local browser editor downloads SVG, PNG, JPEG and editable files.

## Backup and recovery

Choose **Export → Editable library** for a backup you can open in Mind Mapper. Keep a dated copy outside the app’s data folder. To restore into the current library, open the backup as an import. Mind Mapper adds copies if the same board IDs are already present.

The Mac app keeps `Library.json` and its previous saved revision, `Library.previous.json`, in `~/Library/Application Support/Mind Mapper Prototype`. If a library is missing or cannot open, quit the app and copy both available files somewhere safe before restoring. To inspect the previous revision separately, copy `Library.previous.json` as `Library.json` into a scratch folder and launch the executable with `MINDMAPPER_PROTOTYPE_DATA_DIR` set to that folder. After confirming the recovery, export an editable copy for safekeeping.

The editor can also open from `prototype/index.html` in a browser with separate local storage.

## Architecture

- `board.js` validates a versioned workspace that can hold empty and populated boards. Object array order is drawing order. Position, size, style, group, lock and fold state belong to objects. Pan and zoom belong to the view.
- Ordered tree relationships and arbitrary connectors are separate records. A feedback link can cycle without changing tree traversal. Connectors can attach to explicit object ports. Move carries descendants, and Arrange branch repositions descendants around the selected branch. Fold hides them without changing saved positions. Copy gives the copied branch and its internal links new IDs. Detach preserves positions. Group membership carries objects when the group itself moves.
- `workspace.js` owns the command history. Text has a separate DOM editor so gestures and canvas redraws can leave input focus intact. View changes persist without creating undo steps. Dragging and sketching use a transient preview before committing.
- `geometry.js` feeds the DOM boxes, SVG connectors and Fit from one geometry and text wrapping pass. `export.js` uses that geometry to produce cropped standalone figures and scaled raster images. The Mac PDF renderer uses the same figure in an isolated WebKit view.
- The native shell supplies file pickers, save and recovery, Mac menus and the bundled offline WKWebView. It acknowledges a save only after the coordinated store writes it. A stale store rejects a replacement if the on-disk copy has changed.

## Legacy files

Import uses the unchanged 0.1.6 model to read legacy schema versions 1–4. It converts nodes into branch objects, preserves their content, order, positions, styles and links, and reports the old auto-zoom preference when present. The original file remains available for 0.1.6. The new editable export uses the prototype format.

## Verification

```sh
node --test prototype/tests/*.test.cjs
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

Chrome pointer checks cover port-to-port drags, reconnection, pinned and cancelled bends, drawing, splitting a stroke and restoring it with Undo. The geometry checks also cover parallel connections, orthogonal detours and junctions. A physical trackpad feel check belongs in release testing.

The 250-object Phase 1 fixture with 24 extra links opened and fit in Chrome. Across 24 drag events at 1440 × 900, the synchronous handler took a median of 7.3 ms and a maximum of 11.6 ms on this Mac. The measurement excludes browser paint and display time. This is enough evidence to continue with DOM text and SVG geometry and measure full frame timing as the canvas grows.

The everyday canvas check used Fit, Find and Fit selection on the same fixture and verified that cursor-centred zoom held its world position. Keep those navigation controls for now and revisit a minimap when a larger working board makes orientation difficult.
