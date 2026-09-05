import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { LocationsService } from './locations.service.js';
import { WorkItemsService } from './work-items.service.js';

@Module({
  imports: [AccessModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, LocationsService, WorkItemsService],
  exports: [ProjectsService, LocationsService, WorkItemsService],
})
export class ProjectsModule {}
