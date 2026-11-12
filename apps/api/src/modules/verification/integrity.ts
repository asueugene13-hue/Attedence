import { Injectable } from '@nestjs/common';
import type { IntegrityResult } from '@attendsure/shared';

/**
 * Platform integrity (PRESENCE_VERIFICATION.md §5): Play Integrity on Android, App Attest on iPhone.
 * One interface, so the real checks can be switched on when the university's Google Play Console and
 * Apple Developer accounts exist, without touching the decision engine.
 */
export abstract class IntegrityVerifier {
  /** `token` is what the phone's platform produced for this request, if anything. */
  abstract verify(input: { platform: 'ANDROID' | 'IOS'; token: string | null }): Promise<IntegrityResult>;
}

/**
 * Used until the accounts exist: reports NOT_AVAILABLE, which the decision table never counts
 * against a student (§6).
 */
@Injectable()
export class NotAvailableIntegrityVerifier extends IntegrityVerifier {
  verify(): Promise<IntegrityResult> {
    return Promise.resolve('NOT_AVAILABLE');
  }
}
