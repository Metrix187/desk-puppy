// The consent prompt shown before the camera is opened.
//
// The wording follows Presage's "SDK Telemetry & Privacy" page and the
// SmartSpectra docs as of SDK 3.5.0. If you change what the program does with
// data, change this text and the README section with it.

import { createInterface } from 'node:readline/promises';

export const PRIVACY_POLICY_URL = 'https://api.physiology.presagetech.com/privacypolicy';
export const TELEMETRY_DOC_URL = 'https://smartspectra.presagetech.com/docs/telemetry-and-privacy';

export function consentText(cameraName) {
  return `
Desk Puppy would like to use your camera.

  Camera  ${cameraName}
  Why     To estimate your pulse and breathing, so the puppy on the little
          display can react to them.

What happens to the video
  - Frames go from the camera straight into the Presage SmartSpectra SDK, which
    runs inside this program on this computer. Presage's documentation says all
    metric computation happens on-device.
  - This program never shows, saves or uploads video.

What leaves this computer
  - The SDK contacts Presage's servers to check the API key and subscription.
    It needs that to run, and this program cannot switch it off. Those requests
    can be linked to the account that owns the key.
  - The SDK's optional telemetry is switched off (enableTelemetry: false).
  - This program itself has no network code. The SDK is closed source, so the
    points above are what Presage documents, not something this program can prove.

What goes to the display board (over USB, about ten times a second)
  - Pulse rate, breathing rate, the puppy's mood (a number from 0 to 4) and a
    chest position from -100 to 100. The board keeps none of it.

What is kept
  - Nothing. No video, measurements or logs are written to disk. The numbers
    live in memory and on screen until you press Ctrl+C.

This is a toy. It is not a medical device, its numbers are not cleared for any
medical use, and it does not diagnose, treat or monitor anything. Point it only
at yourself, or at someone who is here, has read this and has agreed.

  Presage privacy policy   ${PRIVACY_POLICY_URL}
  SDK telemetry & privacy  ${TELEMETRY_DOC_URL}
`;
}

/** @returns {Promise<boolean>} true only if the user typed exactly "yes" */
export async function askConsent(cameraName, { input = process.stdin, output = process.stdout } = {}) {
  output.write(consentText(cameraName));
  const rl = createInterface({ input, output });
  try {
    const closed = new Promise((resolve) => rl.once('close', () => resolve('')));
    const answer = await Promise.race([
      rl.question('\nType "yes" to open the camera, or anything else to quit: '),
      closed,
    ]);
    return String(answer).trim().toLowerCase() === 'yes';
  } catch {
    return false; // Ctrl+C or closed input counts as "no"
  } finally {
    rl.close();
  }
}
