# TV Channels

Browse, switch, search, and manage satellite (DVB-S) and Samsung TV Plus (IPTV) channels with instant tuning, in-place renaming, slot-conserving move/sort, automatic gap closure, and backup export/import.

![TV Channels UI](https://github.com/user-attachments/assets/58724d9f-5029-4069-aac5-38d125a1fe3c)

## What it does

Adds a unified **Channels** tab to the Vetro dashboard:
- **Instant Direct Tuning:** Switches channels instantly (<100ms) via direct service ID (`tune_channel <srvId>`), with high-speed D-Bus key injection fallback. Never relies on slow single-digit entry delays.
- **In-Place Channel Renaming:** Click any channel name in Editor view to rename it directly. Automatically encodes UTF-16 hex and updates `SRV.srvName` and `modifiedByUser = 1`.
- **Channel Move & Reordering:** Move single or multiple channels to a new target slot. Implements a conservation displacement algorithm that preserves relative order without overwriting existing channels, complete with an interactive preview and validation dialog.
- **Automatic Gap Closure on Deletion (`1-X`):** Deleting channels (single or batch) automatically shifts subsequent channels to fill freed slots, guaranteeing a clean consecutive channel sequence from 1 to X without holes or missing numbers.
- **Instant Search, Filter & Multi-Mode Sorting:** Search across all channels by number, name, frequency, or transponder. Sort channels by number (#1-9 / #9-1) or alphabetically (A-Z / Z-A).
- **Source & Visibility Filters:** Quickly filter between All, 📡 Satellite, 📺 TV Plus, 🆓 FTA (Free to Air), and 🙈 Hidden channels.
- **Batch Selection & Sticky Toolbar:** Sticky controls panel keeps search and batch action buttons (`All`, `🙈 Hide`, `👁️ Unhide`, `🗑️ Delete`, `🔄 Move`) visible while scrolling. The combined `All` toggle features a dynamic selection counter badge and native indeterminate state.
- **Add Channels Manually:** Add custom satellite channels directly to the TV tuner with transponder auto-detection: entering frequency and polarization automatically detects broadcast channels on that frequency, auto-filling the Service ID (SID) and Video PID, or alerting with clear guidance for new transponders.
- **Export & Import Backups:** Export official Samsung-compatible `Channel_list_<Model>.zip` archives directly to your PC, phone, or tablet (compatible with Samsung USB restore and PC editors like ChanSort). Import any channel backup ZIP directly through the browser without USB drives, bypassing country and model mismatch restrictions.
- **TV Remote Controls & Sticky Reload:** Convenient sticky header controls for Volume (`Vol+`, `Vol-` with click-and-hold continuous auto-repeat) and Channel switching (`CH+`, `CH-`), displaying full labels on wide screens and space-saving icons on mobile. In Editor Mode, a sticky `🔄 Reload TV` button dynamically appears beside the search box when scrolling down.
- **TV Mode Input Switcher:** One-click `📺 TV Mode` button to immediately switch the TV from any app or HDMI input to live broadcast TV.
- **Mobile & Dense Viewports:** Fully responsive design with auto-hiding stats badges on mobile screens, compact buttons, and touch-optimized infinite scrolling.

## Permissions

`exec` — to query and update channel records in `/mnt/systemrw/tvs-chms/data/`, tune channels via `/usr/bin/launch_app` and D-Bus, send remote key events via `/usr/bin/input_keyevent`, switch input source via `/usr/bin/launch_app`, and reload channel daemons via `pkill -9 tvs-daemon`.

## Commands it runs

| Command | Why |
| --- | --- |
| `/usr/bin/launch_app org.tizen.tv-viewer tune_channel <srvId>` | Instant direct channel switching via native TV service ID without digit delay |
| `dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:<0\|1> string:<key>` | High-speed fallback key injection for tuning by channel number or returning to TV mode |
| `/usr/bin/input_keyevent <keysym>` | Dispatches remote key events (`XF86AudioRaiseVolume`, `XF86AudioLowerVolume`, `XF86RaiseChannel`, `XF86LowerChannel`, `XF86Exit`) |
| `/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user` | Switches the TV source directly to Live Broadcast TV (DVB-S/Tizen TV Viewer) from any app or HDMI input |
| `/usr/bin/input_keyevent XF86Exit` | Exits any active foreground application when switching to TV Mode |
| `sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "ATTACH ...; SELECT ..."` | Queries satellite channel numbers, decoded UTF-16 names, frequencies, polarization, symbol rates, and satellites |
| `sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "SELECT ..."` | Queries Samsung TV Plus (IPTV) channels |
| `sqlite3 <dbPath> "UPDATE SRV SET ...; PRAGMA wal_checkpoint(TRUNCATE);"` | Updates channel visibility flags (`hidden`, `hideGuide`, `numSel`, `elim`), names, or positions |
| `sqlite3 <dbPath> < /tmp/ch_del_*.sql` | Executes atomic batch channel deletion and `1-X` sequential renumbering |
| `sqlite3 /mnt/systemrw/tvs-chms/data/sat "INSERT ..."; sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "INSERT ..."` | Registers transponder and channel service records when manually adding a satellite channel |
| `/usr/bin/zip -j /tmp/Channel_list_<Model>.zip ...` | Packages channel databases into an official Samsung TV USB and ChanSort compatible zip archive for export |
| `/usr/bin/unzip -o -q /tmp/... -d /tmp/...` | Extracts uploaded channel list zip archives for validation and import |
| `pkill -9 tvs-daemon` | Terminates `tvs-daemon` when the user clicks **Reload TV** or imports a backup so it auto-restarts and re-reads the modified database without interrupting active playback during normal edits |

## Network

None. All queries and commands execute locally on the TV.

## Data it keeps

None. The plugin reads and modifies the TV's native channel databases directly.
