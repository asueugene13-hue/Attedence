import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { VirusScanner } from './virus-scanner.js';

@Global()
@Module({
  providers: [StorageService, VirusScanner],
  exports: [StorageService, VirusScanner],
})
export class StorageModule {}
