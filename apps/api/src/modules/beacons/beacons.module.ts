import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { ClassSessionsModule } from '../class-sessions/class-sessions.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { PlacesModule } from '../places/places.module.js';
import { BeaconsController } from './beacons.controller.js';
import { BeaconsService } from './beacons.service.js';

@Module({
  imports: [AcademicModule, PlacesModule, CoursesModule, ClassSessionsModule],
  controllers: [BeaconsController],
  providers: [BeaconsService],
  exports: [BeaconsService],
})
export class BeaconsModule {}
