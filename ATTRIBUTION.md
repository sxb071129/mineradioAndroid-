# Attribution and modification notice

MR//ROOM is an unofficial web adaptation of [Mineradio-Kugou-Modified](https://github.com/zws84952324-create/Mineradio-Kugou-Modified), itself based on [Mineradio](https://github.com/XxHuberrr/Mineradio) by XxHuberrr. This web source replaces the application files in [sxb071129/mineradioweb](https://github.com/sxb071129/mineradioweb) while retaining that repository's history and original legal notices.

## Original author and copyright

Copyright (C) 2026 XxHuberrr.

Mineradio was principally designed and created by XxHuberrr. Emily is credited as a co-creator and inspiration for the early visual foundation and the `emily` visual preset direction. The original repository also thanks 小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦 for early testing, feedback, and release preparation.

The Mineradio name, MR Logo, interface visual design, startup-animation direction, particle experience, cinematic camera system, and other original visual expression remain the property of their respective author. This repository is an unofficial modified version and does not represent an official release by the original author.

## License and retained notices

- Upstream license: GNU General Public License v3.0.
- The complete license is retained in [LICENSE](./LICENSE).
- The original design and third-party notice is retained in [NOTICE.md](./NOTICE.md).
- The original Kugou modification history is retained in [MODIFICATIONS.md](./MODIFICATIONS.md).
- The original author support page and supplied poster are retained under [docs/SUPPORT.md](./docs/SUPPORT.md).

## Web adaptation

- Web adaptation created on 2026-07-13.
- The implementation replaces the Electron/Node monolith with a vinext/React website, a separate LAN relay, and a restricted local music adapter.
- The local adapter uses the open-source [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) package and a restricted Kugou protocol adapter based on the upstream GPL implementation; it is not an official API or endorsement from either platform.
- Original visual resources required by the retained classic interface, together with the author support material already present in `sxb071129/mineradioweb`, remain bundled with their attribution. No upstream account Cookie, token, third-party album content, or platform authorization is bundled.
- The target repository's historical notes record that the splash animation was inspired by and partially adapted from `ShipSwiftAnimatedLoop`, including its highlighted line-field, RGB channel offset, angular wobble, and warp-distance-field ideas. The target repository did not record a source URL or license for that reference; this provenance note is retained so downstream distributors can verify it before further reuse.
- User-generated login credentials remain in the operating system's local application-state directory (for example `%LOCALAPPDATA%\Mineradio\accounts` on Windows), outside the project. Users are responsible for music-platform terms and for playing or sharing only audio they have the right to use.

The source of this adaptation is distributed under GPL-3.0. Third-party libraries, services, names, and marks remain subject to their respective licenses, terms, and owners.
