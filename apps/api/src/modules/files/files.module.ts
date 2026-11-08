import { Module } from '@nestjs/common';
import { FilesService } from './files.service.js';

@Module({
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
