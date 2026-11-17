---
title: Desk Puppy, a pixel dog that wags to my heartbeat
published: false
tags: devchallenge, presagechallenge, esp32, node
---

<!--
DRAFT. Things to fill in before publishing are marked TODO.
Every claim below about live mode should be checked against what you actually
see on your desk once you have run it with the camera. Cut anything that did
not hold up.
-->

*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

## What I Built

Desk Puppy is a small pixel dog that lives on an ESP32 "Cheap Yellow Display" next to my monitor and reacts to my pulse and breathing.

My PC's built-in webcam is the only sensor. The Presage SmartSpectra SDK reads my pulse rate, breathing rate and a chest movement trace from the video, and a small Node program sends four numbers over USB to the display about ten times a second. The puppy turns them into behaviour:

- Its tail wags once per heartbeat.
- Its chest rises and falls with my actual breathing trace, not a canned animation.
- When my breathing slows down and my pulse is at its usual level, it closes its eyes and dozes.
- When my pulse is well above my usual level, it gets the zoomies.
- When I hold my breath, after about eight seconds it starts pawing at the glass and tells me to breathe.
- When I walk away, it looks around for me.

I wanted to see what these signals feel like when they are not on a dashboard. A number that says 72 is information. A tail that keeps time with you is something else.

<!-- TODO: one or two sentences in your own words about what it was like once it was running on your desk. -->


It is a toy. It does not diagnose, treat or monitor anything, and I would not trust it with a health decision.

## Demo

<!-- TODO: embed the demo video here, e.g. {% embed https://www.youtube.com/watch?v=... %} -->

<!-- TODO: one photo of the display on the desk, with alt text. -->

What the video shows, in order:

1. Starting the bridge, the consent prompt, and typing `yes`.
2. The puppy waking up when it finds me; tail and chest following my pulse and breathing.
3. Holding my breath until it paws at the glass.
4. Slow breathing until it falls asleep.
5. <!-- TODO: whatever you did to get your pulse up --> and the zoomies.
6. Walking out of frame.

If you want to try it without a camera or an API key, `npm run fake` replays a scripted sequence (calm, held breath, excited, sleepy) through the same logic, and `npm run fake -- --dry-run` does it without the board.

## Code

<!-- TODO: {% embed https://github.com/YOUR_USERNAME/desk-puppy %} -->

Two small programs:

- `firmware/` is a PlatformIO project for the display. It draws the puppy into a sprite with [TFT_eSPI](https://github.com/Bodmer/TFT_eSPI) and parses one line of text per update.
- `bridge/` is a Node 24 program for the PC. It runs the SmartSpectra SDK, detects breath holds, decides the puppy's mood and writes to the serial port.

The whole interface between them is one line:

```
V,<pulse bpm>,<breaths per min>,<state>,<chest -100..100>
```

Setup instructions, the parts list and the flashing steps are in the README.

## How It Responds to Human Signals

The bridge asks the SDK for breathing and cardio metrics and uses three of them: `cardio.pulseRate`, `breathing.rate` and `breathing.upperTrace` (the chest trace).

```js
const sdk = new SmartSpectraSDK({
  apiKey,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
  enableTelemetry: false,
});
sdk.on('metrics', (buf) => {
  const m = decodeMetrics(buf);
  const pulse = m.cardio?.pulseRate?.at(-1)?.value;
  const breathing = m.breathing?.rate?.at(-1)?.value;
  const chest = m.breathing?.upperTrace?.at(-1)?.value;
  // ...
});
sdk.useCamera(CameraSelection.byId(camera.id));
sdk.start();
```

**Pulse to tail.** The firmware advances the wag by one full swing per beat, so the tail is a metronome for my heart rate.

**Chest trace to chest.** The trace arrives in arbitrary units. The bridge centres it, scales it by the size of my recent breaths, and sends a value from -100 to 100. The scale adapts slowly on purpose, so a held breath looks flat instead of having noise stretched to full height.

**Breath holds.** The SDK lists an apnea metric but marks it unavailable, so I wrote a detector. It learns how far the chest trace normally swings while I breathe, and reports a hold when the last eight seconds swing less than a quarter of that while the SDK still says it can see me. It lets go as soon as a real breath shows up.

**Moods.** The rules are short:

| Mood | When |
| --- | --- |
| searching | no valid signal |
| breath held | the detector above |
| excited | pulse more than 15 bpm above my session baseline |
| sleepy | breathing under 10 a minute and pulse near baseline |
| awake | otherwise |

The baseline is the median of my pulse over the first 30 seconds of the session. To keep the puppy from flickering between moods at a threshold, each mood is harder to leave than to enter and has to persist for a couple of seconds before it shows.

The SDK also reports why it cannot measure (too dark, face not centred, too far). The bridge only treats the signal as valid when that status is OK, and by default it only uses rates the SDK has marked stable. When it is not sure, the puppy shows `--` rather than a guess.

<!-- TODO: add one or two honest observations from real use. How long did rates take to appear? Did the hold detector need tuning? Did anything not work? -->

## Prize Categories

Most Creative or Delightful Use.

## Consent and Data Handling

**Consent.** Before the camera opens, the bridge prints what the camera is for, what leaves the machine and what is kept, and waits for me to type `yes`. Anything else exits with the camera untouched, and there is no flag to skip it. It is meant for the person sitting in front of it. It is not for watching someone who does not know.

**Video.** Frames go from the camera straight into the SDK inside the bridge process. The bridge never shows, saves or uploads video. Presage's documentation says all metric computation happens on-device.

**What leaves the machine.** The SDK contacts Presage's servers to authenticate the API key and validate the subscription. That is required, and those requests can be associated with my Presage account. I set `enableTelemetry: false`; Presage's [telemetry page](https://smartspectra.presagetech.com/docs/telemetry-and-privacy) says that with telemetry disabled the SDK starts no telemetry session and transmits nothing for it. I do not use LLM Insights or device readiness reports. The bridge has no network code of its own. The SDK runtime is closed source, so this paragraph is what Presage documents rather than something I verified on the wire.

**Storage, retention, deletion.** Nothing is written to disk: no video, no measurements, no logs. The numbers exist in memory and on screen until I press Ctrl+C. The display board receives pulse, breathing rate, a mood number and a chest position over USB and keeps none of it. There is nothing to delete because nothing is retained.

**Sharing and AI services.** None. No third-party services, no analytics, no AI service at runtime.

**Not medical.** Desk Puppy makes no diagnosis or treatment claims. "Sleepy" and "excited" are a cartoon dog's moods, driven by simple thresholds. Presage describes SDK metrics as being for general wellness and informational purposes only, not cleared by the FDA, and not for medical diagnosis or treatment.

## Agent Session

<!--
TODO: this section is optional in the template. Decide whether to keep it.
If you keep it, embed the session with {% agent_session <id_or_slug> %} after
checking the transcript for keys or anything private. Note that DEV's AI
guidelines ask for AI assistance to be disclosed somewhere in the post, so if
you cut this section, say it another way.
-->

I built this with Claude Code as a coding agent. I came in with the idea, the hardware, the serial protocol and a first draft of the firmware. The agent got the firmware building in an isolated PlatformIO install, backed up and flashed the board, read the SmartSpectra docs and the SDK's type declarations, and wrote the bridge, the breath-hold detector, the mood logic and their tests. I did the parts that need a person in the room: checking the screen, sitting in front of the camera, and deciding when the puppy felt right.

<!-- TODO: add what you changed or tuned yourself after trying it live. -->
