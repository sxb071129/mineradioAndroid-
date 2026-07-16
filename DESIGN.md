# Mineradio Original Interface Adaptation

## Visual target

The web player follows the repository's original 1440 × 900 home/player state: a black particle starfield, centered 620 px search glass, top-right Home/Login controls, a two-column library workspace, six glass recommendation cards, and a 1120 px floating playback dock.

The source truth is `design-reference-original-controls.png`. The implementation preserves the original proportions and material while adapting overflow, touch targets, safe areas, and room controls for browsers and phones.

## Original tokens

- Canvas: `#000000`
- Panel ink: `#08090B` / `#0E1014`
- Primary text: `#F7F8FA`
- Muted text: white at 34–62%
- Sync accent: `#00F5D4`
- Deep blue: `#2442FF`
- Champagne accent: `#F4D28A`
- Frosted lyric accent: `#D6F8FF`

## Typography

- Display/body: `Noto Sans SC`, `PingFang SC`, `HarmonyOS Sans SC`, `Microsoft YaHei`, system UI.
- Data and micro-labels: `JetBrains Mono`, `SFMono-Regular`, `Consolas`.
- Large Chinese headings use an 840–900 optical weight and compact line height.

## Material and layout

- Search: 58 px high, 22 px radius, low-black glass, subtle inner white highlights.
- Home hero: 28 px radius, dense black glass, 28 px padding, large Chinese display title.
- Recommendation cards: two columns, 22 px radius, 108 px source-derived disc art.
- Player dock: fixed 16 px from the bottom, 1120 px maximum width, 50 px radius, three balanced control clusters.
- LAN room: a new drawer using the same black-glass material. It does not replace Login, Daily, or Song recommendation entries.

## Responsive rules

- Desktop stays within one viewport and intentionally lets the floating dock cover the lower edge, matching the original composition.
- Tablet preserves two columns until 760 px where the workspace becomes a single vertical stream.
- Phone uses a two-row dock, a full-width bottom room sheet, safe-area padding, and no horizontal overflow.
- Reduced-motion disables ambient drift; forced-colors replaces glass with system canvas surfaces.

## Assets

- `public/mineradio-starfield.png` is captured from the original rendered particle stage.
- Disc, wave, and tile assets are source captures from the original interface rather than CSS-drawn substitutes.
- Icons use Phosphor Icons for a consistent real icon family.

## Intentional deviations

- The new LAN room capsule sits between Home and Login.
- The quick-start rail includes LAN room actions while the original Login, Daily, and Song recommendation entries remain visible and separate.
- The mobile layout uses a compact two-row dock instead of the original three-row narrow-screen control stack.
