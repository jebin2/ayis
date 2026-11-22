## Two kinds of machine

A GPU machine rented from AWS by the hour, or a Linux server of your own reached
over SSH - added from Home, set up and removed each in one dialog. Disconnecting
AWS deletes everything ayis made there, in every region, so nothing is left billing.

## Self-contained

`ayis` travels with the app - one program, with the box-side scripts and the Lambda
built into it, inside the download, so it runs without a checkout. The app still
holds no AWS logic of its own: it runs `ayis`, and `ayis` is the only thing that
decides anything.

Settings are written to `~/.config/ayis/.env`, not next to the app, because an
installed copy is read-only. A checkout keeps using its own `.env` as before, and
a checkout beside the app wins over the bundled copy - so running from source
shows your edits.

## Which file

| | |
|---|---|
| `.pacman` | Arch, CachyOS, Omarchy - `sudo pacman -U <file>` |
| `.deb` | Debian, Ubuntu, Mint - `sudo dpkg -i <file>` |
| `.tar.gz` | anything else - extract it and run `ayis` inside |
| `.AppImage` | one file, but it needs FUSE 2 on the machine |
| `-mac-x64.dmg` / `-mac-arm64.dmg` | macOS - Intel, or Apple Silicon (M1 and later) |
| `-win-portable.exe` | Windows - one file, no installer, run it from anywhere |

The AppImage is listed last on purpose. AppImage type-2 needs `libfuse.so.2`, which
distributions have largely moved past - on Arch that means `pacman -S fuse2` first,
or running it as `./ayis-*-linux-*.AppImage --appimage-extract-and-run`. The `.tar.gz` needs
nothing at all.

## Checking what you downloaded

Every file is listed in `SHA256SUMS` (`sha256sum -c --ignore-missing SHA256SUMS`), and each has
a build provenance attestation: `gh attestation verify <file> --repo jebin2/ayis` proves it was
built by this repository's release workflow.

## Before it can play

Everything is asked when you add a machine. A server of your own needs an SSH
login and Tailscale on this computer; AWS also needs an AWS account and a
Tailscale auth key. From a terminal:

    ./ayis check --fix

## macOS and Windows: what has been tried

`ayis` itself has been run through a whole cycle on a real Mac (Intel) and a real
Windows PC: build the machine, check it, save the library, play, delete it, delete
everything, and nothing left billing. These two downloads are the desktop app
around it, and the app on those systems has been built but not yet used by a person
on them - treat them as a first try, and say what breaks.

- **Not signed.** macOS will say the app is from an unidentified developer: open it
  with right-click > Open, or run `xattr -cr /Applications/ayis.app` once.
  Windows SmartScreen will say the same: More info > Run anyway.
- **Moonlight is not bundled.** Install it (the stream itself); the app finds it in
  its usual place. `ayis check --fix` can install it with `brew` or `winget`.
- **Stop is abrupt on Windows.** There is no Ctrl+C to send, so Stop ends `ayis` where
  it stands; run the same command again to carry on.

From source on any platform: `cd app && npm install && npm start`.
