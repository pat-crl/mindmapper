# Mind Mapper 0.2.0 installed audit

24 November 2026 · Build 5 · Apple silicon · macOS 27.2.1

The installed app passed Gatekeeper. The audit used isolated scratch boards and the installed WebKit assets.

## Verified checks

- All 81 model tests and the native regression suite passed. Normal-scale layout worked in light and dark from 560 × 430 to 1536 × 900 points. Find, F2 editing, pointer drawing, partial erasing and Undo worked in the native UI.
- A network-denied native WebKit harness imported a copy of a 0.1.6 library with all 18 nodes, 17 branches, text and stored positions intact. The saved workspace reopened byte-for-byte.
- The connector label stayed clear in SVG, PDF and PNG. LibreOffice Writer preserved SVG vector paths at 3 and 6 inches. Its SVG import omitted Japanese glyphs, while the native PDF kept them as selectable text.
- A 165-second native run on the 250-object fixture with 24 links and 237 branches completed 453 edit and undo cycles, 906 acknowledged saves, 23 SVG exports and 13 byte-identical reopen checks. Drag processing was 13 ms median and 16 ms p95 before paint. Median save acknowledgement was 24 ms and SVG save was 252 ms with the destination preselected. The host process used 86.5–99.0 MiB of sampled RSS, excluding WebKit subprocesses. A separate 60-edit run retained 32 undo steps under the 8 MiB cap and redid all 32.

## Follow-up

- [ ] **W-001 High priority. Keep keyboard focus visible.** At 400%, Option–Tab focused offscreen objects and scrolled the hidden viewport independently of the canvas. Find could then focus a result that stayed offscreen. Use one canvas position for focus, Find and Fit, and verify the result stays visible after keyboard traversal.
- [ ] **W-002 High priority. Reflow controls with enlarged text.** In a 560 × 430 point window, overflow began at 150% WebKit page zoom. Export clipped and the canvas controls overlapped at 175–200%. Keep editing and export controls reachable at 200%.
- [ ] **W-003. Add keyboard placement.** Enter activates Shape, but Enter on the focused populated canvas places nothing. Verify that a keyboard placement action creates and focuses a shape and supports Undo.
- [ ] **W-004. Add object browsing.** Empty Find has no browseable results. Provide a list or outline that reveals and focuses the selected item, including folded objects where applicable.
- [ ] **W-005. Increase pointer hit areas.** Resize handles measured 9 × 9 CSS px, connector ports 13 × 13 and the Shape options caret 16 × 31. Verify adjacent controls remain distinct on dense boards and at low canvas zoom.

Physical trackpad gestures, VoiceOver speech, macOS system text sizing, the preferred document app, and macOS 14.5 and Intel runtime checks are open. The performance run measured editor work before paint. Longer real-board sessions, physical input timing and WebKit subprocess memory still need measurement.
