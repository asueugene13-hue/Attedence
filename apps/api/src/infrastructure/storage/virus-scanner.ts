import { connect } from 'node:net';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string } | { status: 'OFF' };

const CHUNK = 64 * 1024;
const TIMEOUT_MS = 30_000;

/**
 * Checks uploaded files with a ClamAV daemon (clamd) before they are stored (limitation 31). It speaks
 * clamd's INSTREAM protocol over TCP: the file goes in length-prefixed chunks, and clamd answers
 * "stream: OK" or "stream: <signature> FOUND". With no CLAMAV_HOST set, scanning is off and says so
 * at start-up. When scanning is on, a scanner that cannot be reached is an error, never a pass.
 */
@Injectable()
export class VirusScanner implements OnModuleInit {
  private readonly logger = new Logger(VirusScanner.name);

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (!this.config.virusScan && this.config.isProduction) {
      this.logger.warn('CLAMAV_HOST is not set: uploaded files are not scanned for viruses.');
    }
  }

  get enabled(): boolean {
    return this.config.virusScan !== null;
  }

  async scan(bytes: Buffer): Promise<ScanResult> {
    const target = this.config.virusScan;
    if (!target) return { status: 'OFF' };
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: target.host, port: target.port });
      const parts: Buffer[] = [];
      socket.setTimeout(TIMEOUT_MS, () =>
        socket.destroy(new Error('the virus scanner did not answer in time')),
      );
      socket.on('error', reject);
      socket.on('data', (d) => parts.push(d));
      socket.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const chunk = bytes.subarray(i, i + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4)); // a zero length ends the stream
      });
    });
    return parseReply(reply);
  }
}

/** clamd's answer, for example "stream: OK" or "stream: Eicar-Test-Signature FOUND" (NUL-terminated). */
export function parseReply(raw: string): ScanResult {
  const reply = raw.replace(/\0+$/, '').trim();
  if (reply === 'stream: OK') return { status: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'INFECTED', signature: found[1]! };
  throw new Error(`the virus scanner gave an unexpected answer: ${reply.slice(0, 200) || '(nothing)'}`);
}
