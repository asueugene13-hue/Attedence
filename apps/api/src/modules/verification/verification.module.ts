import { Module } from '@nestjs/common';
import { VerificationController } from './verification.controller.js';
import { VerificationPolicyService } from './verification-policy.service.js';

@Module({
  controllers: [VerificationController],
  providers: [VerificationPolicyService],
  exports: [VerificationPolicyService],
})
export class VerificationModule {}
