# Mineradio Modification Notes

This project is a modified version of the original open-source project
`XxHuberrr/Mineradio`. The original project is released under the GPL-3.0
license. This modified version keeps the original license and copyright notices.

## Copyright And License

- The original `LICENSE`, `README.md`, and attribution information should be kept.
- This repository should be published as a modified version based on
  `XxHuberrr/Mineradio`.
- This modification does not include DRM bypassing, paid-feature cracking, or
  copyright circumvention.
- The project is intended for learning, research, UI customization, and feature
  extension.

## Main Changes

1. Added Kugou Music account session support.
   - Added Kugou cookie/session storage.
   - Added Kugou QR login helpers.
   - Added Kugou login status, cookie import, and logout routes.
   - Added `/api/kugou/user/playlists` for user playlist synchronization.
   - Added `/api/kugou/playlist/tracks` for playlist track loading.
   - Added `/api/kugou/song/url` for resolving playable song URLs when possible.
   - Added `/api/kugou/lyric` for Kugou lyric loading.

2. Added Kugou Music as a third source in the player UI.
   - Added Kugou login tab and account switching entry.
   - Added Kugou playlist group in the playlist panel.
   - Added `KG` source tags for Kugou songs.
   - Added Kugou playlist loading and queue playback support.
   - Added Kugou account, VIP status, playlist order, lyric, and quality handling.

3. Improved login and player UI.
   - Unified Netease, QQ Music, and Kugou login entry states.
   - Shows an account card and logout action when a platform is already logged in.
   - Improved the QQ Music login entry so it clearly appears as a QR-style login action.
   - Replaced the temporary home placeholder with a polished player start panel.
   - Polished the playlist panel and reduced bottom control bar glare.

## Important Notes

Kugou Music does not provide a stable public API for all personal music data.
This modification uses the saved login session and compatible web/mobile
endpoints when possible. If Kugou changes its service behavior, some playlists
may fail to load or some songs may not be playable.

Please do not use this project to infringe music platform copyrights or bypass
paid access restrictions.

## Web Adaptation Addendum

Beginning on 2026-07-13, this repository also contains an unofficial responsive
web adaptation with a separate LAN synchronization relay and restricted local
music adapter. The original copyright, GPL-3.0 license, attribution, design
notice, and acknowledgements above remain unchanged. Additional details are in
`ATTRIBUTION.md`.

The LAN adaptation later added bounded per-device application-volume and output
delay calibration, synchronized start barriers with adaptive buffering, local
room QR generation, system Media Session controls, and an optional dual-audio
prefetch/crossfade path in the separate `/modern` interface. These additions do
not alter music-platform entitlements, bypass paid access, or remove any
original author or copyright notice.

## Compatible Mineradio 2.0.3 player enhancements

On 2026-07-30 this web adaptation reviewed the player-side changes in
`XxHuberrr/Mineradio` release `v2.0.3`
(`7974c52270c628d7ddb7427eaa0269e024cc0d3f`) and incorporated compatible
front-end behavior without replacing the LAN bridge:

- A clean-room Canvas audio-reactive Sonic Terrain preset with DIY theme,
  intensity, and spectrum-response controls.
- Corrected 3D playlist-shelf foreground ordering and removal of the obsolete
  floor-reflection allocation.
- A bounded solo-playback recovery layer: 20 seconds per recovery transaction,
  at most two automatic queue advances, stale-token invalidation, and a strict
  room-mode bypass.

The upstream desktop/server code, account-cookie workflows, non-official
platform adapters, DRM/decryption routines, external visual assets, and
cross-provider URL construction were deliberately not imported. This retains
the project GPL-3.0 obligations and the original author, design, and copyright
notices while keeping room synchronization authoritative.

### LAN start and recovery hardening

The same 2026-07-30 update also hardens the web-only relay integration:

- A song selected while the local Relay is still joining is preloaded without
  audible playback. Once the device becomes the room leader, it enters the
  normal buffer/readiness barrier and starts at the shared server time.
- Delayed leader announcements now carry a serial, room-connection generation,
  and track descriptor guard. Rapid song changes or reconnects cannot send an
  old seek/play pair into a newer preparation barrier.
- Solo HOME playback retains the bounded fallback; when more than one device
  participates (or a room barrier is active), automatic local replacement and
  queue advance are disabled.
- Relay calibration is normalized to the UI's 0.5 dB / 5 ms increments, and
  completed preparation IDs and temporary buffer diagnostics are cleared after
  their short post-start retention window.
- Cache version parameters were advanced for the Classic bridge and recovery
  layer so browsers cannot combine the new room rules with stale script files.
