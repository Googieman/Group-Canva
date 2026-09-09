# Group Canvas visual system

The approved world is a friendly shared creative workspace, with the unobtrusive editing craft of Excalidraw and tldraw. The generous warm white drawing surface is the first thing to notice. Compact rounded tools sit beneath it. Color belongs to ink, small identity details, and actual people.

## Typography

Self-hosted Outfit regular and semibold, licensed under the SIL Open Font License in public/fonts/OFL.txt. A 24px compact wordmark, 24px empty-state invitation, 12–14px controls, and 10–12px secondary hints preserve space for the board. No external font request at runtime.

## Palette

Surround #f3f1eb; board #fffdf8; primary text #33343d; violet action #5446d4. Ink colors: violet #5446d4, dark ink #262832, rose #e05263, orange #df7733, sunflower #e2b534, green #298568, and blue #3487cb. Status has text as well as color. Avatars derive tinted backgrounds from server-provided user colors.

## Geometry and behavior

The drawing surface retains 16:9 and fits its container. Canvas and remote cursors occupy the exact same rectangle. Warm paper and dots are CSS behind the transparent canvas so erasing only removes ink. Controls stay outside the canvas. The toolbar is a single horizontal unit on desktop and two rows on narrow screens. Primary touch controls are 40px tall. Keyboard focus uses a 3px violet outline. Tool, swatch, and width states use aria-pressed.

Small radii: 8px board, 10px tool selection, 11px invite, 16px toolbar. The toolbar and people list use soft offset shadows. There are no decorative panels, fabricated drawing content, or fake participants.

## Assets

The overlapping square identity and compact first-mark vector composition are original editable SVG geometry. Higgsfield preflight found zero credits; image generation would require two credits per concept. No image was generated and no trial, purchase, or subscription was started. The application has no generated-image dependency.

## Motion and states

Only the transient feedback toast enters with a brief translation. Reduced-motion disables it. Connecting, connected, disconnected, and syncing states remain visible as text. Participant labels represent actual server presence; initial empty presence says Joining. Empty guidance disappears when the board has ink. Undo and redo are disabled according to authoritative availability.
