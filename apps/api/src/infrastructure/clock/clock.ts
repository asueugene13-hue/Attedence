import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The server's idea of "now". Every time-based rule (class checkpoints, report windows, auto-end) asks
 * this instead of calling `new Date()`, so tests can replace it with a FakeClock and fast-forward a
 * whole teaching day in seconds. In production it is simply the system time.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock tests can set and move forward. */
export class FakeClock extends Clock {
  private current: Date;

  constructor(start: Date | string) {
    super();
    this.current = new Date(start);
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
