# Mind Mapper Mac workspace

Open `workspace-preview.html` to compare a populated board with a genuinely blank board. Use the preview controls to switch appearance, window width and save state. The board uses fictional studio routing and recording notes. `icon-concepts.html` shows the three icon studies at 128, 32 and 16 pixels.

The preview exercises selection, tools, panels and feedback states. It represents the proposed workspace before the document model, editing and native export are built.

## Modern Journal reference

The reference is the installed native Journal 0.2.8, build 10. Its unified toolbar, light sidebar, native text background and system type are the starting points. The native shell uses 13 pt sidebar labels, a 270 pt ideal sidebar and a 1180 × 800 default window. Its compact macOS controls and quiet separators translate well to a canvas.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#FFFFFF` | `#1E1E1E` |
| Library and Inspector | `#F5F5F7` | `#29292D` |
| Primary text | `#242426` | `#E8E8ED` |
| Secondary text | `#626268` | `#A8A8AF` |
| Separator | `#DEDEE4` | `#48484E` |
| Action and focus | `#005FC4` | `#82B9FF` |
| Selected surface | `#E6F1FF` | `#28476B` |

The canvas and panel values come from Journal's modern appearance. The secondary text, action and border colours are adjusted for the whiteboard's small labels and thin controls. Use the macOS system sans across the window and diagram. Start with 13 pt object labels, 11–12 pt secondary labels, 32 pt controls and 1–1.5 pt outlines. Colour is optional on objects, with blue reserved for action or selection by default.

Reference evidence came from the installed Journal bundle, the recovered SwiftUI shell and AppKit light and dark colour sampling. The relevant installed editor asset is `/Applications/journal.app/Contents/Resources/Web/assets/native-D5jZgAV2.js`.

## Window and tools

- Put the Boards toggle, board title and save state in the title bar. Keep Inspector, Focus and Export available when the panels are closed.
- Float one strip over the canvas for Select, Text, Shape, Branch, Connect and Draw. Use the Select tool by default and provide a real description for each icon when its label is hidden.
- Give the blank board **Add text** and **Start a mind map**. The first action creates a loose text object. The second creates a branch root. Escape returns either workflow to selection.
- Dock the Boards sidebar and Inspector at wide sizes. In a compact window, open one drawer at a time. Closing a drawer restores focus to the control that opened it. Keep the canvas visible as the main surface.
- Keep zoom, Fit and the optional grid near the lower corners. In the real editor, Fit uses board or selection bounds including connectors. Pan and zoom work when panels are hidden in Focus mode.
- Show properties for the selected object in the Inspector. Use shared properties for a multi-selection. For a selected connector, show route, arrowheads, label and style. Keep direct object text editing on the canvas.
- Open export with the scope and format in one place. Start with Board, Selection or Frame, then show SVG, PDF, PNG and JPEG as available for that build. Preview any change to bounds, padding or background.

The proposed icon is **Branch**. Its hierarchy survives at 16 px, where Loop and Route lose some separation. Pick the mark before producing macOS icon assets.

## Mac input

| Context | Gesture or key | Result |
| --- | --- | --- |
| Canvas | Click, Shift-click or drag on empty space | Select, add to the selection or marquee-select |
| Selected object | Double-click or F2 | Edit the text |
| Canvas selection | Arrow keys or Shift-arrow keys | Nudge by one or a larger step |
| Branch text | Tab, Return or Shift-Tab | Add a child, add a sibling or return to the parent |
| Branch text | Shift-Return or Command-Return | Insert a line break or add a parent |
| Plain text and Inspector | Tab and Return | Follow native focus and text editing conventions |
| Canvas | Space-drag, two-finger scroll or pinch | Pan or zoom around the pointer |
| Shape or branch | Drag a visible port or choose **Connect to** | Preview a link and choose its destination |
| Anywhere | Command-Z, Shift-Command-Z or Command-F | Undo, redo or find |

Scope branch shortcuts to branch text. Escape cancels a drag or connection first, exits text editing second and dismisses the active panel after that. Keep the 0.1.6 branch flow fast. A dedicated branch action changes hierarchy. A free connector can make a cross-link or feedback loop between any eligible objects.

## Feedback and recovery

| State | Treatment |
| --- | --- |
| Hover and focus | Use modest hover fill. Draw a separate high-contrast keyboard focus ring outside the object or control. |
| Selected | Use a stronger outline and visible handles or ports. Keep that outline visible against custom fills. |
| Dragging | Show a temporary outline, snap guides and the resulting position. Escape leaves the last saved position in place. |
| Connecting | Show a preview line and outline the eligible destination port. Label invalid targets in the keyboard picker. Escape or release on open space cancels. |
| Locked | Show a lock indicator and disable move and resize affordances. Keep selection, inspection and explicit unlock available. |
| Long labels | Wrap at a sensible width and grow the object vertically. Keep full text available through editing and inspection. |
| Save feedback | Show Saving, Saved or Couldn’t save in the title bar. For a save failure, keep the draft open and show Try again. For a file conflict, offer Save a copy. |
| Recovery | Show the backup time and offer Open a copy. Preserve the current board while the copy is reviewed. |

Real build acceptance will include keyboard access to connections through a destination picker and an object outline, screen-reader labels for nodes and edges, and selection cues that still make sense in greyscale.

## Review before Phase 3

Compare the blank and populated boards in light and dark appearance. Toggle Boards and Inspector at compact width and check that the canvas remains the main focus. Use the Phase 1 brainstorm, decision flow and signal flow to judge whether this one workspace supports all three. Check the icon at 16 and 32 px before selecting it.

The next phase can start from the window structure, colour roles and interaction map here. It still needs to prove the blank document, reliable keyboard focus, mixed board geometry and the shared editor with existing files.
