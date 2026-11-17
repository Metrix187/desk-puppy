// Live vitals from the webcam through the Presage SmartSpectra SDK.
//
// This module is only imported after the user has typed "yes" at the consent
// prompt (or for --list-cameras, which enumerates devices without opening one).
// Importing it loads the SDK's native runtime.

import { EventEmitter } from 'node:events';
import sdkPackage from '@smartspectra/node-sdk';
import { extractMetrics } from './metrics.js';

const {
  SmartSpectraSDK,
  CameraSelection,
  ValidationCode,
  ProcessingStatus,
  SmartSpectraErrorCode,
  SmartSpectraLogLevel,
  breathingMetrics,
  cardioMetrics,
  decodeMetrics,
} = sdkPackage;

const nameOf = (table, value) => Object.keys(table).find((k) => table[k] === value) ?? String(value);

/** Enumerates cameras. Does not open any of them and needs no API key. */
export function listCameras() {
  return SmartSpectraSDK.availableCameras();
}

export const sdkVersion = SmartSpectraSDK.version;

export class CameraSource extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.apiKey   never logged; scrubbed from any SDK message before it is shown
   * @param {string} options.cameraId an id from listCameras()
   * @param {boolean} [options.loose] also accept rates the SDK has not marked stable
   */
  constructor({ apiKey, cameraId, loose = false }) {
    super();
    this.#apiKey = apiKey;
    this.cameraId = cameraId;
    this.loose = loose;
    this.sdk = null;
    this.cursor = { traceT: -Infinity };
  }

  #apiKey;

  #scrub(text) {
    const s = String(text ?? '');
    return this.#apiKey ? s.split(this.#apiKey).join('[api key]') : s;
  }

  start() {
    const sdk = new SmartSpectraSDK({
      apiKey: this.#apiKey,
      requestedMetrics: [...breathingMetrics, ...cardioMetrics],
      enableTelemetry: false,
      logLevel: SmartSpectraLogLevel.kError,
    });
    this.sdk = sdk;

    sdk.on('processingStatus', (status) => {
      this.emit('status', nameOf(ProcessingStatus, status).replace(/^k/, '').toLowerCase());
    });

    sdk.on('validationStatus', (code, _timestampUs, hint) => {
      // kOk is the only code that means "a person is tracked and the signal is usable".
      this.emit('tracking', code === ValidationCode.kOk, this.#scrub(hint) || nameOf(ValidationCode, code));
    });

    sdk.on('metrics', (buf) => {
      let metrics;
      try {
        metrics = decodeMetrics(buf);
      } catch {
        return; // a malformed packet is not worth stopping for
      }
      if (Buffer.isBuffer(metrics)) return;
      const { trace, pulse, breathing } = extractMetrics(metrics, this.cursor, { loose: this.loose });
      for (const s of trace) this.emit('trace', s.v, Number.isFinite(s.t) ? s.t : undefined);
      if (pulse !== undefined || breathing !== undefined) this.emit('rates', { pulse, breathing });
    });

    sdk.on('error', (code, message, retryable) => {
      this.emit('sdk-error', {
        code,
        name: nameOf(SmartSpectraErrorCode, code),
        message: this.#scrub(message),
        retryable: !!retryable,
      });
    });

    try {
      // Windows does not report which way a camera faces, so pick it by id.
      sdk.useCamera(CameraSelection.byId(this.cameraId));
      sdk.start();
    } catch (err) {
      const wrapped = new Error(this.#scrub(err?.message));
      wrapped.name = nameOf(SmartSpectraErrorCode, err?.code);
      wrapped.code = err?.code;
      throw wrapped;
    }
  }

  async stop() {
    const sdk = this.sdk;
    this.sdk = null;
    if (!sdk) return;
    try {
      await sdk.stopAsync();
    } catch {
      // already stopped or never started
    }
    await sdk.destroy();
  }
}
