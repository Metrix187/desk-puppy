# Desk Puppy

A pixel puppy on a small ESP32 display that reacts to your live pulse and breathing.

Your PC's webcam watches you (after you say yes). The [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs/nodejs) estimates your pulse and breathing from the video, and a small Node program passes four numbers over USB to the display. The puppy does the rest:

- its tail wags once per heartbeat
- its chest rises and falls with your real breathing trace
- it dozes off when your breathing is slow and your pulse is at its usual level
- it gets the zoomies when your pulse is well above your usual level
- it paws at the glass when you hold your breath
- it looks around for you when you leave

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).

**Desk Puppy is a toy.** It is not a medical device. It does not diagnose, treat or monitor anything, and its numbers should not be used for any health decision. Presage's own wording applies: SDK metrics are offered for general wellness and informational purposes only, have not been cleared by the FDA, and may not be used for medical diagnosis or treatment.

## How it fits together

```
webcam ──> SmartSpectra SDK ──> bridge (Node) ──USB serial──> ESP32 "Cheap Yellow Display"
           pulse, breathing     hold detector                 draws the puppy
           rate, chest trace    mood logic
```

| Folder | What is in it |
| --- | --- |
| `firmware/` | PlatformIO project for the display board. Draws the puppy and parses the serial protocol. |
| `bridge/` | Node program for the PC. Talks to the SDK, decides the puppy's mood, sends it to the board. |
| `docs/` | Draft of the DEV post. |

## Parts

- An ESP32-2432S028R "Cheap Yellow Display" (CYD): ESP32 with a 320x240 ILI9341 screen and a CH340 USB port.
- A USB data cable.
- A PC with a webcam. Developed on Windows 11 with Node 24. The SDK also lists macOS (Apple Silicon) and Linux (x64, arm64) as supported, but I have only run this on Windows.
- A SmartSpectra API key from [physiology.presagetech.com](https://physiology.presagetech.com/auth/login) (not needed for fake mode).

## Flashing the board

The firmware pins `platform = espressif32@6.9.0` (Arduino core 2.x), which TFT_eSPI builds against without trouble.

If you already have a working PlatformIO, this is all you need:

```bash
pio run -d firmware -t upload
```

I use a separate PlatformIO install inside the project folder so that it cannot disturb, or be disturbed by, a global one. In PowerShell, from the repository root:

```powershell
py -3 -m venv .tools\venv
.tools\venv\Scripts\pip install platformio
$env:PLATFORMIO_CORE_DIR = "$PWD\.tools\pio-core"
.tools\venv\Scripts\pio run -d firmware -t upload --upload-port COM5
```

Replace `COM5` with your board's port. Set `PLATFORMIO_CORE_DIR` in every new terminal before running `pio`. The first build downloads the toolchain and takes a few minutes.

If you care about what is currently on the board, back it up first (this reads the whole 4 MB flash and takes about two minutes):

```powershell
.tools\venv\Scripts\python .tools\pio-core\packages\tool-esptoolpy\esptool.py --chip esp32 --port COM5 --baud 460800 read_flash 0 0x400000 backup\cyd-backup.bin
```

After flashing, the screen shows the puppy looking around and the words "waiting for PC".

**Colours look wrong?** Some CYD boards ship with a panel that needs colour inversion. If the background is pale instead of dark navy, run `npm run invert` in `bridge/`. The board remembers the setting.

## Running the bridge

```bash
cd bridge
npm install
```

`npm install` downloads the SDK's native runtime for every platform it supports, a few hundred MB.

### Try it without a camera first

```bash
npm run fake
```

Fake mode needs no camera and no API key. It replays a scripted 80 second loop (calm, held breath, excited, sleepy) through the same hold detector and mood logic the live mode uses, so you can see every animation. The numbers are invented and the terminal says so.

No board either? This prints what would be sent:

```bash
npm run fake -- --dry-run
```

### Live mode

1. Put your API key in `bridge/.env`. Copy `.env.example` to `.env` and fill it in, or on Windows run `npm run set-key`, which asks for the key in a masked dialog and writes the file for you. `.env` is gitignored.
2. Start it:

```bash
npm start
```

The program prints what the camera is used for and what leaves your machine, and waits for you to type `yes`. Until you do, the camera stays off. Then sit facing the camera in decent light, about an arm's length away. The chest trace starts within a few seconds; pulse and breathing rates take longer to settle. Press Ctrl+C to stop, which also releases the camera.

Useful options (after `--`, for example `npm start -- --port COM7`):

| Option | What it does |
| --- | --- |
| `--port <name>` | Use this serial port instead of searching for the board |
| `--camera <n>` | Use the nth camera from `--list-cameras` |
| `--list-cameras` | List cameras without opening any |
| `--list-ports` | List serial ports |
| `--loose` | Also use readings the SDK has not marked as stable |
| `--debug` | Print every line sent to the board |
| `--dry-run` | Run without a board |

### Tests

```bash
npm test
```

The breath-hold detector, the mood logic, the protocol formatting and the fake script are unit-tested with Node's built-in test runner.

## How the puppy decides

The SDK gives the bridge a pulse rate, a breathing rate and a chest movement trace. Everything else is a few lines of ordinary code in `bridge/src/`.

| Mood | When |
| --- | --- |
| searching | nobody is tracked, or the signal is not usable |
| breath held | the chest trace has been nearly flat for about 8 seconds while you are still tracked |
| excited | pulse more than 15 bpm above your session baseline |
| sleepy | breathing under 10 breaths a minute and pulse within 8 bpm of your baseline |
| awake | everything else |

- **Session baseline** is the median of your pulse over the first 30 seconds, after which it drifts slowly while the puppy is calm. It is "your usual for this sitting", nothing more.
- **Breath hold.** The SDK lists an apnea metric but marks it unavailable, so the bridge has its own detector. It learns how far your chest trace normally swings and calls it a hold when the last 8 seconds swing less than a quarter of that. It ends as soon as you breathe again.
- **No flicker.** Thresholds are wider for leaving a mood than for entering it, and a new mood has to persist for a couple of seconds before the puppy switches.

These rules drive a cartoon. They are not measurements of sleepiness, excitement or anything else about you.

## Serial protocol

115200 baud, PC to board, about ten lines a second:

```
V,<pulse bpm>,<breaths per min>,<state>,<chest -100..100>\n
```

Any field may be `x` when unknown. States: 0 searching, 1 awake, 2 sleepy, 3 breath held, 4 excited.

- `?` makes the board answer `PUPPY 1`. The bridge uses this to find the right port.
- `I` toggles colour inversion.
- If no line arrives for 4 seconds, the board shows "waiting for PC".

You can drive the puppy from anything that can write to a serial port.

## Consent and data handling

This section is meant to match Presage's [SDK Telemetry & Privacy](https://smartspectra.presagetech.com/docs/telemetry-and-privacy) page and the SmartSpectra docs as of SDK 3.5.0. Where I am relying on Presage's documentation rather than something I can check myself, I say so.

**Consent.** In live mode the program prints a plain-language notice and opens the camera only after you type `yes`. Anything else, including Ctrl+C, quits with the camera untouched. There is no flag to skip the prompt. Use it on yourself, or on someone who is present, has read the notice and has agreed. It is not for watching anyone who does not know about it.

**Video.** Frames go from the camera directly into the SDK, which runs inside the bridge process on your computer. The bridge never displays, saves or uploads video. Presage's documentation states that all metric computation happens on-device and that the backend is contacted only to authenticate the API key and validate the subscription.

**What leaves your computer.**

- The SDK contacts Presage's servers to check the API key and subscription. It will not run without that, and the bridge cannot turn it off. Those requests are authenticated, so they can be associated with the Presage account that owns the key. This is not anonymous.
- SDK telemetry is switched off (`enableTelemetry: false`). Presage says that when it is disabled the SDK starts no telemetry session and transmits nothing for it. Left on (the SDK default), telemetry would send session summaries: SDK and OS details, device model, performance and frame-rate statistics, counts of validation states and error codes. Presage says telemetry never includes video frames or measured values.
- The bridge does not use the SDK's optional LLM Insights feature or device readiness reports, both of which send additional data to Presage.
- The bridge has no network code of its own. Its only other output is the USB serial link.

The SDK's native runtime is closed source, so the statements about what it transmits are Presage's, not something I have independently verified. Presage's [privacy policy](https://api.physiology.presagetech.com/privacypolicy) is the authority on what they do with data that reaches them, and it is written more broadly than the SDK documentation; read it if this matters to you.

**What goes to the display.** Over USB, about ten times a second: pulse rate, breathing rate, the mood number and a chest position between -100 and 100. The board draws them and keeps nothing. The only thing it stores is the colour inversion setting.

**Storage and retention.** The bridge writes nothing to disk: no video, no measurements, no logs. Values live in memory and on the terminal until you press Ctrl+C. There is nothing to delete afterwards, because nothing was kept.

**The API key.** Read from `SMARTSPECTRA_API_KEY` in `bridge/.env` or the environment. It is never printed, and it is scrubbed from any SDK message before that message is shown.

**Fake mode** uses no camera, no key and no network.

## Troubleshooting

- **"Could not find the Desk Puppy board".** Close any serial monitor that is holding the port, check the cable carries data, or name the port with `--port`.
- **Puppy stays in "sniffing for you".** The SDK is not getting a usable view. The terminal shows its hint (too dark, face not centred, too far, and so on).
- **Pulse or breathing shows `--`.** By default only readings the SDK marks as stable are shown. Give it half a minute of sitting still in good light, or try `--loose`.
- **`kAuthenticationFailed`.** Check the key in `bridge/.env`.
- **npm warns about install scripts.** The SDK and serialport ship prebuilt binaries; on my machine they load without the scripts running.

## Credits

- [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra) for the pulse and breathing signals. Proprietary; see its license.
- [TFT_eSPI](https://github.com/Bodmer/TFT_eSPI) by Bodmer, which does all the drawing on the display.
- [arduino-esp32](https://github.com/espressif/arduino-esp32) and [PlatformIO](https://platformio.org/) for the firmware toolchain.
- [node-serialport](https://serialport.io/) for the USB link.
- The [ESP32-Cheap-Yellow-Display](https://github.com/witnessmenow/ESP32-Cheap-Yellow-Display) community project by Brian Lough, the usual reference for this board's pin mapping.
