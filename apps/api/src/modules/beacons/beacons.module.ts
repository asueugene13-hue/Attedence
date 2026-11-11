import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { PlacesModule } from '../places/places.module.js';
import { BeaconsController } from './beacons.controller.js';
import { BeaconsService } from './beacons.service.js';

@Module({
  imports: [AcademicModule, PlacesModule],
  controllers: [BeaconsController],
  providers: [BeaconsService],
  exports: [BeaconsService],
})
export class BeaconsModule {}
