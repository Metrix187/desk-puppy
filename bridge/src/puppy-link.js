// Finds the display board on a serial port and keeps sending it lines.
//
// Discovery: open each port at 115200 baud, send "?" and wait for "PUPPY 1".
// Opening the port can reset an ESP32, so the probe keeps asking for a few
// seconds while the board boots.

import { BAUD_RATE, HELLO, HELLO_REPLY } from './protocol.js';

const OPEN_TIMEOUT_MS = 2500;
const HELLO_TIMEOUT_MS = 4000;
const RECONNECT_MS = 2000;

async function serialPortClass() {
  return (await import('serialport')).SerialPort;
}

export async function listPorts() {
  const SerialPort = await serialPortClass();
  const ports = await SerialPort.list();
  // The CYD's CH340 USB bridge is 1A86:7523; try those first.
  const isCh340 = (p) => (p.vendorId ?? '').toUpperCase() === '1A86';
  return ports.sort((a, b) => Number(isCh340(b)) - Number(isCh340(a)));
}

function open(SerialPort, path) {
  const port = new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false });
  port.on('error', () => {}); // surfaced through callbacks and 'close'
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      port.once('open', () => port.close(() => {}));
      reject(new Error(`timed out opening ${path}`));
    }, OPEN_TIMEOUT_MS);
    port.open((err) => {
      if (settled) return;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(port);
    });
  });
}

function sayHello(port) {
  return new Promise((resolve) => {
    let seen = '';
    const onData = (chunk) => {
      seen = (seen + chunk.toString('latin1')).slice(-256);
      if (seen.includes(HELLO_REPLY)) finish(true);
    };
    const ask = () => port.write(HELLO, () => {});
    const asking = setInterval(ask, 400);
    const timer = setTimeout(() => finish(false), HELLO_TIMEOUT_MS);
    function finish(ok) {
      clearInterval(asking);
      clearTimeout(timer);
      port.off('data', onData);
      resolve(ok);
    }
    port.on('data', onData);
    ask();
  });
}

const closePort = (port) => new Promise((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve()));

/**
 * @returns {Promise<{port, path, tried: {path:string, result:string}[]}>} port is null when no board answered
 */
export async function findPuppy({ only } = {}) {
  const SerialPort = await serialPortClass();
  const paths = only ? [only] : (await listPorts()).map((p) => p.path);
  const tried = [];
  for (const path of paths) {
    let port;
    try {
      port = await open(SerialPort, path);
    } catch (err) {
      tried.push({ path, result: `could not open (${err.message})` });
      continue;
    }
    if (await sayHello(port)) {
      port.on('data', () => {}); // the board only ever replies to "?"; discard it
      tried.push({ path, result: 'found' });
      return { port, path, tried };
    }
    await closePort(port);
    tried.push({ path, result: `opened, but nothing answered "${HELLO_REPLY}"` });
  }
  return { port: null, path: null, tried };
}

export class PuppyLink {
  /** @throws when no board is found */
  static async connect({ only, onEvent = () => {} } = {}) {
    const found = await findPuppy({ only });
    if (!found.port) {
      const detail = found.tried.length
        ? found.tried.map((t) => `  ${t.path}: ${t.result}`).join('\n')
        : '  no serial ports found';
      const err = new Error(`Could not find the Desk Puppy board.\n${detail}`);
      err.tried = found.tried;
      throw err;
    }
    return new PuppyLink(found.port, found.path, only, onEvent);
  }

  constructor(port, path, only, onEvent) {
    this.port = port;
    this.path = path;
    this.only = only;
    this.onEvent = onEvent;
    this.closing = false;
    this.retry = null;
    this.#watch(port);
  }

  get connected() {
    return !!this.port?.isOpen;
  }

  #watch(port) {
    port.once('close', () => {
      if (this.closing || this.port !== port) return;
      this.port = null;
      this.onEvent('lost', this.path);
      this.#reconnect();
    });
  }

  #reconnect() {
    if (this.closing || this.retry) return;
    this.retry = setTimeout(async () => {
      this.retry = null;
      if (this.closing) return;
      const found = await findPuppy({ only: this.only }).catch(() => ({ port: null }));
      if (this.closing) {
        if (found.port) await closePort(found.port);
        return;
      }
      if (found.port) {
        this.port = found.port;
        this.path = found.path;
        this.#watch(found.port);
        this.onEvent('found', this.path);
      } else {
        this.#reconnect();
      }
    }, RECONNECT_MS);
  }

  /** Sends one line. Lines are dropped rather than queued if the port is backed up. */
  send(line) {
    const port = this.port;
    if (!port?.isOpen || port.writableLength > 512) return false;
    port.write(line, () => {});
    return true;
  }

  async close() {
    this.closing = true;
    clearTimeout(this.retry);
    const port = this.port;
    this.port = null;
    if (!port) return;
    await new Promise((resolve) => port.drain(() => resolve()));
    await closePort(port);
  }
}
