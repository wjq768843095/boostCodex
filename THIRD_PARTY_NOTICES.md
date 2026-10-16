# Third-party notices

boostCodex is a modified derivative of [Better Codex v0.4.18](https://github.com/Ericwong5021/better-codex/tree/v0.4.18). The original packaged runtime was imported into this repository in commit `d8685d00ce8bcb4aae75d3864916ad4b40398330` and subsequently modified and reduced. See [NOTICE](NOTICE) for the project-wide modification notice and [LICENSE](LICENSE) for the complete Apache-2.0 license.

The root license was copied without alteration from the [upstream v0.4.18 license](https://raw.githubusercontent.com/Ericwong5021/better-codex/v0.4.18/LICENSE). The notices below cover both the current files and bundled third-party code retained in the development history; inclusion here does not mean that every listed dependency is still used by the current runtime.

## Current inherited assets

- `src/backend/assets/AppIcon.ico` and `AppIcon.icns` were extracted from the packaged Better Codex baseline. They match the baseline's embedded images byte for byte. Their origin is attributed to that upstream distribution; no new copyright owner or separate artwork license is asserted here. This attribution does not grant trademark rights.
- `src/backend/assets/icons.json` contains Lucide `zap`, `settings`, `grip-vertical` and `list-checks` icon definitions. `src/ui/assets/disclosure-play.svg` contains Lucide `play`. The complete [Lucide license](licenses/lucide-static-1.28.0-LICENSE) includes the ISC notice for Lucide and the MIT notice for its listed Feather-derived icons, including `settings` and `play`.

## Bundled dependencies in the development history

The initial runtime's `node_modules/` source markers identify the following eight packages. A scan of the historical JavaScript/CJS blobs found no other package source markers. Versions are taken from the [upstream v0.4.18 package lock](https://github.com/Ericwong5021/better-codex/blob/v0.4.18/package-lock.json); the initial bundle also explicitly labels markdown-it 15.0.0 and lucide-static 1.28.0. The imported packaged baseline did not include its own dependency lockfile, so the upstream lock is the version reference for the remaining entries.

| Package | Version reference | License and preserved notices | Complete license |
| --- | --- | --- | --- |
| entities | 8.0.0 | BSD-2-Clause; Felix Böhm | [License](licenses/entities-8.0.0-LICENSE) |
| linkify-it | 6.1.0 | MIT; Vitaly Puzrin | [License](licenses/linkify-it-6.1.0-LICENSE) |
| lucide-static | 1.28.0 | ISC; Lucide Icons and Contributors. Listed Feather-derived icons: MIT; Cole Bemis | [License](licenses/lucide-static-1.28.0-LICENSE) |
| markdown-it | 15.0.0 | MIT; Vitaly Puzrin and Alex Kocharin | [License](licenses/markdown-it-15.0.0-LICENSE) |
| mdurl | 2.1.0 | MIT; Vitaly Puzrin and Alex Kocharin. Includes the MIT notice for Joyent/Node-derived URL parsing code | [License](licenses/mdurl-2.1.0-LICENSE) |
| punycode.js | 2.3.1 | MIT; Mathias Bynens | [License](licenses/punycode.js-2.3.1-LICENSE) |
| uc.micro | 3.0.0 | MIT; Mathias Bynens, as stated in the package's license | [License](licenses/uc.micro-3.0.0-LICENSE) |
| ws | 8.21.0 | MIT; Einar Otto Stangvik, Arnout Kazemier and contributors, Luigi Pinca and contributors | [License](licenses/ws-8.21.0-LICENSE) |

The individual license files preserve the complete upstream copyright, permission, redistribution and disclaimer text. The license files, rather than the summaries in this table, state the applicable terms.

## License source records

Retrieved on 2026-10-16 from the official upstream repositories. For packages that publish a `gitHead`, the source is pinned to that commit from the version's npm metadata. Lucide is pinned to its 1.28.0 release tag.

| Local license file | Official source |
| --- | --- |
| `LICENSE` | [Better Codex v0.4.18](https://raw.githubusercontent.com/Ericwong5021/better-codex/v0.4.18/LICENSE) |
| `licenses/entities-8.0.0-LICENSE` | [fb55/entities, 2322ee76](https://raw.githubusercontent.com/fb55/entities/2322ee76c431b990facb259b61b9ff4eb89ef3c9/LICENSE) |
| `licenses/linkify-it-6.1.0-LICENSE` | [markdown-it/linkify-it, 7c568a12](https://raw.githubusercontent.com/markdown-it/linkify-it/7c568a123a17727fa2f34a0abcabbd46437299c1/LICENSE) |
| `licenses/lucide-static-1.28.0-LICENSE` | [lucide-icons/lucide, 1.28.0](https://raw.githubusercontent.com/lucide-icons/lucide/1.28.0/LICENSE) |
| `licenses/markdown-it-15.0.0-LICENSE` | [markdown-it/markdown-it, 157b33bc](https://raw.githubusercontent.com/markdown-it/markdown-it/157b33bc13649aebecf9ab9b3b8c85ae645abb5a/LICENSE) |
| `licenses/mdurl-2.1.0-LICENSE` | [markdown-it/mdurl, dd913f62](https://raw.githubusercontent.com/markdown-it/mdurl/dd913f6290a4d8772240a401aab993eb65c5786d/LICENSE) |
| `licenses/punycode.js-2.3.1-LICENSE` | [mathiasbynens/punycode.js, 9e1b2cda](https://raw.githubusercontent.com/mathiasbynens/punycode.js/9e1b2cda98d215d3a73fcbfe93c62e021f4ba768/LICENSE-MIT.txt) |
| `licenses/uc.micro-3.0.0-LICENSE` | [markdown-it/uc.micro, c740a5da](https://raw.githubusercontent.com/markdown-it/uc.micro/c740a5dadc1090203cb21e6f28bf215ad9ddec28/LICENSE.txt) |
| `licenses/ws-8.21.0-LICENSE` | [websockets/ws, bca91adf](https://raw.githubusercontent.com/websockets/ws/bca91adf15677e47dbe4f959653452727be28b94/LICENSE) |

When redistributing historical snapshots separately, carry the applicable license and attribution files with those snapshots as well. Review and update these records when adding or changing third-party material.
