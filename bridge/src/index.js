#!/usr/bin/env node
// Desk Puppy bridge: webcam -> SmartSpectra SDK -> USB serial -> puppy.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pipeline } from './pipeline.js';
import { PuppyLink, listPorts } from './puppy-link.js';
import { STATE_NAMES } from './protocol.js';
import { askConsent } from './consent.js';

const HELP = `Desk Puppy bridge

  npm start                  live mode: webcam + SmartSpectra SDK (asks for consent first)
  npm run fake               no camera, no API key: replays a scripted sequence
  npm run fake -- --dry-run  the same, without a board attached

Options
  --port <name>      serial port of the board (default: find it by asking each port)
  --camera <n|id>    camera to use, by number or id from --list-cameras (default: the first)
  --list-cameras     list cameras and exit (does not open any camera)
  --list-ports       list serial ports and exit
  --invert           flip the board's colour inversion (it remembers), then exit
  --dry-run         do not use a board; just show what would be sent
  --loose            also use readings the SDK has not marked as stable
  --debug            print one diagnostic line a second (what the SDK is sending, and
                     the line going to the board); terminal only, nothing is saved
  --calibrate        guided two-minute run that tells you when to breathe and when
                     to hold, and prints how the chest trace behaved in each
                     phase (for tuning the hold detector; terminal only)
  --seconds <n>      stop by itself after n seconds
  --help
`;

const TICK_MS = 100; // about ten lines per second

function parse() {
  try {
    return parseArgs({
      options: {
        fake: { type: 'boolean', default: false },
        port: { type: 'string' },
        camera: { type: 'string' },
        'list-cameras': { type: 'boolean', default: false },
        'list-ports': { type: 'boolean', default: false },
        invert: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        loose: { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        seconds: { type: 'string' },
        calibrate: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
}

/** Reads SMARTSPECTRA_API_KEY from the environment or bridge/.env. Never prints it. */
function loadApiKey() {
  if (!process.env.SMARTSPECTRA_API_KEY) {
    const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    try {
      process.loadEnvFile(envFile);
    } catch {
      // no .env file; handled below
    }
  }
  return (process.env.SMARTSPECTRA_API_KEY ?? '').trim();
}

function pickCamera(cameras, wanted) {
  if (wanted === undefined) return cameras[0];
  if (/^\d+$/.test(wanted) && Number(wanted) >= 1 && Number(wanted) <= cameras.length) {
    return cameras[Number(wanted) - 1];
  }
  return cameras.find((c) => c.id === wanted);
}

const cameraLabel = (c) => c.name ?? 'unnamed camera';

function statusLine(out, extra) {
  // While searching there are no numbers to show, so the reason goes first
  // where a narrow terminal will not cut it off.
  if (out.state === 0) return [STATE_NAMES[0], extra].filter(Boolean).join(': ');
  const num = (v, digits, unit) => (Number.isFinite(v) ? `${v.toFixed(digits)} ${unit}` : `-- ${unit}`);
  return [
    STATE_NAMES[out.state].padEnd(11),
    `pulse ${num(out.pulse, 0, 'bpm')}`.padEnd(14),
    `breathing ${num(out.breathing, 1, '/min')}`.padEnd(20),
    `chest ${Number.isFinite(out.chest) ? out.chest.toFixed(0).padStart(4) : '  --'}`,
    extra,
  ]
    .filter(Boolean)
    .join('  ');
}

async function main() {
  const args = parse();
  if (args.help) return void console.log(HELP);

  if (args['list-ports']) {
    const ports = await listPorts();
    if (!ports.length) console.log('No serial ports found.');
    for (const p of ports) console.log(`${p.path}  ${p.vendorId ?? '----'}:${p.productId ?? '----'}  ${p.manufacturer ?? ''}`);
    return;
  }

  if (args.invert) {
    const link = await PuppyLink.connect({ only: args.port });
    link.send('I\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await link.close();
    console.log(`Flipped colour inversion on ${link.path}. Run it again to flip back.`);
    return;
  }

  if (args['list-cameras']) {
    const { listCameras } = await import('./camera-source.js');
    const cameras = listCameras();
    if (!cameras.length) console.log('No cameras found.');
    cameras.forEach((c, i) => console.log(`${i + 1}. ${cameraLabel(c)}\n   id: ${c.id}`));
    return;
  }

  let source;
  let hint = '';

  if (args.fake) {
    console.log('FAKE MODE. The camera is not used and no API key is needed.');
    console.log('The numbers below are a scripted sequence, not measurements of anyone.\n');
    const { FakeSource } = await import('./fake-source.js');
    source = new FakeSource();
    source.on('phase', (name) => {
      hint = `script: ${name}`;
    });
  } else {
    const apiKey = loadApiKey();
    if (!apiKey) {
      console.error(
        'No API key found. Put SMARTSPECTRA_API_KEY=... in bridge/.env (see .env.example),\n' +
          'or run "npm run set-key" on Windows. To try the puppy without a key: npm run fake',
      );
      process.exit(1);
    }

    // Enumerating cameras does not open one; the camera stays off until "yes".
    const { listCameras, CameraSource, sdkVersion } = await import('./camera-source.js');
    const cameras = listCameras();
    if (!cameras.length) {
      console.error('No camera found.');
      process.exit(1);
    }
    const camera = pickCamera(cameras, args.camera);
    if (!camera) {
      console.error(`No camera matches "${args.camera}". Try --list-cameras.`);
      process.exit(1);
    }
    if (cameras.length > 1 && args.camera === undefined) {
      console.log(`Found ${cameras.length} cameras; using the first. Choose another with --camera <n>:`);
      cameras.forEach((c, i) => console.log(`  ${i + 1}. ${cameraLabel(c)}`));
    }

    if (!(await askConsent(cameraLabel(camera)))) {
      console.log('\nNo consent given. The camera was not opened. Bye.');
      return;
    }
    console.log(`\nSmartSpectra SDK ${sdkVersion}`);
    source = new CameraSource({ apiKey, cameraId: camera.id, loose: args.loose });
  }

  let link = null;
  if (args['dry-run']) {
    console.log('Dry run: no board is used.');
  } else {
    console.log(args.port ? `Opening ${args.port}...` : 'Looking for the Desk Puppy board...');
    try {
      link = await PuppyLink.connect({
        only: args.port,
        onEvent: (what, where) => console.log(what === 'lost' ? `\nBoard on ${where} disconnected; looking for it...` : `\nBoard back on ${where}.`),
      });
    } catch (err) {
      console.error(`${err.message}\nIs the board plugged in, and is no serial monitor holding the port?`);
      if (!args.fake) console.error('The camera was not opened.');
      process.exit(1);
    }
    console.log(`Board found on ${link.path}.`);
  }

  const pipeline = new Pipeline();
  const now = () => performance.now() / 1000;
  let fatal = null;

  let calibration = null;
  if (args.calibrate) {
    const { Calibration } = await import('./calibrate.js');
    calibration = new Calibration();
  }

  source.on('trace', (raw, sampleT) => {
    const t = now();
    pipeline.onTrace(t, raw, sampleT);
    calibration?.onTrace(sampleT ?? t, raw);
  });
  source.on('rates', (rates) => pipeline.onRates(now(), rates));
  // What the SDK last told us, for the status line and --debug.
  const seen = { present: true, advice: '', check: 'none yet', sdk: 'starting', anyData: false };
  const second = { packets: 0, newTrace: 0, last: null };

  source.on('tracking', (present, advice, checkName, signalOk) => {
    pipeline.onTracking(now(), present, signalOk);
    if (args.fake) return;
    Object.assign(seen, { present, advice, check: checkName ?? seen.check });
  });
  source.on('status', (status) => {
    seen.sdk = status;
  });
  source.on('packet', (p) => {
    second.packets++;
    second.newTrace += p.newTrace;
    // Rates come in the odd packet, not every one: keep the best seen this second.
    const prev = second.last;
    second.last = prev
      ? {
          ...p,
          upper: Math.max(prev.upper, p.upper),
          lower: Math.max(prev.lower, p.lower),
          rate: Math.max(prev.rate, p.rate),
          rateStable: prev.rateStable || (p.rate > 0 && p.rateStable),
          pulse: Math.max(prev.pulse, p.pulse),
          pulseStable: prev.pulseStable || (p.pulse > 0 && p.pulseStable),
        }
      : p;
    if (p.upper || p.lower || p.rate || p.pulse) {
      seen.anyData = true;
      pipeline.onData(now());
    }
  });

  const liveHint = (searching) => {
    if (!seen.present) return seen.advice || 'nobody in view';
    if (!seen.anyData) return [`waiting for the SDK (${seen.sdk})`, seen.advice].filter(Boolean).join(', ');
    if (searching) return seen.advice || 'the SDK has stopped sending data';
    return seen.advice;
  };

  const debugLine = (out) => {
    const p = second.last;
    const flag = (n, stable) => (n ? `${n}(${stable ? 'stable' : 'not stable'})` : '0');
    const shape = p
      ? `packets=${second.packets} newTrace=${second.newTrace} upper=${p.upper} lower=${p.lower} rate=${flag(p.rate, p.rateStable)} pulse=${flag(p.pulse, p.pulseStable)}`
      : 'packets=0';
    second.packets = 0;
    second.newTrace = 0;
    second.last = null;
    // swing = how much the smoothed chest trace moved in the last 8 s, as a
    // fraction of what is normal for this session. A hold is declared when it
    // stays below 0.40.
    const d = pipeline.detector;
    const swing = d.reference === null ? `learning ${d.amps.length}/${d.o.minAmpReadings}` : d.ratio === null ? 'n/a' : d.ratio.toFixed(2);
    return `[debug] sdk=${seen.sdk} check=${seen.check}${seen.advice ? ` "${seen.advice}"` : ''} ${shape} swing=${swing} hold=${d.holding ? 'yes' : 'no'} | ${STATE_NAMES[out.state]} ${out.line.trim()}`;
  };
  source.on('sdk-error', (e) => {
    console.error(`\nSmartSpectra error: ${e.name} - ${e.message}`);
    if (e.name === 'kAuthenticationFailed') console.error('Check SMARTSPECTRA_API_KEY in bridge/.env.');
    if (e.name === 'kCreditExhausted') console.error('The Presage account has run out of credit.');
    if (!e.retryable) fatal = e;
  });

  try {
    source.start();
  } catch (err) {
    console.error(`Could not start: ${err.name} - ${err.message}`);
    await link?.close();
    process.exit(1);
  }
  if (!args.fake) console.log('Camera is on. Sit facing it in good light, about an arm\'s length away.');
  console.log('Press Ctrl+C to stop.\n');

  const tty = process.stdout.isTTY;
  let lastState = -1;
  let lastPrint = 0;
  const timer = setInterval(() => {
    const t = now();
    const out = pipeline.tick(t);
    link?.send(out.line);
    if (fatal) return void shutdown(1);
    if (calibration) {
      if (calibration.tick()) shutdown(0);
      return;
    }
    if (!args.fake) hint = liveHint(out.state === 0);
    const extra = [hint, link && !link.connected ? 'board disconnected' : ''].filter(Boolean).join(' | ');
    if (args.debug) {
      if (t - lastPrint >= 1) {
        lastPrint = t;
        console.log(args.fake ? `[debug] ${hint} | ${STATE_NAMES[out.state]} ${out.line.trim()}` : debugLine(out));
      }
    } else if (tty) {
      if (t - lastPrint >= 0.2) {
        lastPrint = t;
        process.stdout.write(`\r${statusLine(out, extra)}`.padEnd(process.stdout.columns - 1).slice(0, process.stdout.columns));
      }
    } else if (out.state !== lastState || t - lastPrint >= 5) {
      lastPrint = t;
      console.log(statusLine(out, extra));
    }
    lastState = out.state;
  }, TICK_MS);

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log('\nStopping...');
    try {
      await source.stop(); // releases the camera
    } catch {
      // nothing useful to do; we are exiting anyway
    }
    await link?.close();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (Number(args.seconds) > 0) setTimeout(() => shutdown(0), Number(args.seconds) * 1000);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
